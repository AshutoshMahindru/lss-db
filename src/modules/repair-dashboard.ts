import { THROTTLE_MS } from '../config';
import { isDbGraph } from '../core/db-properties';
import { blockId, getBlocks, getPage, updateBlockContent, walkBlocks } from '../core/editor';
import { safePageName } from '../core/names';
import { formatError, sleep } from '../core/runner';
import type { Result } from '../core/types';
import { dashboardPageForObjectType, propertySpec, templateDefByObjectType } from '../registry';
import { markRepairCooldown, scheduleAutoRepair } from './auto-repair';
import {
  configureDbAdvancedQueryBlock,
  dashboardQueryBlockForViewAsync,
  dbAdvancedQueryBlockNeedsStructureRepair,
  filterProps,
  inspectDbQueryBlockStructure,
  isQueryLikeBlockAsync,
  pickCanonicalQueryBlock,
  queryTitleForView,
  queryBlockNeedsRepair,
  readDashboardQueryBlockContent,
  repairDbQueryBlockUiKeywords,
  resolveQueryClassTagId,
  sectionNameFromLine,
  viewDefinitionsSafe,
} from './queries';
import { forceCreateQueryChild } from './advanced-query-blocks';

type InferObjectType = (pageName: string, blocks: any[]) => string | null;
type RepairParentRefs = (value: string) => string[];
type ResolveVisibleNodeToken = (result: Result, token: string) => Promise<string>;

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

async function rootQueryCandidates(
  blocks: any[],
  queryTitle: string,
  section: string,
  queryContent: string,
): Promise<any[]> {
  const out: any[] = [];
  for (const block of blocks ?? []) {
    if (!(await isQueryLikeBlockAsync(block))) continue;
    if (titleMatchesView(block, queryTitle, section)) {
      out.push(block);
      continue;
    }
    const content = await readDashboardQueryBlockContent(block);
    if (!queryBlockNeedsRepair(content, queryContent)) out.push(block);
  }
  return dedupeBlocks(out);
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
    return true;
  }
  let ok = await configureDbAdvancedQueryBlock(result, block, queryContent);
  if (!ok) {
    await sleep(150);
    ok = await configureDbAdvancedQueryBlock(result, block, queryContent);
  }
  if (!ok) {
    const struct = await inspectDbQueryBlockStructure(block);
    const hasTagButNoChild = struct.hasQueryClassTag && !struct.hasQueryProperty;
    const hasEdnButNoDisplay =
      struct.hasQueryClassTag && struct.hasQueryProperty && struct.childTitleHasEdn && !struct.childDisplayTypeIsCode;
    if (hasTagButNoChild || hasEdnButNoDisplay) {
      ok = await forceCreateQueryChild(result, block, queryContent);
    }
  }
  if (!ok) {
    await repairDbQueryBlockUiKeywords(result, block);
    const recheck = await inspectDbQueryBlockStructure(block);
    ok = !dbAdvancedQueryBlockNeedsStructureRepair(recheck);
  }
  if (ok) await updateBlockContent(result, block, queryTitle, `Set query title to ${queryTitle}`);
  return ok;
}

async function insertRootQueryBlock(
  result: Result,
  pageName: string,
  pageRootId: string | null,
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
    if (pageRootId && logseq.Editor.insertBlock) {
      inserted = await logseq.Editor.insertBlock(pageRootId, shellContent, {
        sibling: false,
        before: false,
        end: true,
      });
    }
    if (!inserted && logseq.Editor.appendBlockInPage) {
      inserted = await logseq.Editor.appendBlockInPage(pageName, shellContent);
    }
    if (!inserted) {
      result.errors.push(`insert dashboard query ${label}: no block returned by Logseq`);
      return null;
    }
    result.actions.push(`INSERT page-level dashboard query shell: ${label}`);
    await sleep(THROTTLE_MS);
    if (isDb) {
      const queryTagId = await resolveQueryClassTagId();
      const insertedId = blockId(inserted);
      if (queryTagId && insertedId) await logseq.Editor.addBlockTag(insertedId, queryTagId).catch(() => {});
      await sleep(20);
      if (!(await configureTitledQueryBlock(result, inserted, queryContent, queryTitle, label))) {
        result.notes.push(`Page-level query shell created for ${label} (auto-repair will finalize if needed).`);
        try {
          scheduleAutoRepair(pageName);
        } catch {
          /* non-critical background scheduling */
        }
      }
    }
    return inserted;
  } catch (error) {
    result.errors.push(`insert dashboard query ${label}: ${formatError(error)}`);
    return null;
  }
}

export async function repairDashboardQueries(
  result: Result,
  pageName: string,
  blocks: any[],
  typeHint: string | null = null,
  sectionsFilter: Set<string> | null = null,
  inferObjectType: InferObjectType,
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
  const views = viewDefinitionsSafe(template);
  let freshBlocks = await getBlocks(pageName);
  if (!freshBlocks?.length && safePageName(pageName) !== pageName) {
    freshBlocks = await getBlocks(safePageName(pageName));
  }
  if (!freshBlocks?.length) freshBlocks = blocks;
  const sectionBlocks = findSectionBlocks(freshBlocks);
  let changed = 0;
  let checked = 0;

  const pageEntity = await getPage(pageName);
  const pageRootId = blockId(pageEntity);
  const cleanedLegacySectionIds = new Set<string>();

  for (const view of views) {
    const section = String(view.section ?? '').trim();
    if (!section) continue;
    if (sectionsFilter && !sectionsFilter.has(section)) continue;
    let sectionBlock = sectionBlocks.get(section);
    const queryContent = await dashboardQueryBlockForViewAsync(view, pageName, pageEntity);
    if (!queryContent) continue;
    const queryTitle = queryTitleForView(view);
    const label = `${objectType} / ${section}`;
    const rootQueries = await rootQueryCandidates(freshBlocks, queryTitle, section, queryContent);
    let pageLevelQueryReady = rootQueries.length > 0;

    if (rootQueries.length) {
      const canonical = (await pickCanonicalQueryBlock(rootQueries, queryContent)) ?? rootQueries[0];
      const canonicalId = blockId(canonical);
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

      const before = await readDashboardQueryBlockContent(canonical);
      const needsContent = queryBlockNeedsRepair(before, queryContent);
      const struct = await inspectDbQueryBlockStructure(canonical);
      const needsStructure = dbAdvancedQueryBlockNeedsStructureRepair(struct);
      const needsTitle = !titleMatchesView(canonical, queryTitle, section);
      if (needsContent || needsStructure || needsTitle) {
        if (await configureTitledQueryBlock(result, canonical, queryContent, queryTitle, label)) {
          result.actions.push(`REPAIRED page-level advanced query for ${label}`);
          changed++;
        } else {
          for (const existing of rootQueries) {
            if (await removeDashboardQueryBlock(result, existing, label)) {
              changed++;
            }
          }
          pageLevelQueryReady = false;
          if (await insertRootQueryBlock(result, pageName, pageRootId, queryTitle, queryContent, label)) {
            result.actions.push(`REBUILT advanced query from scratch for ${label}`);
            changed++;
            pageLevelQueryReady = true;
          }
        }
      } else {
        checked++;
      }
    } else {
      if (await insertRootQueryBlock(result, pageName, pageRootId, queryTitle, queryContent, label)) {
        changed++;
        pageLevelQueryReady = true;
      }
    }

    const sectionId = sectionBlock ? blockId(sectionBlock) : null;
    if (pageLevelQueryReady && sectionBlock && (!sectionId || !cleanedLegacySectionIds.has(sectionId))) {
      if (await removeLegacySectionWrapper(result, sectionBlock, label)) {
        changed++;
        if (sectionId) cleanedLegacySectionIds.add(sectionId);
      }
    }
  }

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
    for (const targetType of targets) {
      const dashboard = dashboardPageForObjectType(targetType);
      const template = templateDefByObjectType(targetType);
      if (!dashboard || !template) continue;
      const sections = new Set<string>();
      for (const view of viewDefinitionsSafe(template)) {
        if (view.dashboard !== dashboard) continue;
        if ((view.filters ?? []).some((filter) => filterProps(filter).includes(prop))) {
          sections.add(String(view.section ?? '').trim());
        }
      }
      if (!sections.size) continue;

      for (const ref of refs) {
        const parentName = await resolveVisibleNodeToken(result, ref);
        if (isPlaceholderPageRef(parentName)) {
          if (!skippedPlaceholders.has(parentName)) {
            result.notes.push(`SKIP linked parent repair for placeholder [[${parentName}]].`);
            skippedPlaceholders.add(parentName);
          }
          continue;
        }
        const key = `${targetType}:${parentName}:${[...sections].sort().join('|')}`;
        if (repairedKeys.has(key)) continue;
        repairedKeys.add(key);
        result.notes.push(
          `Linked parent repair: ${objectType ?? 'object'} ${currentPage} points to ${targetType} [[${parentName}]] via ${prop}; refreshing ${[...sections].join(', ')}.`,
        );
        const parentBlocks = await getBlocks(parentName);
        total += await repairDashboardQueries(result, parentName, parentBlocks, targetType, sections, inferObjectType);
        markRepairCooldown(parentName);
      }
    }
  }
  return total;
}
