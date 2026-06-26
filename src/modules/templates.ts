import { THROTTLE_MS } from '../config';
import {
  appendManagedBlock,
  blockId,
  ensurePage,
  ensureTagByName,
  findBlockByMarker,
  getBlocks,
  updateBlockContent,
  walkBlocks,
} from '../core/editor';
import { entityIdentity, resolveUpsertPropertyValue } from '../core/db-properties';
import { formatError, sleep } from '../core/runner';
import { pageForCanonical, safeMarkdownRefs, safeTag, todayRef } from '../core/names';
import type { Result } from '../core/types';
import { areaRelationshipPropertiesForObject, normalizeAreaRef, objectByName, propertySpec, registry, templateNameFromRegistry } from '../registry';
import type { RegistryObject, RegistryTemplate } from '../registry/types';
import { legacyTemplateText } from './contracts';
import { ensurePlaceholderPagesForNodeValue } from './repair-user-properties';
import {
  advancedDashboardQueryEdnForViewAsync,
  advancedQueryBlockContent,
  configureDbAdvancedQueryBlock,
  isAdvancedQueryBlockContent,
  isQueryLikeBlockAsync,
  isQueryLikeContent,
  queryBlockContent,
  queryTitleForView,
  readDashboardQueryBlockContent,
  sectionNameFromLine,
  simpleQueryForView,
  simpleQueryForViewAsync,
  sourceTagsForView,
  sourceTagsFromQueryContent,
  viewDefinitionsSafe,
} from './queries';

type OutlineLine = { level: number; content: string };
type BatchBlock = { content: string; children?: BatchBlock[] };
type TemplateProperty = { key: string; value: string };

const APPLY_TEMPLATE_TO_TAGS = 'Apply template to tags';

function indentLevel(raw: string): number {
  const spaces = raw.match(/^(\s*)/)?.[1]?.length ?? 0;
  return Math.max(0, Math.floor(spaces / 2));
}

export function parseTemplateOutline(text: string): OutlineLine[] {
  const lines: OutlineLine[] = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const bullet = raw.match(/^(\s*)-\s+(.*)$/);
    if (bullet) {
      lines.push({ level: indentLevel(bullet[1]), content: bullet[2].trim() });
      continue;
    }
    const prop = raw.match(/^(\s+)(.+)$/);
    if (prop && /::/.test(prop[2])) {
      lines.push({ level: Math.max(1, indentLevel(prop[1])), content: prop[2].trim() });
    }
  }
  return lines;
}

function parsePropertyLine(content: string): TemplateProperty | null {
  const match = String(content ?? '').match(/^([A-Za-z0-9 _-]+)::\s*(.*)$/);
  if (!match) return null;
  return { key: match[1].trim(), value: String(match[2] ?? '').trim() };
}

function propertyLineText(prop: TemplateProperty): string {
  return `${prop.key}:: ${prop.value}`;
}

export function uniqueObjectProps(o: RegistryObject): string[] {
  const seen = new Set<string>();
  const primary: string[] = [];
  const related: string[] = [];
  const trailing: string[] = [];
  let deferredRelatedTo = '';
  const primaryBeforeRelatedTo = (p: string) => ['status', 'Status', 'area', 'areas', 'date'].includes(p);
  const beforeRelatedTo = (p: string) => {
    if (p.startsWith('related-')) return true;
    if (p === 'owner' || p === 'area' || p === 'areas') return false;
    const spec = propertySpec(p);
    return String(spec?.type ?? '').toLowerCase() === 'node';
  };
  const add = (p: string) => {
    if (!p || seen.has(p)) return;
    seen.add(p);
    if (p === 'related-to') {
      deferredRelatedTo = p;
    } else if (primaryBeforeRelatedTo(p)) {
      primary.push(p);
    } else if (beforeRelatedTo(p)) {
      related.push(p);
    } else {
      trailing.push(p);
    }
  };
  for (const p of o.requiredProperties ?? []) add(p);
  for (const p of [...(o.properties ?? []), ...areaRelationshipPropertiesForObject(o)]) {
    add(p);
  }
  if (deferredRelatedTo) related.push(deferredRelatedTo);
  return [...primary, ...related, ...trailing];
}

export function placeholderNodePropertyValue(prop: string, spec: { targets?: unknown[] } | undefined): string {
  const target = (spec?.targets ?? [])
    .map(String)
    .map((value) => safeTag(value))
    .find((value) => value && !value.includes('/'));
  return `[[${pageForCanonical(`LSS Placeholder/${target || prop}`)}]]`;
}

export function defaultPropertyValue(prop: string, o: RegistryObject): string {
  const p = String(prop);
  if (Object.prototype.hasOwnProperty.call(o.defaultValues ?? {}, p)) {
    const value = o.defaultValues?.[p];
    return value == null ? '' : String(value);
  }
  const area = normalizeAreaRef(o.area);
  if (p === 'area' || p === 'areas') return `[[${pageForCanonical(area)}]]`;
  if (p === 'status') return safeTag(o.tag) === 'ActionItem' ? 'Todo' : 'active';
  if (p === 'Status') return 'Todo';
  if (p === 'priority' || p === 'Priority') return safeTag(o.tag) === 'ActionItem' ? 'Medium' : 'medium';
  if (['date', 'captured-on', 'asked-on', 'decided-on', 'start-date', 'review-date', 'created-on'].includes(p)) {
    // Plain date string (no brackets) for better visibility on DB graphs
    return todayRef().replace(/^\[\[|\]\]$/g, '');
  }
  if (['Deadline', 'deadline', 'due-date', 'Scheduled'].includes(p)) return todayRef().replace(/^\[\[|\]\]$/g, '');
  if (p === 'Deadline' || p === 'deadline') return '';
  if (p === 'confidentiality') return 'internal';
  const spec = propertySpec(p);
  if (String(spec?.type ?? '').toLowerCase() === 'node') {
    return placeholderNodePropertyValue(p, spec as { targets?: unknown[] } | undefined);
  }
  return '';
}

function templateProperties(t: RegistryTemplate): TemplateProperty[] {
  const displayName = templateNameFromRegistry(t);
  const obj = objectByName(safeTag((t.appliesTo ?? [])[0] ?? displayName));

  // === TAG / REGISTRYOBJECT IS THE ONLY SCHEMA SOURCE ===
  // Properties come *exclusively* from the RegistryObject (tag = schema source).
  // We deliberately ignore t.body for any property lines.
  // Template bodies are purely for structural sections + queries + requiredSections.
  // This eliminates duplication (was: tag + template both injecting props).
  const out: TemplateProperty[] = [];
  const seen = new Set<string>();

  if (obj) {
    out.push({ key: 'lss-object-type', value: obj.name });
    seen.add('lss-object-type');
    for (const key of uniqueObjectProps(obj)) {
      if (seen.has(key.toLowerCase())) continue;
      out.push({ key, value: defaultPropertyValue(key, obj) });
      seen.add(key.toLowerCase());
    }
  }

  return out;
}

function splitTemplateSections(lines: OutlineLine[]): OutlineLine[] {
  const sections: OutlineLine[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.level === 1 && parsePropertyLine(line.content)) continue;
    sections.push(line);
  }
  return sections;
}

export function outlineToBatchBlock(lines: OutlineLine[]): BatchBlock | null {
  if (!lines.length) return null;
  const root: BatchBlock = { content: lines[0].content, children: [] };
  const stack: Array<{ level: number; node: BatchBlock }> = [{ level: lines[0].level, node: root }];
  for (let i = 1; i < lines.length; i++) {
    const { level, content } = lines[i];
    const node: BatchBlock = { content, children: [] };
    while (stack.length > 1 && stack[stack.length - 1].level >= level) stack.pop();
    const parent = stack[stack.length - 1].node;
    if (!parent.children) parent.children = [];
    parent.children.push(node);
    stack.push({ level, node });
  }
  const prune = (node: BatchBlock): BatchBlock => ({
    content: node.content,
    ...(node.children?.length ? { children: node.children.map(prune) } : {}),
  });
  return prune(root);
}

async function queryContentForView(view: import('../registry/types').ViewDefinition): Promise<string | null> {
  // Always prefer advanced EDN form for templates on DB graphs.
  // This keeps queries as advanced even if isDbGraph() check is flaky during setup.
  try {
    const advanced = await advancedDashboardQueryEdnForViewAsync(view);
    if (advanced) return advancedQueryBlockContent(advanced);
  } catch {}
  // Fallback for file graphs
  const body = await simpleQueryForViewAsync(view, '<% current page %>');
  if (!body) return null;
  return queryBlockContent(body);
}

function queryBlockLabelKey(value: string): string {
  return String(value ?? '')
    .split(/\r?\n/)[0]
    .replace(/^#+\s*/, '')
    .trim()
    .toLowerCase()
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ');
}

function batchChildMatchesView(child: BatchBlock, view: import('../registry/types').ViewDefinition): boolean {
  const section = sectionNameFromLine(child.content);
  const label = queryBlockLabelKey(section || child.content);
  return [view.section, queryTitleForView(view)].some((candidate) => queryBlockLabelKey(String(candidate ?? '')) === label);
}

async function injectQueriesIntoBatch(batch: BatchBlock, t: RegistryTemplate): Promise<BatchBlock> {
  const views = viewDefinitionsSafe(t);
  const viewBySection = new Map<string, (typeof views)[number]>();
  for (const view of views) {
    const section = String(view.section ?? '').trim();
    if (section && !viewBySection.has(section)) viewBySection.set(section, view);
  }

  const visit = async (node: BatchBlock): Promise<void> => {
    const section = sectionNameFromLine(node.content);
    if (section) {
      const view = viewBySection.get(section);
      const queryContent = view ? await queryContentForView(view) : null;
      if (queryContent) {
        const qTitle = queryTitleForView(view);
        const isDb = await isDbGraph();
        if (isDb && queryContent.startsWith('{')) {
          // For DB: replace section name with the title query at this indent level (level 0).
          // No EDN in batch to avoid text.
          // Sync will configure the structure on the titled block.
          node.content = qTitle;
          node.children = node.children?.filter(c => !isQueryLikeContent(c.content)) ?? [];
        } else {
          node.children.unshift({ content: `${qTitle}\n#Query ${simpleQueryForView(view)}` });
        }
      }
    }
    for (const child of node.children ?? []) await visit(child);
  };

  await visit(batch);

  if (!batch.children) batch.children = [];
  for (const view of views) {
    if (batch.children.some((child) => batchChildMatchesView(child, view))) continue;
    const queryContent = await queryContentForView(view);
    if (!queryContent) continue;
    const qTitle = queryTitleForView(view);
    const isDb = await isDbGraph();
    batch.children.push({
      content: isDb && queryContent.startsWith('{') ? qTitle : `${qTitle}\n#Query ${simpleQueryForView(view)}`,
    });
  }
  return batch;
}

function templateMarkerId(t: RegistryTemplate): string {
  return `native-template-${String(t.name ?? '').replace(/[^a-zA-Z0-9]+/g, '-')}`;
}

function rootContentWithMarker(displayName: string, markerId: string): string {
  return `${displayName}\n\n<!-- lss-managed:${markerId} -->`;
}

async function buildEnrichedTemplateBatch(t: RegistryTemplate): Promise<BatchBlock | null> {
  const displayName = templateNameFromRegistry(t);
  const bodyLines = parseTemplateOutline(safeMarkdownRefs(String(t.body ?? '').trim()));
  if (!bodyLines.length) return null;

  // Props are set via upsert in syncTemplateStructure (using RegistryObject), not as visible text in batch.
  const sectionLines = splitTemplateSections(bodyLines);
  const batch = outlineToBatchBlock([{ level: 0, content: displayName }, ...sectionLines]);
  if (!batch) return null;
  return await injectQueriesIntoBatch(batch, t);
}

async function isDbGraph(): Promise<boolean> {
  try {
    return Boolean(await logseq.App.checkCurrentIsDbGraph?.());
  } catch {
    return true;
  }
}

async function upsertTemplateProperty(
  result: Result,
  rootBlockId: string,
  key: string,
  value: string,
  templateName: string,
): Promise<void> {
  if (!logseq.Editor.upsertBlockProperty) return;
  try {
    const upsertValue = await resolveUpsertPropertyValue(key, value);
    if (upsertValue == null) return;
    await logseq.Editor.upsertBlockProperty(rootBlockId, key, upsertValue);
    result.actions.push(`SET template property ${key} on ${templateName}`);
    await sleep(15);
  } catch (error) {
    result.errors.push(`template-property ${templateName}.${key}: ${formatError(error)}`);
  }
}

async function removeTemplateProperty(
  result: Result,
  rootBlockId: string,
  key: string,
  templateName: string,
): Promise<void> {
  if (!logseq.Editor.removeBlockProperty) return;
  try {
    await logseq.Editor.removeBlockProperty(rootBlockId, key);
    result.actions.push(`REMOVE template property ${key} from ${templateName}`);
    await sleep(15);
  } catch (error) {
    const message = formatError(error);
    if (!/not found|missing|does not exist/i.test(message)) {
      result.notes.push(`template-property ${templateName}.${key} not removed: ${message}`);
    }
  }
}

function childHasPropertyLine(children: any[], prop: TemplateProperty): boolean {
  const target = propertyLineText(prop);
  const key = `${prop.key}::`;
  return (children ?? []).some((child) => {
    const content = String(child?.content ?? '').trim();
    return content === target || content.toLowerCase().startsWith(key.toLowerCase());
  });
}

async function insertChildBlock(
  result: Result,
  parentId: string,
  content: string,
  label: string,
  before = false,
): Promise<string | null> {
  if (!logseq.Editor.insertBlock) return null;
  try {
    const inserted = await logseq.Editor.insertBlock(parentId, content, {
      sibling: false,
      before,
      end: !before,
    });
    result.actions.push(label);
    await sleep(THROTTLE_MS);
    return blockId(inserted);
  } catch (error) {
    result.errors.push(`${label}: ${formatError(error)}`);
    return null;
  }
}

function templateChildMatchesView(child: any, view: import('../registry/types').ViewDefinition): boolean {
  const section = sectionNameFromLine(String(child?.content ?? ''));
  const label = queryBlockLabelKey(section || String(child?.content ?? ''));
  return [view.section, queryTitleForView(view)].some((candidate) => queryBlockLabelKey(String(candidate ?? '')) === label);
}

function templateChildMatchesAnyView(child: any, views: import('../registry/types').ViewDefinition[]): boolean {
  return views.some((view) => templateChildMatchesView(child, view));
}

function currentTemplateSourceTags(views: import('../registry/types').ViewDefinition[]): Set<string> {
  const tags = new Set<string>();
  for (const view of views) for (const tag of sourceTagsForView(view)) tags.add(tag);
  return tags;
}

function queryContentUsesCurrentTemplateSource(content: string, currentSources: Set<string>): boolean {
  return sourceTagsFromQueryContent(content).some((tag) => currentSources.has(tag));
}

async function templateQueryUsesCurrentSource(block: any, currentSources: Set<string>): Promise<boolean> {
  const content = await readDashboardQueryBlockContent(block);
  return queryContentUsesCurrentTemplateSource(content, currentSources);
}

function isEmptyTemplatePlaceholder(block: any): boolean {
  const text = String(block?.content ?? block?.title ?? '').trim();
  if (text && text !== '-' && !/^Query intent:/i.test(text)) return false;
  return (block?.children ?? []).every((child: any) => isEmptyTemplatePlaceholder(child));
}

async function templateSectionHasOnlyQueryOrEmptyChildren(block: any): Promise<boolean> {
  for (const child of block?.children ?? []) {
    if (await isQueryLikeBlockAsync(child)) continue;
    if (isEmptyTemplatePlaceholder(child)) continue;
    return false;
  }
  return true;
}

async function removeTemplateBlock(result: Result, block: any, label: string): Promise<boolean> {
  const id = blockId(block);
  if (!id || !logseq.Editor.removeBlock) return false;
  await logseq.Editor.removeBlock(id).catch(() => null);
  result.actions.push(label);
  await sleep(30);
  return true;
}

async function ensureTemplateQueryBlock(
  result: Result,
  rootBlockId: string,
  displayName: string,
  view: import('../registry/types').ViewDefinition,
): Promise<void> {
  const queryContent = await queryContentForView(view);
  if (!queryContent) return;
  const qTitle = queryTitleForView(view);
  const isDb = await isDbGraph();
  const content = isDb && queryContent.startsWith('{') ? qTitle : `${qTitle}\n#Query ${simpleQueryForView(view)}`;
  const insertedId = await insertChildBlock(
    result,
    rootBlockId,
    content,
    `INSERT template query block: ${displayName} / ${qTitle}`,
  );
  if (!insertedId || !isDb || !queryContent.startsWith('{')) return;
  const inserted = await logseq.Editor.getBlock?.(insertedId, { includeChildren: true }).catch(() => null);
  await configureDbAdvancedQueryBlock(result, inserted ?? { uuid: insertedId, content: qTitle }, queryContent);
  await updateBlockContent(result, inserted ?? { uuid: insertedId, content: qTitle }, qTitle, `Set title for query`);
}

async function dedupeTemplateQueryBlocks(
  result: Result,
  rootBlockId: string,
  displayName: string,
  views: import('../registry/types').ViewDefinition[],
): Promise<any> {
  let current = await logseq.Editor.getBlock(rootBlockId, { includeChildren: true });
  if (!logseq.Editor.removeBlock) return current;

  for (const view of views) {
    const matches = (current?.children ?? []).filter((child: any) => templateChildMatchesView(child, view));
    if (matches.length <= 1) continue;
    for (const duplicate of matches.slice(1)) {
      await removeTemplateBlock(
        result,
        duplicate,
        `REMOVE duplicate template query block: ${displayName} / ${queryTitleForView(view)}`,
      );
    }
    current = await logseq.Editor.getBlock(rootBlockId, { includeChildren: true });
  }

  const currentSources = currentTemplateSourceTags(views);
  if (!currentSources.size) return current;
  for (const child of current?.children ?? []) {
    if (templateChildMatchesAnyView(child, views)) continue;
    if (await isQueryLikeBlockAsync(child)) {
      if (await templateQueryUsesCurrentSource(child, currentSources)) {
        await removeTemplateBlock(result, child, `REMOVE stale template query block: ${displayName}`);
      }
      continue;
    }

    const staleQueryChildren = [];
    for (const grandchild of child?.children ?? []) {
      if (!(await isQueryLikeBlockAsync(grandchild))) continue;
      if (await templateQueryUsesCurrentSource(grandchild, currentSources)) {
        staleQueryChildren.push(grandchild);
      }
    }
    if (!staleQueryChildren.length) continue;
    if (await templateSectionHasOnlyQueryOrEmptyChildren(child)) {
      await removeTemplateBlock(result, child, `REMOVE stale template query section: ${displayName}`);
    } else {
      for (const grandchild of staleQueryChildren) {
        await removeTemplateBlock(result, grandchild, `REMOVE stale nested template query block: ${displayName}`);
      }
    }
  }
  current = await logseq.Editor.getBlock(rootBlockId, { includeChildren: true });
  return current;
}

async function syncTemplateStructure(result: Result, rootBlockId: string, t: RegistryTemplate): Promise<void> {
  const displayName = templateNameFromRegistry(t);
  if (!logseq.Editor.getBlock) return;

  let block: any;
  try {
    block = await logseq.Editor.getBlock(rootBlockId, { includeChildren: true });
  } catch (error) {
    result.errors.push(`read template block ${displayName}: ${formatError(error)}`);
    return;
  }

  // Set properties via upsert on the template root block (not as visible text children).
  // This keeps the template definition clean; properties come from RegistryObject.
  const properties = templateProperties(t);
  for (const prop of properties) {
    await ensurePlaceholderPagesForNodeValue(result, prop.key, prop.value);
    await upsertTemplateProperty(result, rootBlockId, prop.key, prop.value, displayName);
  }

  const refreshed = await logseq.Editor.getBlock(rootBlockId, { includeChildren: true });
  const views = viewDefinitionsSafe(t);
  const viewBySection = new Map(views.map((view) => [String(view.section ?? '').trim(), view]));
  const findViewBySectionOrTitle = (name: string) => {
    let view = viewBySection.get(name);
    if (view) return view;
    for (const v of views) {
      const title = queryTitleForView(v);
      if (title === name || v.section === name) return v;
    }
    return undefined;
  };

  for (const sectionBlock of refreshed?.children ?? []) {
    const sectionName = sectionNameFromLine(String(sectionBlock?.content ?? ''));
    if (!sectionName) continue;
    const view = findViewBySectionOrTitle(sectionName);
    const queryContent = view ? await queryContentForView(view) : null;
    if (!queryContent) continue;
    const sectionChildren = sectionBlock?.children ?? [];
    const sectionId = blockId(sectionBlock);
    if (!sectionId) continue;
    const isDb = await isDbGraph();
    const qTitle = queryTitleForView(view);
    if (isDb && queryContent.startsWith('{')) {
      const currentContent = String(sectionBlock?.content ?? '').trim();
      if (currentContent === qTitle) {
        // already the titled block from batch, just configure it
        await configureDbAdvancedQueryBlock(result, sectionBlock, queryContent);
        await updateBlockContent(result, sectionBlock, qTitle, `Set title for query`);
      } else {
        // Convert legacy section-wrapper templates into a titled query block at the same indent.
        for (const ch of sectionChildren) {
          const text = String(ch?.content ?? '').trim();
          if (isQueryLikeContent(text) || text === '-' || !text) {
            if (logseq.Editor.removeBlock) {
              await logseq.Editor.removeBlock(blockId(ch)).catch(() => {});
            }
          }
        }
        await updateBlockContent(result, sectionBlock, qTitle, `Set title for query`);
        await configureDbAdvancedQueryBlock(result, sectionBlock, queryContent);
        await updateBlockContent(result, sectionBlock, qTitle, `Set title for query`);
      }
    } else {
      await updateBlockContent(
        result,
        sectionBlock,
        `${qTitle}\n${queryContent}`,
        `Set titled query for ${sectionName}`,
      );
    }
  }

  const afterExisting = await dedupeTemplateQueryBlocks(result, rootBlockId, displayName, views);
  for (const view of views) {
    if ((afterExisting?.children ?? []).some((child: any) => templateChildMatchesView(child, view))) continue;
    await ensureTemplateQueryBlock(result, rootBlockId, displayName, view);
  }

  // Final pass: ensure all advanced queries in the template have full structure (tags, display-type :code, proper EDN with corrections).
  const isDbFinal = await isDbGraph();
  if (isDbFinal) {
    const refreshedFinal = await logseq.Editor.getBlock(rootBlockId, { includeChildren: true });
    for (const sBlock of refreshedFinal?.children ?? []) {
      const sec = sectionNameFromLine(String(sBlock?.content ?? ''));
      const v = findViewBySectionOrTitle(sec);
      const qC = v ? await queryContentForView(v) : null;
      if (qC && qC.startsWith('{')) {
        await configureDbAdvancedQueryBlock(result, sBlock, qC);
        await updateBlockContent(result, sBlock, queryTitleForView(v), `Set title for query`);
      }
    }
  }
}

async function registerNativeTemplate(
  result: Result,
  rootBlock: any,
  rootBlockId: string,
  t: RegistryTemplate,
): Promise<void> {
  const displayName = templateNameFromRegistry(t);
  const markerId = templateMarkerId(t);

  await updateBlockContent(
    result,
    rootBlock,
    rootContentWithMarker(displayName, markerId),
    `Normalize template root title for ${displayName}`,
  );

  const templateTag = await ensureTagByName(result, 'Template');
  const templateTagId = templateTag ? entityIdentity(templateTag) : null;
  if (logseq.Editor.addBlockTag && templateTagId) {
    try {
      await logseq.Editor.addBlockTag(rootBlockId, templateTagId);
      result.actions.push(`TAG template block: #Template (${displayName})`);
      await sleep(15);
    } catch (error) {
      result.errors.push(`template-block-tag ${displayName}: ${formatError(error)}`);
    }
  }

  await syncTemplateStructure(result, rootBlockId, t);

  const appliesTo = safeTag((t.appliesTo ?? [])[0] ?? '');
  if (appliesTo) {
    await removeTemplateProperty(result, rootBlockId, APPLY_TEMPLATE_TO_TAGS, displayName);
    result.notes.push(
      `DB template ${displayName} is page-materialized by LSS repair/create commands; Apply template to tags is intentionally disabled for #${appliesTo}.`,
    );
  }

  if (!(await isDbGraph()) && logseq.App?.createTemplate) {
    try {
      await logseq.App.createTemplate(rootBlockId, displayName, { overwrite: true });
      result.actions.push(`REGISTER file-graph template: ${displayName}`);
      await sleep(THROTTLE_MS);
    } catch (error) {
      result.errors.push(`createTemplate ${displayName}: ${formatError(error)}`);
    }
    return;
  }

  result.actions.push(`CONFIGURE DB template: ${displayName}`);
}

async function installOneNativeTemplate(
  result: Result,
  pageName: string,
  indexBlockId: string,
  t: RegistryTemplate,
): Promise<void> {
  const displayName = templateNameFromRegistry(t);
  const markerId = templateMarkerId(t);
  const blocks = await getBlocks(pageName);
  const existing = findBlockByMarker(blocks, markerId);
  let rootBlock = existing;
  let rootBlockId = blockId(existing);

  if (!rootBlockId) {
    const batch = await buildEnrichedTemplateBatch(t);
    if (!batch) {
      result.errors.push(`template outline empty: ${displayName}`);
      return;
    }
    const payload = {
      ...batch,
      content: rootContentWithMarker(batch.content, markerId),
    };
    try {
      const inserted = await logseq.Editor.insertBatchBlock(indexBlockId, [payload]);
      rootBlockId = blockId(inserted?.[0]);
      if (!rootBlockId) {
        const refreshed = await getBlocks(pageName);
        rootBlock = findBlockByMarker(refreshed, markerId);
        rootBlockId = blockId(rootBlock);
      } else {
        rootBlock = inserted?.[0] ?? null;
      }
      if (rootBlockId) {
        result.actions.push(`INSERT native template block: ${displayName}`);
        await sleep(THROTTLE_MS);
      } else {
        result.errors.push(`insert template block ${displayName}: no block uuid returned`);
        return;
      }
    } catch (error) {
      result.errors.push(`insert template block ${displayName}: ${formatError(error)}`);
      return;
    }
  } else {
    result.actions.push(`SKIP native template block exists: ${displayName}`);
  }

  if (!rootBlockId || !rootBlock) return;
  await registerNativeTemplate(result, rootBlock, rootBlockId, t);
}

export async function installNativeTemplates(result: Result): Promise<void> {
  const canonical = 'LSS Native Templates';
  const pageName = await ensurePage(result, canonical);
  await appendManagedBlock(result, canonical, 'db-native-template-index-v4', [
    'LSS Native Template Index',
    'DB templates are blocks tagged #Template on this page.',
    'Templates are materialized onto entity pages by LSS repair/create commands, not auto-applied to journal tag blocks.',
    'Re-run lss: 8setup-templates to add missing structure/query blocks on existing templates.',
    `template-count:: ${(registry.templates ?? []).length}`,
  ].join('\n'));

  const blocks = await getBlocks(pageName);
  const indexBlock = findBlockByMarker(blocks, 'db-native-template-index-v4');
  let indexBlockId = blockId(indexBlock);
  if (!indexBlockId) {
    const flat = walkBlocks(blocks);
    indexBlockId = blockId(flat[0]);
  }
  if (!indexBlockId) {
    result.errors.push(`Could not find anchor block on ${pageForCanonical(canonical)} for template installation.`);
    return;
  }

  let registered = 0;
  for (const t of registry.templates ?? []) {
    await installOneNativeTemplate(result, pageName, indexBlockId, t);
    registered++;
  }
  result.notes.push(
    `Installed/verified ${registered} DB templates on ${pageForCanonical(canonical)}. Page properties are generated by entity-page repair/create, and query blocks are verified where views exist.`,
  );
}

export async function installLegacyTemplates(result: Result): Promise<void> {
  const canonical = 'LSS Legacy Templates';
  await ensurePage(result, canonical);
  await appendManagedBlock(result, canonical, 'db-legacy-templates-v2', legacyTemplateText());
  result.notes.push(`Legacy template blocks written to ${pageForCanonical(canonical)}.`);
}
