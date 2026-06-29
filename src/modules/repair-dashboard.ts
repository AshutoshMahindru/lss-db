import { THROTTLE_MS } from '../config';
import { isDbGraph } from '../core/db-properties';
import { blockId, getBlocks, getPage, updateBlockContent, walkBlocks } from '../core/editor';
import { safePageName } from '../core/names';
import { formatError, sleep } from '../core/runner';
import type { Result } from '../core/types';
import { dashboardPageForObjectType, propertySpec, templateDefByObjectType } from '../registry';
import { markRepairCooldown } from './auto-repair';
import {
  configureDbAdvancedQueryBlock,
  dashboardQueryBlockForViewAsync,
  dbAdvancedQueryBlockNeedsStructureRepair,
  expandBlockUi,
  filterProps,
  inspectDbQueryBlockStructure,
  isQueryLikeBlockAsync,
  isManagedPageSectionHeading,
  moveBlockAsChildViaHost,
  pageSectionHeadingForView,
  pickCanonicalQueryBlock,
  queryTitleForView,
  queryBlockNeedsRepair,
  readDashboardQueryBlockContent,
  repairDbQueryBlockUiKeywords,
  resolveQueryClassTagId,
  sectionNameFromLine,
  sourceTagsForView,
  sourceTagsFromQueryContent,
  viewDefinitionsSafe,
} from './queries';
import { forceCreateQueryChild } from './advanced-query-blocks';

type InferObjectType = (pageName: string, blocks: any[]) => string | null;
type RepairParentRefs = (value: string) => string[];
type ResolveVisibleNodeToken = (result: Result, token: string) => Promise<string>;
export type DashboardRepairOptions = {
  maxViews?: number;
  pageSectionHeadings?: string[];
  aggregatePageSectionHeadings?: string[];
};

type DashboardView = ReturnType<typeof viewDefinitionsSafe>[number];

function findSectionBlocks(blocks: any[]): Map<string, any> {
  const map = new Map<string, any>();
  for (const block of walkBlocks(blocks)) {
    const section = sectionNameFromLine(block?.content);
    if (section && !map.has(section)) map.set(section, block);
  }
  return map;
}

function isPlaceholderPageRef(name: string): boolean {
  const raw = String(name ?? '').trim();
  const safe = safePageName(raw);
  return /^LSS Placeholder(?:\/| - )/i.test(raw) || /^LSS Placeholder(?:\/| - )/i.test(safe);
}

async function removeDashboardQueryBlock(
  result: Result,
  block: any,
  label: string,
): Promise<boolean> {
  const id = blockId(block);
  if (!id || !logseq.Editor.removeBlock) return false;
  try {
    await logseq.Editor.removeBlock(id);
    result.actions.push(`REMOVE duplicate dashboard query block (${label})`);
    await sleep(50);
    return true;
  } catch (error) {
    result.errors.push(`remove duplicate query block: ${formatError(error)}`);
    return false;
  }
}

function normalizedQueryTitle(value: string): string {
  return String(value ?? '')
    .replace(/#Query\b/gi, '')
    .replace(/#Template\b/gi, '')
    .replace(/^[-*]\s+/, '')
    .trim()
    .toLowerCase()
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ');
}

function normalizedHeading(value: string): string {
  return normalizedQueryTitle(value);
}

function viewMatchesPageSectionHeading(view: DashboardView, headings: Set<string>): boolean {
  if (!headings.size) return true;
  return headings.has(normalizedHeading(pageSectionHeadingForView(view)));
}

function aggregateViewLabel(heading: string): string {
  const key = normalizedHeading(heading);
  if (key === 'forms') return 'Forms';
  if (key === 'reviews') return 'Reviews';
  if (key === 'dates') return 'Dates';
  if (key === 'related entities') return 'Related entities';
  if (key === 'generic entities') return 'Generic entities';
  return heading
    .toLowerCase()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function aggregatePageSectionViews(views: DashboardView[], headings: Set<string>): DashboardView[] {
  if (!headings.size) return views;
  const groups = new Map<string, { heading: string; views: DashboardView[] }>();
  const passthrough: DashboardView[] = [];
  for (const view of views) {
    const heading = pageSectionHeadingForView(view);
    const key = normalizedHeading(heading);
    if (!headings.has(key)) {
      passthrough.push(view);
      continue;
    }
    const group = groups.get(key) ?? { heading, views: [] };
    group.views.push(view);
    groups.set(key, group);
  }
  const aggregated: DashboardView[] = [];
  for (const [key, group] of groups) {
    const sourceTags = [...new Set(group.views.flatMap((view) => sourceTagsForView(view)))];
    const filterProps = [...new Set(group.views.flatMap((view) => (view.filters ?? []).flatMap(filterProps)))];
    if (!sourceTags.length || !filterProps.length) continue;
    const label = aggregateViewLabel(group.heading);
    aggregated.push({
      id: `LSS-MATERIALISE-${key.replace(/[^a-z0-9]+/g, '-').toUpperCase()}`,
      queryTitle: label,
      title: label,
      section: label,
      sourceTags,
      filters: [{ propertyAny: filterProps, operator: 'includesCurrentPage' }],
      viewType: 'table',
      nativeQueryStatus: 'template-query-block',
      exportPolicy: 'inherit',
      queryIntent: `Aggregate ${label.toLowerCase()} related to current page`,
    });
  }
  return [...passthrough, ...aggregated];
}

function blockTitle(block: any): string {
  return String(block?.content ?? block?.title ?? '')
    .split(/\r?\n/)[0]
    .replace(/^[-*]\s+/, '')
    .trim();
}

function titleMatchesView(block: any, queryTitle: string, section: string): boolean {
  const actual = normalizedQueryTitle(blockTitle(block));
  return Boolean(actual) && [queryTitle, section].some((label) => actual === normalizedQueryTitle(label));
}

function queryTitleFromEdnContent(content: string): string | null {
  const text = String(content ?? '').trim();
  if (!text) return null;
  const quoted = text.match(/:title\s+"((?:\\"|[^"])*)"/i);
  if (quoted?.[1]) return quoted[1].replace(/\\"/g, '"').trim() || null;
  const bare = text.match(/:title\s+([^\s}]+)/i);
  return bare?.[1]?.trim() || null;
}

async function effectiveQueryBlockTitle(block: any): Promise<string> {
  const direct = blockTitle(block);
  if (direct) return direct;
  if (!(await isQueryLikeBlockAsync(block))) return '';
  const content = await readDashboardQueryBlockContent(block);
  return queryTitleFromEdnContent(content) ?? '';
}

async function titleMatchesViewAsync(block: any, queryTitle: string, section: string): Promise<boolean> {
  const actual = normalizedQueryTitle(await effectiveQueryBlockTitle(block));
  return Boolean(actual) && [queryTitle, section].some((label) => actual === normalizedQueryTitle(label));
}

async function titleMatchesAnyViewAsync(block: any, views: ReturnType<typeof viewDefinitionsSafe>): Promise<boolean> {
  for (const view of views) {
    if (await titleMatchesViewAsync(block, queryTitleForView(view), String(view.section ?? '').trim())) {
      return true;
    }
  }
  return false;
}

function currentViewSourceTagSet(views: ReturnType<typeof viewDefinitionsSafe>): Set<string> {
  const tags = new Set<string>();
  for (const view of views) for (const tag of sourceTagsForView(view)) tags.add(tag);
  return tags;
}

function hasKnownCurrentSourceTag(content: string, currentSources: Set<string>): boolean {
  return sourceTagsFromQueryContent(content).some((tag) => currentSources.has(tag));
}

async function queryBlockUsesCurrentSource(block: any, currentSources: Set<string>): Promise<boolean> {
  const content = await readDashboardQueryBlockContent(block);
  return hasKnownCurrentSourceTag(content, currentSources);
}

async function managedQueryTitleCandidate(block: any): Promise<boolean> {
  if (await isQueryLikeBlockAsync(block)) return true;
  return canRemoveSectionWrapper(block);
}

function dedupeBlocks(blocks: any[]): any[] {
  const seen = new Set<string>();
  const out: any[] = [];
  for (const block of blocks) {
    const id = blockId(block);
    const key = id ? String(id) : JSON.stringify(block);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(block);
  }
  return out;
}

type ManagedHeadingBlock = { block: any; heading: string | null };

function walkBlocksWithManagedHeading(blocks: any[], heading: string | null = null): ManagedHeadingBlock[] {
  const out: ManagedHeadingBlock[] = [];
  for (const block of blocks ?? []) {
    const title = blockTitle(block);
    const nextHeading = isManagedPageSectionHeading(title) ? title : heading;
    out.push({ block, heading });
    out.push(...walkBlocksWithManagedHeading(block?.children ?? [], nextHeading));
  }
  return out;
}

function dedupeBlockEntries(entries: ManagedHeadingBlock[]): ManagedHeadingBlock[] {
  const seen = new Set<string>();
  const out: ManagedHeadingBlock[] = [];
  for (const entry of entries) {
    const id = blockId(entry.block);
    const key = id ? String(id) : JSON.stringify(entry.block);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

async function queryCandidateUnderHeading(
  blocks: any[],
  queryTitle: string,
  section: string,
  heading: string,
): Promise<boolean> {
  const headingKey = normalizedQueryTitle(heading);
  for (const entry of walkBlocksWithManagedHeading(blocks)) {
    if (normalizedQueryTitle(entry.heading ?? '') !== headingKey) continue;
    const queryLike = await isQueryLikeBlockAsync(entry.block);
    if (!queryLike && !(await managedQueryTitleCandidate(entry.block))) continue;
    if (await titleMatchesViewAsync(entry.block, queryTitle, section)) return true;
  }
  return false;
}

function queryCandidatesUnderHeading(blocks: any[], candidates: any[], heading: string): any[] {
  const candidateIds = new Set(candidates.map((candidate) => blockId(candidate)).filter(Boolean).map(String));
  const headingKey = normalizedQueryTitle(heading);
  const preferred: any[] = [];
  for (const entry of walkBlocksWithManagedHeading(blocks)) {
    const id = blockId(entry.block);
    if (!id || !candidateIds.has(String(id))) continue;
    if (normalizedQueryTitle(entry.heading ?? '') === headingKey) preferred.push(entry.block);
  }
  return preferred;
}

function queryCandidateIsUnderHeading(blocks: any[], candidate: any, heading: string): boolean {
  return queryCandidatesUnderHeading(blocks, [candidate], heading).length > 0;
}

function anyQueryLikeChildSnapshot(block: any): boolean {
  return (block?.children ?? []).some((child: any) => {
    const content = String(child?.content ?? child?.title ?? '').trim();
    return /#Query\b|:query\b|<% current page %>|\{\s*:title\b/i.test(content) || anyQueryLikeChildSnapshot(child);
  });
}

async function rootQueryCandidates(
  blocks: any[],
  queryTitle: string,
  section: string,
  queryContent: string,
): Promise<any[]> {
  const out: any[] = [];
  for (const block of walkBlocks(blocks ?? [])) {
    const queryLike = await isQueryLikeBlockAsync(block);
    if (!queryLike && (await titleMatchesViewAsync(block, queryTitle, section)) && (await managedQueryTitleCandidate(block))) {
      out.push(block);
      continue;
    }
    if (!queryLike) continue;
    if (await titleMatchesViewAsync(block, queryTitle, section)) {
      out.push(block);
      continue;
    }
    const content = await readDashboardQueryBlockContent(block);
    if (!queryBlockNeedsRepair(content, queryContent)) out.push(block);
  }
  return dedupeBlocks(out);
}

async function canRemoveManagedHeadingBlock(block: any): Promise<boolean> {
  for (const child of block?.children ?? []) {
    if (await isQueryLikeBlockAsync(child)) continue;
    if (isEmptyPlaceholder(child)) continue;
    return false;
  }
  return true;
}

async function removeDuplicateManagedHeadingBlocks(
  result: Result,
  rootBlocks: any[],
  objectType: string,
): Promise<number> {
  if (!logseq.Editor.removeBlock) return 0;
  const groups = new Map<string, any[]>();
  for (const block of rootBlocks ?? []) {
    const title = blockTitle(block);
    if (!isManagedPageSectionHeading(title)) continue;
    const key = normalizedQueryTitle(title);
    const items = groups.get(key) ?? [];
    items.push(block);
    groups.set(key, items);
  }

  let removed = 0;
  for (const [key, blocks] of groups) {
    if (blocks.length <= 1) continue;
    let keep = blocks.find((block) => anyQueryLikeChildSnapshot(block)) ?? null;
    if (!keep) {
      for (const block of blocks) {
        if (!(await canRemoveManagedHeadingBlock(block))) {
          keep = block;
          break;
        }
      }
    }
    keep ??= blocks[0];
    const keepId = blockId(keep);
    for (const block of blocks) {
      if (blockId(block) === keepId) continue;
      if (!(await canRemoveManagedHeadingBlock(block))) {
        result.notes.push(`Kept duplicate ${blockTitle(block)} heading on ${objectType} because it contains non-query content.`);
        continue;
      }
      if (await removeDashboardQueryBlock(result, block, `${objectType} duplicate heading ${key}`)) removed++;
    }
  }
  return removed;
}

function findRootHeadingBlock(blocks: any[], heading: string): any | null {
  const target = normalizedQueryTitle(heading);
  return (blocks ?? []).find((block) => normalizedQueryTitle(blockTitle(block)) === target) ?? null;
}

async function ensureRootHeadingBlock(
  result: Result,
  blocks: any[],
  pageName: string,
  pageRootId: string | null,
  heading: string,
  objectType: string,
): Promise<string | null> {
  const existing = findRootHeadingBlock(blocks, heading);
  const existingId = blockId(existing);
  if (existingId) {
    await expandBlockUi(existingId);
    return existingId;
  }
  if (!logseq.Editor.insertBlock && !logseq.Editor.appendBlockInPage) return null;
  try {
    let inserted: any = null;
    if (pageRootId && logseq.Editor.insertBlock) {
      inserted = await logseq.Editor.insertBlock(pageRootId, heading, {
        sibling: false,
        before: false,
        end: true,
      });
    }
    if (!inserted && logseq.Editor.appendBlockInPage) {
      inserted = await logseq.Editor.appendBlockInPage(pageName, heading);
    }
    const id = blockId(inserted);
    if (id) {
      result.actions.push(`INSERT page section heading: ${objectType} / ${heading}`);
      await expandBlockUi(id);
      await sleep(THROTTLE_MS);
    }
    return id;
  } catch (error) {
    result.errors.push(`insert page section heading ${objectType}/${heading}: ${formatError(error)}`);
    return null;
  }
}

async function removeDuplicateDashboardQueryBlocksByTitle(
  result: Result,
  blocks: any[],
  objectType: string,
  views: ReturnType<typeof viewDefinitionsSafe>,
  pageName: string,
  pageEntity: any,
): Promise<number> {
  if (!logseq.Editor.removeBlock) return 0;
  const viewByTitle = new Map<string, (typeof views)[number]>();
  for (const view of views) {
    const title = normalizedQueryTitle(queryTitleForView(view));
    if (title && !viewByTitle.has(title)) viewByTitle.set(title, view);
  }
  if (!viewByTitle.size) return 0;

  const groups = new Map<string, ManagedHeadingBlock[]>();
  for (const entry of walkBlocksWithManagedHeading(blocks)) {
    const block = entry.block;
    const title = normalizedQueryTitle(await effectiveQueryBlockTitle(block));
    if (!title || !viewByTitle.has(title)) continue;
    if (!(await managedQueryTitleCandidate(block))) continue;
    const items = groups.get(title) ?? [];
    items.push(entry);
    groups.set(title, items);
  }

  let removed = 0;
  for (const [title, matches] of groups) {
    const unique = dedupeBlockEntries(matches);
    if (unique.length <= 1) continue;
    const view = viewByTitle.get(title);
    if (!view) continue;
    const queryContent = await dashboardQueryBlockForViewAsync(view, pageName, pageEntity);
    const candidates = unique.map((entry) => entry.block);
    const preferredCandidates = queryCandidatesUnderHeading(blocks, candidates, pageSectionHeadingForView(view));
    const canonical =
      (await pickCanonicalQueryBlock(preferredCandidates, queryContent)) ??
      (await pickCanonicalQueryBlock(candidates, queryContent)) ??
      candidates[0];
    const canonicalId = blockId(canonical);
    for (const duplicate of unique.map((entry) => entry.block)) {
      if (blockId(duplicate) === canonicalId) continue;
      if (await removeDashboardQueryBlock(result, duplicate, `${objectType} duplicate ${queryTitleForView(view)}`)) removed++;
    }
  }
  return removed;
}

function isEmptyPlaceholder(block: any): boolean {
  const text = String(block?.content ?? block?.title ?? '').trim();
  if (text && text !== '-' && !/^Query intent:/i.test(text)) return false;
  return (block?.children ?? []).every((child: any) => isEmptyPlaceholder(child));
}

async function canRemoveSectionWrapper(sectionBlock: any): Promise<boolean> {
  for (const child of sectionBlock?.children ?? []) {
    if (await isQueryLikeBlockAsync(child)) continue;
    if (isEmptyPlaceholder(child)) continue;
    return false;
  }
  return true;
}

async function removeLegacySectionWrapper(
  result: Result,
  sectionBlock: any,
  label: string,
): Promise<boolean> {
  const id = blockId(sectionBlock);
  if (!id || !logseq.Editor.removeBlock) return false;
  if (!(await canRemoveSectionWrapper(sectionBlock))) {
    let removed = false;
    for (const child of sectionBlock?.children ?? []) {
      if (!(await isQueryLikeBlockAsync(child))) continue;
      removed = (await removeDashboardQueryBlock(result, child, `${label} legacy nested query`)) || removed;
    }
    if (removed) {
      result.notes.push(`Kept legacy section wrapper ${label} because it contains non-query content.`);
    }
    return removed;
  }
  try {
    await logseq.Editor.removeBlock(id);
    result.actions.push(`REMOVE legacy dashboard section wrapper (${label})`);
    await sleep(50);
    return true;
  } catch (error) {
    result.errors.push(`remove legacy section wrapper ${label}: ${formatError(error)}`);
    return false;
  }
}

async function configureTitledQueryBlock(
  result: Result,
  block: any,
  queryContent: string,
  queryTitle: string,
  label: string,
): Promise<boolean> {
  if (!(await isDbGraph())) {
    await updateBlockContent(result, block, queryContent, `Set query content for ${label}`);
    const plainId = blockId(block);
    if (plainId) await expandBlockUi(plainId);
    return true;
  }
  const initialStruct = await inspectDbQueryBlockStructure(block);
  const visibleEdnChildNeedsRebuild =
    initialStruct.hasQueryClassTag &&
    initialStruct.childTitleHasEdn &&
    !initialStruct.hasQueryProperty;

  let ok = false;
  if (visibleEdnChildNeedsRebuild) {
    ok = await forceCreateQueryChild(result, block, queryContent);
  }
  if (!ok) {
    ok = await configureDbAdvancedQueryBlock(result, block, queryContent);
  }
  if (!ok) {
    await sleep(150);
    ok = await configureDbAdvancedQueryBlock(result, block, queryContent);
  }
  if (!ok) {
    const struct = await inspectDbQueryBlockStructure(block);
    const hasTagButNoChild = struct.hasQueryClassTag && !struct.hasQueryProperty;
    const hasEdnButNoDisplay = false;
    const hasVisibleEdnChild =
      struct.hasQueryClassTag && struct.childTitleHasEdn && !struct.hasQueryProperty;
    if (hasTagButNoChild || hasEdnButNoDisplay || hasVisibleEdnChild) {
      ok = await forceCreateQueryChild(result, block, queryContent);
    }
  }
  if (!ok) {
    await repairDbQueryBlockUiKeywords(result, block);
    const recheck = await inspectDbQueryBlockStructure(block);
    ok = !dbAdvancedQueryBlockNeedsStructureRepair(recheck);
  }
  if (ok) {
    await updateBlockContent(result, block, queryTitle, `Set query title to ${queryTitle}`);
    const id = blockId(block);
    if (id) await expandBlockUi(id);
  }
  return ok;
}

async function insertRootQueryBlock(
  result: Result,
  pageName: string,
  parentBlockId: string | null,
  queryTitle: string,
  queryContent: string,
  label: string,
): Promise<any | null> {
  if (!logseq.Editor.insertBlock && !logseq.Editor.appendBlockInPage) {
    result.errors.push(`dashboard-query: no insert API available for ${label}`);
    return null;
  }
  try {
    const isDb = await isDbGraph();
    const shellContent = isDb ? queryTitle : queryContent;
    let inserted: any = null;
    if (parentBlockId && logseq.Editor.insertBlock) {
      inserted = await logseq.Editor.insertBlock(parentBlockId, shellContent, {
        sibling: false,
        before: false,
        end: true,
      });
      if (!inserted) {
        result.errors.push(`insert dashboard query ${label}: failed to insert under managed heading`);
        return null;
      }
    }
    if (!parentBlockId && !inserted && logseq.Editor.appendBlockInPage) {
      inserted = await logseq.Editor.appendBlockInPage(pageName, shellContent);
    }
    if (!inserted) {
      result.errors.push(`insert dashboard query ${label}: no block returned by Logseq`);
      return null;
    }
    result.actions.push(`INSERT page-level dashboard query shell: ${label}`);
    const insertedIdBefore = blockId(inserted);
    if (insertedIdBefore) await expandBlockUi(insertedIdBefore);
    if (parentBlockId) await expandBlockUi(parentBlockId);
    await sleep(THROTTLE_MS);
    if (isDb) {
      const queryTagId = await resolveQueryClassTagId();
      const insertedId = blockId(inserted);
      if (queryTagId && insertedId) await logseq.Editor.addBlockTag(insertedId, queryTagId).catch(() => {});
      await sleep(20);
      const freshInserted =
        insertedId && logseq.Editor.getBlock
          ? ((await logseq.Editor.getBlock(insertedId, { includeChildren: true }).catch(() => null)) ?? inserted)
          : inserted;
      if (!(await configureTitledQueryBlock(result, freshInserted, queryContent, queryTitle, label))) {
        result.errors.push(`dashboard-query: advanced query shell was not finalized for ${label}; keeping shell for non-destructive retry.`);
      }
    }
    return inserted;
  } catch (error) {
    result.errors.push(`insert dashboard query ${label}: ${formatError(error)}`);
    return null;
  }
}

async function moveCanonicalQueryUnderHeading(
  result: Result,
  blocks: any[],
  candidates: any[],
  parentBlockId: string | null,
  heading: string,
  expectedContent: string,
  label: string,
): Promise<boolean> {
  if (!parentBlockId || !candidates.length) return false;
  const canonical = (await pickCanonicalQueryBlock(candidates, expectedContent)) ?? candidates[0];
  if (!canonical || queryCandidateIsUnderHeading(blocks, canonical, heading)) return false;
  const id = blockId(canonical);
  if (!id) return false;
  const moved = await moveBlockAsChildViaHost(id, parentBlockId);
  if (!moved.ok) {
    result.notes.push(`Could not move existing dashboard query under ${heading} for ${label}: ${moved.error ?? 'unknown error'}.`);
    return false;
  }
  result.actions.push(`MOVE dashboard query under ${heading}: ${label}`);
  await expandBlockUi(id);
  await expandBlockUi(parentBlockId);
  return true;
}

async function removeStaleDashboardQueryBlocks(
  result: Result,
  rootBlocks: any[],
  objectType: string,
  views: ReturnType<typeof viewDefinitionsSafe>,
): Promise<number> {
  if (!logseq.Editor.removeBlock) return 0;
  const currentSources = currentViewSourceTagSet(views);
  if (!currentSources.size) return 0;

  let removed = 0;
  for (const block of rootBlocks ?? []) {
    if (isManagedPageSectionHeading(blockTitle(block))) continue;
    if (await isQueryLikeBlockAsync(block)) {
      if (await titleMatchesAnyViewAsync(block, views)) continue;
      if (!(await queryBlockUsesCurrentSource(block, currentSources))) continue;
      if (await removeDashboardQueryBlock(result, block, `${objectType} stale query`)) removed++;
      continue;
    }

    const section = sectionNameFromLine(String(block?.content ?? ''));
    if (section && isManagedPageSectionHeading(section)) continue;
    if (!section || (await titleMatchesAnyViewAsync(block, views))) continue;
    let hasStaleManagedQuery = false;
    for (const child of block?.children ?? []) {
      if (!(await isQueryLikeBlockAsync(child))) continue;
      if (await queryBlockUsesCurrentSource(child, currentSources)) {
        hasStaleManagedQuery = true;
        break;
      }
    }
    if (!hasStaleManagedQuery) continue;
    if (await removeLegacySectionWrapper(result, block, `${objectType} stale ${section}`)) removed++;
  }
  return removed;
}

async function removeBlankManagedQueryShells(
  result: Result,
  rootBlocks: any[],
  objectType: string,
): Promise<number> {
  if (!logseq.Editor.removeBlock) return 0;
  let removed = 0;
  for (const entry of walkBlocksWithManagedHeading(rootBlocks)) {
    if (!entry.heading || !isManagedPageSectionHeading(entry.heading)) continue;
    const title = blockTitle(entry.block);
    if (normalizedQueryTitle(title)) continue;
    if (!(await isQueryLikeBlockAsync(entry.block))) continue;
    const contentTitle = queryTitleFromEdnContent(await readDashboardQueryBlockContent(entry.block));
    if (normalizedQueryTitle(contentTitle ?? '')) continue;
    const struct = await inspectDbQueryBlockStructure(entry.block);
    if (struct.hasQueryProperty || struct.queryEdnInChild || struct.rawEdnInParentContent) continue;
    if (await removeDashboardQueryBlock(result, entry.block, `${objectType} blank query shell under ${entry.heading}`)) {
      removed++;
    }
  }
  return removed;
}

async function refreshPageBlocks(pageName: string, fallback: any[]): Promise<any[]> {
  let freshBlocks = await getBlocks(pageName);
  if (!freshBlocks?.length && safePageName(pageName) !== pageName) {
    freshBlocks = await getBlocks(safePageName(pageName));
  }
  return freshBlocks?.length ? freshBlocks : fallback;
}

async function enforceDashboardQueryPlacement(
  result: Result,
  blocks: any[],
  objectType: string,
  views: ReturnType<typeof viewDefinitionsSafe>,
  pageName: string,
  pageEntity: any,
  pageRootId: string | null,
): Promise<number> {
  let changed = 0;
  let freshBlocks = blocks;
  const ensuredHeadingIds = new Map<string, string | null>();

  for (const view of views) {
    const section = String(view.section ?? '').trim();
    if (!section) continue;
    const queryContent = await dashboardQueryBlockForViewAsync(view, pageName, pageEntity);
    if (!queryContent) continue;
    const queryTitle = queryTitleForView(view);
    const queryGroupHeading = pageSectionHeadingForView(view);
    if (await queryCandidateUnderHeading(freshBlocks, queryTitle, section, queryGroupHeading)) continue;

    if (!ensuredHeadingIds.has(queryGroupHeading)) {
      const ensuredId = await ensureRootHeadingBlock(result, freshBlocks, pageName, pageRootId, queryGroupHeading, objectType);
      ensuredHeadingIds.set(queryGroupHeading, ensuredId);
      if (ensuredId) freshBlocks = await refreshPageBlocks(pageName, freshBlocks);
    }
    const queryParentId = ensuredHeadingIds.get(queryGroupHeading) ?? blockId(findRootHeadingBlock(freshBlocks, queryGroupHeading));
    if (!queryParentId) continue;

    const candidates = await rootQueryCandidates(freshBlocks, queryTitle, section, queryContent);
    if (!candidates.length) continue;
    if (await moveCanonicalQueryUnderHeading(result, freshBlocks, candidates, queryParentId, queryGroupHeading, queryContent, `${objectType} / ${section}`)) {
      changed++;
      freshBlocks = await refreshPageBlocks(pageName, freshBlocks);
    }
  }

  return changed;
}

export async function repairDashboardQueries(
  result: Result,
  pageName: string,
  blocks: any[],
  typeHint: string | null = null,
  sectionsFilter: Set<string> | null = null,
  inferObjectType: InferObjectType,
  options: DashboardRepairOptions = {},
): Promise<number> {
  const objectType = typeHint || inferObjectType(pageName, blocks);
  if (!objectType) {
    result.notes.push(`Dashboard query repair: could not infer object type from page sections or promoted tags/properties.`);
    return 0;
  }
  const template = templateDefByObjectType(objectType);
  if (!template) {
    result.notes.push(`Dashboard query repair: no template definition found for inferred type ${objectType}.`);
    return 0;
  }
  if (options.maxViews === 0) {
    result.notes.push(
      `Dashboard query repair: skipped for ${objectType}; lss: materialise page avoids native query UI repair stalls.`,
    );
    return 0;
  }
  const pageSectionHeadings = new Set((options.pageSectionHeadings ?? []).map(normalizedHeading).filter(Boolean));
  const aggregateHeadings = new Set((options.aggregatePageSectionHeadings ?? []).map(normalizedHeading).filter(Boolean));
  let views = viewDefinitionsSafe(template).filter((view) => viewMatchesPageSectionHeading(view, pageSectionHeadings));
  views = aggregatePageSectionViews(views, aggregateHeadings);
  if (!views.length) {
    result.notes.push(`Dashboard query repair: no ${objectType} query views matched bounded materialise options.`);
    return 0;
  }
  let freshBlocks = await getBlocks(pageName);
  if (!freshBlocks?.length && safePageName(pageName) !== pageName) {
    freshBlocks = await getBlocks(safePageName(pageName));
  }
  if (!freshBlocks?.length) freshBlocks = blocks;
  let changed = 0;
  let checked = 0;

  const pageEntity = await getPage(pageName);
  const pageRootId = blockId(pageEntity);
  changed += await removeBlankManagedQueryShells(result, freshBlocks, objectType);
  if (changed) {
    freshBlocks = await refreshPageBlocks(pageName, blocks);
  }
  changed += await removeDuplicateDashboardQueryBlocksByTitle(result, freshBlocks, objectType, views, pageName, pageEntity);
  if (changed) {
    freshBlocks = await refreshPageBlocks(pageName, blocks);
  }
  const sectionBlocks = findSectionBlocks(freshBlocks);
  const cleanedLegacySectionIds = new Set<string>();
  const ensuredHeadingIds = new Map<string, string | null>();

  let repairedViews = 0;
  for (const view of views) {
    const section = String(view.section ?? '').trim();
    if (!section) continue;
    if (sectionsFilter && !sectionsFilter.has(section)) continue;
    if (options.maxViews != null && repairedViews >= options.maxViews) {
      result.notes.push(
        `Dashboard query repair: deferred remaining ${objectType} query sections after ${options.maxViews} bounded materialise update(s).`,
      );
      break;
    }
    repairedViews++;
    let sectionBlock = sectionBlocks.get(section);
    const queryContent = await dashboardQueryBlockForViewAsync(view, pageName, pageEntity);
    if (!queryContent) continue;
    const queryTitle = queryTitleForView(view);
    const label = `${objectType} / ${section}`;
    const queryGroupHeading = pageSectionHeadingForView(view);
    if (!ensuredHeadingIds.has(queryGroupHeading)) {
      const ensuredId = await ensureRootHeadingBlock(result, freshBlocks, pageName, pageRootId, queryGroupHeading, objectType);
      ensuredHeadingIds.set(queryGroupHeading, ensuredId);
      if (ensuredId && !findRootHeadingBlock(freshBlocks, queryGroupHeading)) {
        freshBlocks = await getBlocks(pageName);
        if (!freshBlocks?.length && safePageName(pageName) !== pageName) {
          freshBlocks = await getBlocks(safePageName(pageName));
        }
        if (!freshBlocks?.length) freshBlocks = blocks;
      }
    }
    const queryParentId =
      ensuredHeadingIds.get(queryGroupHeading) ??
      blockId(findRootHeadingBlock(freshBlocks, queryGroupHeading));
    if (!queryParentId) {
      result.errors.push(`dashboard-query: missing managed heading ${queryGroupHeading} for ${label}; refusing to create root-level query.`);
      continue;
    }
    let rootQueries = await rootQueryCandidates(freshBlocks, queryTitle, section, queryContent);
    if (rootQueries.length && queryParentId) {
      if (await moveCanonicalQueryUnderHeading(result, freshBlocks, rootQueries, queryParentId, queryGroupHeading, queryContent, label)) {
        changed++;
        freshBlocks = await refreshPageBlocks(pageName, blocks);
        rootQueries = await rootQueryCandidates(freshBlocks, queryTitle, section, queryContent);
      }
    }
    if (rootQueries.length && queryParentId && !(await queryCandidateUnderHeading(freshBlocks, queryTitle, section, queryGroupHeading))) {
      if (await insertRootQueryBlock(result, pageName, queryParentId, queryTitle, queryContent, label)) {
        changed++;
        freshBlocks = await refreshPageBlocks(pageName, blocks);
        rootQueries = await rootQueryCandidates(freshBlocks, queryTitle, section, queryContent);
      }
    }
    let pageLevelQueryReady = rootQueries.length > 0;

    if (rootQueries.length) {
      const preferredQueries = queryCandidatesUnderHeading(freshBlocks, rootQueries, queryGroupHeading);
      const canonical =
        (await pickCanonicalQueryBlock(preferredQueries, queryContent)) ??
        (await pickCanonicalQueryBlock(rootQueries, queryContent)) ??
        preferredQueries[0] ??
        rootQueries[0];
      const canonicalId = blockId(canonical);
      let canonicalUsable = true;
      if (canonicalId) await expandBlockUi(canonicalId);
      if (queryParentId) await expandBlockUi(queryParentId);

      const before = await readDashboardQueryBlockContent(canonical);
      const needsContent = queryBlockNeedsRepair(before, queryContent);
      const struct = await inspectDbQueryBlockStructure(canonical);
      const needsStructure = dbAdvancedQueryBlockNeedsStructureRepair(struct);
      const needsTitle = !(await titleMatchesViewAsync(canonical, queryTitle, section));
      if (needsContent || needsStructure || needsTitle) {
        if (await configureTitledQueryBlock(result, canonical, queryContent, queryTitle, label)) {
          result.actions.push(`REPAIRED page-level advanced query for ${label}`);
          changed++;
        } else {
          result.errors.push(`dashboard-query: could not finalize ${label}; keeping existing query block for non-destructive retry.`);
          canonicalUsable = true;
          pageLevelQueryReady = true;
        }
      } else {
        checked++;
      }

      if (canonicalUsable && pageLevelQueryReady && canonicalId) {
        const duplicateCount = rootQueries.length - 1;
        for (const existing of rootQueries) {
          if (blockId(existing) === canonicalId) continue;
          if (await removeDashboardQueryBlock(result, existing, label)) {
            changed++;
          }
        }
        if (duplicateCount > 0) {
          result.notes.push(
            `Dashboard query dedupe: removed ${duplicateCount} extra query block(s) under ${section}; kept one canonical block.`,
          );
        }
      }
    } else {
      if (await insertRootQueryBlock(result, pageName, queryParentId, queryTitle, queryContent, label)) {
        changed++;
        pageLevelQueryReady = true;
      }
    }

    const sectionId = sectionBlock ? blockId(sectionBlock) : null;
    const sectionIsManagedHeading = sectionBlock
      ? isManagedPageSectionHeading(sectionNameFromLine(String(sectionBlock?.content ?? '')) || blockTitle(sectionBlock))
      : false;
    const sectionIsQueryBlock = sectionBlock ? await isQueryLikeBlockAsync(sectionBlock) : false;
    if (pageLevelQueryReady && sectionBlock && !sectionIsManagedHeading && !sectionIsQueryBlock && (!sectionId || !cleanedLegacySectionIds.has(sectionId))) {
      if (await removeLegacySectionWrapper(result, sectionBlock, label)) {
        changed++;
        if (sectionId) cleanedLegacySectionIds.add(sectionId);
      }
    }
  }
  if (options.maxViews != null) {
    result.notes.push(
      `Dashboard query repair: bounded run for ${objectType}; changed/inserted ${changed} query block(s), checked ${checked} existing query block(s).`,
    );
    return changed;
  }

  const afterRepairBlocks = await refreshPageBlocks(pageName, blocks);
  changed += await enforceDashboardQueryPlacement(result, afterRepairBlocks, objectType, views, pageName, pageEntity, pageRootId);
  const afterPlacementBlocks = changed ? await refreshPageBlocks(pageName, afterRepairBlocks) : afterRepairBlocks;
  changed += await removeDuplicateDashboardQueryBlocksByTitle(result, afterPlacementBlocks, objectType, views, pageName, pageEntity);
  const afterDedupeBlocks = changed ? await refreshPageBlocks(pageName, afterPlacementBlocks) : afterPlacementBlocks;
  changed += await removeStaleDashboardQueryBlocks(result, afterDedupeBlocks, objectType, views);
  const afterStaleBlocks = changed ? await refreshPageBlocks(pageName, afterDedupeBlocks) : afterDedupeBlocks;
  changed += await removeDuplicateManagedHeadingBlocks(result, afterStaleBlocks, objectType);
  const afterHeadingDedupeBlocks = changed ? await refreshPageBlocks(pageName, afterStaleBlocks) : afterStaleBlocks;
  changed += await removeBlankManagedQueryShells(result, afterHeadingDedupeBlocks, objectType);

  result.notes.push(
    `Dashboard query repair: inferred ${objectType}; changed/inserted ${changed} query block(s), checked ${checked} existing query block(s).`,
  );
  return changed;
}

export async function repairLinkedParentDashboards(
  result: Result,
  props: Map<string, string>,
  objectType: string | null,
  currentPage: string,
  repairPageRefsFromValue: RepairParentRefs,
  resolveVisibleNodeToken: ResolveVisibleNodeToken,
  inferObjectType: InferObjectType,
): Promise<number> {
  let total = 0;
  const repairedKeys = new Set<string>();
  const skippedPlaceholders = new Set<string>();

  for (const [prop, rawValue] of props.entries()) {
    const spec = propertySpec(prop);
    if (String(spec?.type ?? '').toLowerCase() !== 'node') continue;
    const refs = repairPageRefsFromValue(rawValue);
    if (!refs.length) continue;

    const targets = ((spec as { targets?: unknown[] } | undefined)?.targets ?? []).map(String).filter(Boolean);
    const targetHints: Array<string | null> = targets.length ? targets : [null];
    for (const ref of refs) {
      const parentName = await resolveVisibleNodeToken(result, ref);
      if (isPlaceholderPageRef(parentName)) {
        if (!skippedPlaceholders.has(parentName)) {
          result.notes.push(`SKIP linked parent repair for placeholder [[${parentName}]].`);
          skippedPlaceholders.add(parentName);
        }
        continue;
      }

      let parentBlocks: any[] | null = null;
      for (const targetHint of targetHints) {
        if (!parentBlocks && !targetHint) parentBlocks = await getBlocks(parentName);
        const targetType = targetHint ?? inferObjectType(parentName, parentBlocks ?? []);
        if (!targetType) continue;
        const dashboard = dashboardPageForObjectType(targetType);
        const template = templateDefByObjectType(targetType);
        if (!template) continue;
        const sections = new Set<string>();
        for (const view of viewDefinitionsSafe(template)) {
          if (dashboard && view.dashboard && view.dashboard !== dashboard) continue;
          if ((view.filters ?? []).some((filter) => filterProps(filter).includes(prop))) {
            sections.add(String(view.section ?? '').trim());
          }
        }
        if (!sections.size) continue;

        const key = `${targetType}:${parentName}:${[...sections].sort().join('|')}`;
        if (repairedKeys.has(key)) continue;
        repairedKeys.add(key);
        result.notes.push(
          `Linked parent repair: ${objectType ?? 'object'} ${currentPage} points to ${targetType} [[${parentName}]] via ${prop}; refreshing ${[...sections].join(', ')}.`,
        );
        parentBlocks = parentBlocks ?? await getBlocks(parentName);
        total += await repairDashboardQueries(result, parentName, parentBlocks, targetType, sections, inferObjectType);
        markRepairCooldown(parentName);
      }
    }
  }
  return total;
}
