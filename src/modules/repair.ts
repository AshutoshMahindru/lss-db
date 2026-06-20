import { THROTTLE_MS } from '../config';
import {
  canonicalPropertyKey,
  entityIdentity,
  formatDatePropertyValue,
  formatDatePropertyValueForContent,
  isDateProperty,
  isDbGraph,
  isDbPageRefValue,
  isValidDatePropertyValue,
  looksLikePageEntityId,
  pageHasClassTag,
  parseDatePropertyValue,
  readRelationshipPropertyValue,
  resolveUpsertPropertyValue,
  toJournalDay,
} from '../core/db-properties';
import { defaultPropertyValue, uniqueObjectProps } from './templates';
import { objectByName } from '../registry';
import { enterRepairSession, exitRepairSession, markRepairCooldown, scheduleAutoRepair } from './auto-repair';
import {
  blockId,
  currentPageName,
  ensureTagByName,
  ensurePage,
  getBlocks,
  getPage,
  resolvePageFromIdentity,
  resolveVisibleNodeToken,
  updateBlockContent,
  walkBlocks,
} from '../core/editor';
import { formatError, sleep } from '../core/runner';
import { fixPhantomTagParenSyntax, safePageName, safeTag, tsKey } from '../core/names';
import type { Result } from '../core/types';
import type { RegistryObject } from '../registry/types';
import { allObjects, dashboardPageForObjectType, propertySpec, templateDefByObjectType } from '../registry';
import {
  configureDbAdvancedQueryBlock,
  recreateDbAdvancedQueryBlock,
  forceCreateQueryChild,
  resolveQueryClassTagId,
  dashboardQueryBlockForViewAsync,
  dbAdvancedQueryBlockNeedsStructureRepair,
  filterProps,
  findAllQueryBlocksInSectionAsync,
  inspectDbQueryBlockStructure,
  isAdvancedQueryBlockContent,
  isQueryLikeContent,
  pickCanonicalQueryBlock,
  queryBlockNeedsRepair,
  readDashboardQueryBlockContent,
  repairDbQueryBlockUiKeywords,
  relationshipPropertyNames,
  sectionNameFromLine,
  viewDefinitionsSafe,
} from './queries';
import { removeNativeTagSchemaProperties } from './setup';

function repairPropertyLines(content: string): Array<{ property: string; value: string }> {
  const lines: Array<{ property: string; value: string }> = [];
  for (const line of String(content ?? '').split(/\r?\n/)) {
    const match = line.match(/^\s*-?\s*([A-Za-z0-9_-]+)::\s*(.*)$/);
    if (match) lines.push({ property: match[1], value: String(match[2] ?? '').trim() });
  }
  return lines;
}

function repairTagsFromValue(value: string): string[] {
  const set = new Set<string>();
  const text = String(value ?? '');
  let m: RegExpExecArray | null;
  const wiki = /\[\[([^\]]+)\]\]/g;
  while ((m = wiki.exec(text))) if (m[1]) set.add(safeTag(m[1]));
  const hash = /#([A-Za-z0-9_-]+)/g;
  while ((m = hash.exec(text))) if (m[1]) set.add(safeTag(m[1]));
  return [...set].filter(Boolean);
}

function repairPageRefsFromValue(value: string): string[] {
  const refs: string[] = [];
  const re = /\[\[([^\]]+)\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(String(value ?? '')))) if (m[1]) refs.push(m[1]);
  return refs;
}

function repairSectionNames(blocks: any[]): Set<string> {
  const set = new Set<string>();
  for (const block of walkBlocks(blocks)) {
    const section = sectionNameFromLine(block?.content);
    if (section) set.add(section);
  }
  return set;
}

function harvestInlineLssClassTags(blocks: any[]): Set<string> {
  const tags = new Set<string>();
  const lssTags = new Set(
    allObjects()
      .map((o) => safeTag(o.tag))
      .filter(Boolean)
  );
  // case-insensitive + alias tolerant lookup to the canonical tag casing
  const tagByLower = new Map<string, string>();
  for (const t of lssTags) tagByLower.set(t.toLowerCase(), t);
  for (const block of walkBlocks(blocks)) {
    const text = String(block?.content ?? '');
    // Capture #Venture or #[[Function]] etc from title line or body (create/append/manual tag writes this form).
    const re = /#(?:\[\[([^\]]+?)\]\]|([A-Za-z0-9_ -]+))/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      let cand = safeTag(m[1] || m[2]);
      if (!cand) continue;
      if (lssTags.has(cand)) {
        tags.add(cand);
        continue;
      }
      const lower = cand.toLowerCase();
      if (tagByLower.has(lower)) {
        tags.add(tagByLower.get(lower)!);
        continue;
      }
      // try canonical alias resolution (e.g. #venture -> Venture)
      const canon = canonicalObjectTypeToken(cand);
      if (canon) {
        const o = objectByName(canon);
        const t = o ? safeTag(o.tag) : null;
        if (t && lssTags.has(t)) tags.add(t);
      }
    }
  }
  return tags;
}

function isPropertiesListBlock(content: string, schemaProps: Set<string>): boolean {
  const text = String(content ?? '').trim();
  if (!text) return false;
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return false;
  let propCount = 0;
  for (const line of lines) {
    if (/::/.test(line) && Array.from(schemaProps).some((k) => line.toLowerCase().startsWith(k.toLowerCase() + '::') || line.toLowerCase().startsWith(k.toLowerCase() + ' ::'))) {
      propCount++;
    }
  }
  const ratio = propCount / lines.length;
  const coverage = Array.from(schemaProps).filter((k) => text.toLowerCase().includes(k.toLowerCase() + '::')).length;
  return ratio >= 0.6 || coverage >= Math.min(2, schemaProps.size);
}

function canonicalObjectTypeToken(token: string): string | null {
  let raw = String(token ?? '')
    .replace(/^#/, '')
    .replace(/^\[\[/, '')
    .replace(/\]\]$/, '')
    .replace(/[\s)\]\}]+$/, '')
    .trim();
  if (!raw) return null;
  raw = safePageName(raw);
  const obj = objectByName(raw);
  if (obj) return obj.name;
  const key = String(raw).toLowerCase().replace(/[\s_-]+/g, '');
  const aliases: Record<string, string> = {
    venture: 'Venture',
    ventures: 'Venture',
    function: 'Function',
    functions: 'Function',
    workstream: 'WorkStream',
    workstreams: 'WorkStream',
    project: 'Project',
    projects: 'Project',
    person: 'Person',
    people: 'Person',
    organisation: 'Organisation',
    organization: 'Organisation',
    document: 'Document',
    file: 'File',
    condition: 'Condition',
    subject: 'Subject',
    pursuit: 'Pursuit',
  };
  return aliases[key] ?? null;
}

function inferObjectTypeFromPromotedState(tags: Set<string>, props: Map<string, string>): string | null {
  for (const tag of tags) {
    const type = canonicalObjectTypeToken(tag);
    if (type) return type;
  }
  for (const key of ['lss-object-type', 'object-type', 'type', 'entity-type']) {
    const value = props.get(key);
    if (!value) continue;
    for (const tag of repairTagsFromValue(value)) {
      const type = canonicalObjectTypeToken(tag);
      if (type) return type;
    }
    const direct = canonicalObjectTypeToken(value);
    if (direct) return direct;
  }
  return null;
}

function inferCurrentPageObjectType(pageName: string, blocks: any[]): string | null {
  const sections = repairSectionNames(blocks);
  if (sections.has('Functions') && sections.has('Projects') && sections.has('Workstreams')) return 'Venture';
  if (sections.has('Responsibilities') && sections.has('Related venture')) return 'Function';
  if (sections.has('Outcome') && sections.has('Scope') && sections.has('Next actions')) return 'Project';
  if (sections.has('Interactions') && sections.has('Commitments')) return 'Person';
  if (sections.has('Treatments') && sections.has('Symptoms')) return 'Condition';
  if (sections.has('Courses') && sections.has('Lessons') && sections.has('Concepts')) return 'Subject';
  return null;
}

function pageNamesEquivalent(a: string, b: string): boolean {
  const norm = (value: string) => safePageName(value).toLowerCase();
  return norm(a) === norm(b);
}

function relationshipValueReferencesPage(value: unknown, pageName: string, pageId: unknown): boolean {
  const test = (item: unknown): boolean => {
    if (item == null) return false;
    if (typeof item === 'number') return pageId != null && String(item) === String(pageId);
    if (typeof item === 'object') {
      const record = item as Record<string, unknown>;
      const id = record.id ?? record.dbId ?? record[':db/id'];
      if (id != null && pageId != null && String(id) === String(pageId)) return true;
      const name = String(record.name ?? record.originalName ?? record.title ?? '').trim();
      return name ? pageNamesEquivalent(name, pageName) : false;
    }
    const raw = String(item).trim();
    if (!raw) return false;
    if (/^\d+$/.test(raw) && pageId != null) return raw === String(pageId);
    const wiki = raw.match(/^\[\[([^\]]+)\]\]$/);
    return pageNamesEquivalent(wiki?.[1] ?? raw, pageName);
  };
  return Array.isArray(value) ? value.some(test) : test(value);
}

async function readCanonicalBlockProperty(blockIdentity: string, property: string): Promise<unknown> {
  const readFrom = (props: Record<string, unknown> | null | undefined): unknown => {
    if (!props) return undefined;
    for (const [key, value] of Object.entries(props)) {
      if (canonicalPropertyKey(key) === property) return value;
    }
    return undefined;
  };
  if (logseq.Editor.getBlockProperties) {
    const hit = readFrom((await logseq.Editor.getBlockProperties(blockIdentity).catch(() => null)) ?? undefined);
    if (hit !== undefined) return hit;
  }
  if (logseq.Editor.getBlock) {
    const block = await logseq.Editor.getBlock(blockIdentity).catch(() => null);
    const hit = readFrom((block as Record<string, unknown> | null)?.properties as Record<string, unknown> | undefined);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

async function inferVentureFromIncomingFunctions(
  pageName: string,
  pageBlockId: string,
  result: Result,
): Promise<boolean> {
  if (!logseq.Editor.getTagObjects) return false;
  const page = await resolvePageFromIdentity(pageBlockId).catch(() => null);
  const pageId = (page as Record<string, unknown> | null)?.id;
  const functions = await logseq.Editor.getTagObjects('Function').catch(() => null);
  for (const fn of functions ?? []) {
    const fnBlockId = blockId(fn);
    if (!fnBlockId) continue;
    const relationshipValue = await readRelationshipPropertyValue(fnBlockId, 'venture');
    const visibleValue = await readCanonicalBlockProperty(fnBlockId, 'venture');
    if (
      relationshipValueReferencesPage(relationshipValue, pageName, pageId) ||
      relationshipValueReferencesPage(visibleValue, pageName, pageId)
    ) {
      result.notes.push(
        `Inferred Venture from incoming Function venture reference on ${String((fn as Record<string, unknown>).uuid ?? fnBlockId)}.`,
      );
      return true;
    }
  }
  return false;
}

const RELATIONSHIP_PROPERTIES = new Set(relationshipPropertyNames());
const SKIP_PROMOTE_KEYS = new Set(['tags', 'block/tags']);

function relationshipNamesFromRepairValue(value: string): string[] {
  const text = String(value ?? '').trim();
  if (!text) return [];
  const refs = repairPageRefsFromValue(text).map((x) => x.trim()).filter(Boolean);
  if (refs.length) return refs;
  if (text.includes('#') || /^https?:/i.test(text)) return [];
  return text
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .split(',')
    .map((x) => x.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
}

async function resolveRelationshipRepairValueToRefs(value: string): Promise<string> {
  const names = relationshipNamesFromRepairValue(value);
  if (!names.length) return value;
  const refs: string[] = [];
  for (const name of names) {
    const page =
      (await getPage(name)) ||
      (await getPage(safePageName(name))) ||
      (await getPage(name.toLowerCase()));
    if (!page) {
      refs.push(name.startsWith('[[') ? name : `[[${safePageName(name)}]]`);
      continue;
    }
    const visible = String(page.originalName ?? page.name ?? page.title ?? name).trim();
    refs.push(`[[${safePageName(visible)}]]`);
  }
  return refs.join(', ');
}

function pageRefsInBlocks(blocks: any[]): string[] {
  const refs = new Set<string>();
  for (const block of walkBlocks(blocks)) {
    const text = String(block?.content ?? block?.title ?? '');
    for (const ref of repairPageRefsFromValue(text)) refs.add(ref);
  }
  return [...refs];
}

function isSetupTargetTagNoise(name: string, props: Record<string, unknown>): boolean {
  const label = safePageName(name);
  if (props['lss-kind'] != null || props[':plugin.property.logseq-lss-db-final-plugin/lss-kind'] != null) return true;
  if (/^(Entity-Page|DB Tag|Tag Properties|Template|Word Extender|LSS Reports|Area)(?:\b| - |:)/i.test(label)) return true;
  if (/Entity Schema Page|Naming Rule|Template Reference|Tag Properties:/i.test(label)) return true;
  return false;
}

async function pageHasTargetTag(pageName: string, targetType: string): Promise<boolean> {
  const page = (await getPage(pageName)) || (await getPage(safePageName(pageName))) || (await getPage(pageName.toLowerCase()));
  const pageId = blockId(page);
  return pageId ? pageHasClassTag(pageId, targetType) : false;
}

async function candidateRefsFromPageLinks(blocks: any[], targetType: string): Promise<string[]> {
  const out: string[] = [];
  for (const ref of pageRefsInBlocks(blocks)) {
    if (await pageHasTargetTag(ref, targetType)) out.push(ref);
  }
  return [...new Set(out)];
}

async function candidateRefsFromTaggedPages(targetType: string): Promise<string[]> {
  if (!logseq.Editor.getTagObjects) return [];
  const objects = await logseq.Editor.getTagObjects(targetType).catch(() => null);
  const refs: string[] = [];
  for (const item of objects ?? []) {
    const record = item as Record<string, unknown>;
    const label = String(record.originalName ?? record.name ?? record.title ?? '').trim();
    const page =
      (label ? await getPage(label) : null) ||
      (record.id != null ? await resolvePageFromIdentity(record.id as string | number) : null) ||
      (blockId(item) ? await resolvePageFromIdentity(blockId(item)!) : null);
    const visible = String(
      (page as Record<string, unknown> | null)?.originalName ??
        (page as Record<string, unknown> | null)?.name ??
        (page as Record<string, unknown> | null)?.title ??
        label,
    ).trim();
    if (visible && !isSetupTargetTagNoise(visible, ((page as Record<string, unknown> | null)?.properties ?? {}) as Record<string, unknown>)) {
      refs.push(visible);
    }
  }
  return [...new Set(refs)];
}

async function inferMissingRequiredRelationshipProps(
  result: Result,
  obj: RegistryObject,
  props: Map<string, string>,
  blocks: any[],
  pageName: string,
): Promise<void> {
  for (const key of uniqueObjectProps(obj)) {
    if (String(props.get(key) ?? '').trim()) continue;
    const spec = propertySpec(key);
    if (String(spec?.type ?? '').toLowerCase() !== 'node') continue;
    const targets = ((spec as { targets?: unknown[] } | undefined)?.targets ?? []).map(String).filter(Boolean);
    if (!targets.length) continue;

    const candidates = new Set<string>();
    for (const target of targets) {
      for (const ref of await candidateRefsFromPageLinks(blocks, target)) candidates.add(ref);
    }

    if (candidates.size === 0 && (obj.requiredProperties ?? []).includes(key)) {
      for (const target of targets) {
        for (const ref of await candidateRefsFromTaggedPages(target)) candidates.add(ref);
      }
    }

    if (candidates.size === 1) {
      const ref = [...candidates][0];
      props.set(key, `[[${safePageName(ref)}]]`);
      result.actions.push(`INFERRED missing relationship ${key} for ${pageName}: [[${safePageName(ref)}]]`);
    } else if (candidates.size > 1 && (obj.requiredProperties ?? []).includes(key)) {
      result.notes.push(
        `Could not infer required relationship ${key} for ${pageName}; candidates: ${[...candidates].map((ref) => `[[${safePageName(ref)}]]`).join(', ')}`,
      );
    }
  }
}

async function normalizeRelationshipPropsForRepair(result: Result, props: Map<string, string>): Promise<void> {
  for (const [key, value] of [...props.entries()]) {
    const shortKey = canonicalPropertyKey(key);
    if (!RELATIONSHIP_PROPERTIES.has(shortKey)) continue;
    const raw = String(value ?? '').trim();
    if (!raw) continue;
    const normalized = await resolveRelationshipRepairValueToRefs(raw);
    if (normalized && normalized !== raw) {
      props.set(shortKey, normalized);
      result.actions.push(`NORMALIZED relationship property ${shortKey}: ${normalized}`);
    }
  }
}

function pageRecordIsJournal(page: any, pageName: string): boolean {
  if (!page) return false;
  const type = String(page.type ?? page[':block/type'] ?? '').toLowerCase();
  if (type === 'journal') return true;
  if (page.journal === true || page['journal?'] === true || page[':block/journal?'] === true) return true;
  if (page.journalDay != null || page['journal-day'] != null || page[':block/journal-day'] != null) return true;
  const name = String(pageName ?? page.name ?? page.originalName ?? page.title ?? '').trim();
  return /^\d{4}[-_/]\d{2}[-_/]\d{2}$/.test(name);
}

function tagNameFromObject(tag: unknown): string | null {
  if (typeof tag === 'string') return safeTag(tag);
  if (tag && typeof tag === 'object') {
    const record = tag as Record<string, unknown>;
    const name = record.name ?? record.originalName ?? record.title ?? record.ident;
    if (name) return safeTag(String(name));
  }
  return null;
}

function blockLssObject(block: any): RegistryObject | null {
  const text = String(block?.content ?? block?.title ?? '');
  if (/#Template\b/i.test(text)) return null;
  const candidates = new Set<string>();
  const tags = block?.tags ?? block?.properties?.tags;
  if (Array.isArray(tags)) {
    for (const tag of tags) {
      const name = tagNameFromObject(tag);
      if (name) candidates.add(name);
    }
  }
  for (const tag of repairTagsFromValue(text)) candidates.add(tag);
  for (const candidate of candidates) {
    const type = canonicalObjectTypeToken(candidate);
    if (!type) continue;
    const obj = objectByName(type);
    if (obj?.nodeKind === 'page') return obj;
  }
  return null;
}

function stripEntityTagsFromTitle(content: string, obj: RegistryObject): string {
  const tag = safeTag(obj.tag);
  return String(content ?? '')
    .split(/\r?\n/)[0]
    .replace(/^[-*]\s+/, '')
    .replace(new RegExp(`#\\[\\[${tag}\\]\\]`, 'gi'), '')
    .replace(new RegExp(`#${tag}\\b`, 'gi'), '')
    .replace(/#Template\b/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim();
}

function entityPageNameFromBlock(block: any, obj: RegistryObject): string {
  const rawTitle = stripEntityTagsFromTitle(String(block?.content ?? block?.title ?? ''), obj)
    .replace(/\s+/g, ' ')
    .trim();
  if (rawTitle && rawTitle !== obj.name && !/::$/.test(rawTitle)) return safePageName(rawTitle);
  return `New ${obj.name} - ${tsKey()}`;
}

function blockChildrenOutline(block: any, rootTitle: string, obj: RegistryObject): string {
  const lines: string[] = [`${rootTitle} #${safeTag(obj.tag)}`];
  const walk = (children: any[], depth: number) => {
    for (const child of children ?? []) {
      const content = String(child?.content ?? child?.title ?? '').trim();
      if (content) lines.push(`${'  '.repeat(depth)}- ${content}`);
      walk(child?.children ?? [], depth + 1);
    }
  };
  walk(block?.children ?? [], 1);
  return lines.join('\n');
}

function templateOutlineForEntityPage(obj: RegistryObject, title: string): string {
  const template = templateDefByObjectType(obj.name);
  const tag = safeTag(obj.tag);
  if (!template?.body) return `${title} #${tag}\n\nProperties\n\nNotes\n- `;
  const bodyLines = String(template.body)
    .split(/\r?\n/)
    .filter((line) => line.trim());
  const out: string[] = [`${title} #${tag}`];
  for (const line of bodyLines.slice(1)) out.push(line);
  return out.join('\n');
}

async function materializedPropertyMap(
  result: Result,
  block: any,
  sourceBlockId: string | null,
  obj: RegistryObject,
): Promise<Map<string, string>> {
  const props = new Map<string, string>();
  const schemaProps = new Set(uniqueObjectProps(obj));
  for (const key of schemaProps) props.set(key, defaultPropertyValue(key, obj) || '');
  for (const item of walkBlocks([block])) {
    for (const line of repairPropertyLines(item?.content)) {
      const key = canonicalPropertyKey(line.property);
      if (schemaProps.has(key) || key === 'lss-object-type') props.set(key, line.value);
    }
  }
  if (sourceBlockId && logseq.Editor.getBlockProperties) {
    const sourceProps =
      ((await logseq.Editor.getBlockProperties(sourceBlockId).catch(() => null)) ?? {}) as Record<string, unknown>;
    for (const [rawKey, rawValue] of Object.entries(sourceProps)) {
      const key = canonicalPropertyKey(rawKey);
      if (!schemaProps.has(key) && key !== 'lss-object-type') continue;
      const value = await dbPropertyValueToRepairString(result, key, rawValue);
      if (value) props.set(key, value);
    }
  }
  props.set('lss-object-type', obj.name);
  return props;
}

async function cleanJournalEntitySourceBlock(
  result: Result,
  block: any,
  sourceBlockId: string | null,
  pageName: string,
  obj: RegistryObject,
): Promise<void> {
  if (!sourceBlockId) return;
  const tagObj = await ensureTagByName(result, safeTag(obj.tag));
  const tagId = tagObj ? entityIdentity(tagObj) : null;
  if (tagId != null && logseq.Editor.removeBlockTag) {
    await logseq.Editor.removeBlockTag(sourceBlockId, tagId).catch(() => null);
  }
  if (logseq.Editor.removeBlockProperty) {
    for (const key of [...uniqueObjectProps(obj), 'lss-object-type', 'lss-object-tag']) {
      await logseq.Editor.removeBlockProperty(sourceBlockId, canonicalPropertyKey(key)).catch(() => null);
    }
  }
  await updateBlockContent(result, block, `[[${pageName}]]`, `Replace journal entity tag block with page link for ${pageName}`);
}

async function materializeJournalEntityBlocks(
  result: Result,
  journalPageName: string,
  blocks: any[],
): Promise<number> {
  let count = 0;
  for (const block of walkBlocks(blocks)) {
    const obj = blockLssObject(block);
    if (!obj) continue;
    const sourceBlockId = blockId(block);
    const entityPageName = entityPageNameFromBlock(block, obj);
    const props = await materializedPropertyMap(result, block, sourceBlockId, obj);
    await ensurePage(result, entityPageName, Object.fromEntries(props));
    const page = await getPage(entityPageName);
    const pageBlockId = blockId(page);
    if (pageBlockId) {
      await repairApplyTagToPage(result, pageBlockId, safeTag(obj.tag));
      for (const [key, value] of props) await repairUpsertPageProperty(result, pageBlockId, key, value);
    }
    const body =
      block?.children?.length
        ? blockChildrenOutline(block, entityPageName, obj)
        : templateOutlineForEntityPage(obj, entityPageName);
    await ensurePage(result, entityPageName);
    if (logseq.Editor.appendBlockInPage) {
      const existing = await getBlocks(entityPageName);
      const marker = `lss-managed:journal-materialized-${sourceBlockId ?? safeTag(obj.tag)}`;
      if (!walkBlocks(existing).some((b) => String(b?.content ?? '').includes(marker))) {
        await logseq.Editor.appendBlockInPage(entityPageName, `${body}\n\n<!-- ${marker} -->`).catch((error: unknown) => {
          result.errors.push(`materialize journal entity ${entityPageName}: ${formatError(error)}`);
        });
      }
    }
    await cleanJournalEntitySourceBlock(result, block, sourceBlockId, entityPageName, obj);
    await repairNamedPage(result, entityPageName, obj.name);
    result.actions.push(`MATERIALIZED journal ${journalPageName} ${obj.name} block as page ${entityPageName}`);
    count++;
  }
  if (count === 0) {
    result.notes.push(`Journal page ${journalPageName} has no materializable LSS entity-tagged blocks.`);
  } else {
    result.notes.push(`Materialized ${count} LSS entity block(s) from journal ${journalPageName} to entity pages.`);
  }
  return count;
}

function normalizePropertyValueForCompare(value: unknown): string {
  if (value == null) return '';
  if (Array.isArray(value)) {
    return value
      .map((item) => normalizePropertyValueForCompare(item))
      .filter(Boolean)
      .sort()
      .join('|');
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (record.id != null) return `id:${record.id}`;
    if (record.uuid != null) return `uuid:${record.uuid}`;
    const name = record.name ?? record.originalName ?? record.title;
    if (name) return `name:${String(name).trim().toLowerCase()}`;
  }
  return String(value).trim().toLowerCase();
}

function extractNodeIds(value: unknown): string[] {
  if (value == null) return [];
  if (Array.isArray(value)) return value.flatMap((item) => extractNodeIds(item));
  if (typeof value === 'number') return [String(value)];
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (record.id != null) return [String(record.id)];
  }
  const raw = String(value).trim();
  if (/^\d+$/.test(raw)) return [raw];
  return [];
}

function propertyValuesEquivalent(current: unknown, next: unknown, shortKey?: string): boolean {
  if (shortKey && isDateProperty(shortKey)) {
    const currentMs = parseDatePropertyValue(current);
    // next may be a journal-day int (from resolve) or raw; always normalize via parser
    const nextMs = parseDatePropertyValue(next);
    if (currentMs != null && nextMs != null) return currentMs === nextMs;
  }
  const nodeSpec = propertySpec(shortKey ?? '');
  if (String(nodeSpec?.type ?? '').toLowerCase() === 'node') {
    const curIds = extractNodeIds(current);
    const nextIds = extractNodeIds(next);
    if (curIds.length && nextIds.length) {
      return curIds.slice().sort().join('|') === nextIds.slice().sort().join('|');
    }
  }
  return normalizePropertyValueForCompare(current) === normalizePropertyValueForCompare(next);
}

async function upsertBlockPropertyWithRetry(
  pageBlockId: string,
  shortKey: string,
  upsertValue: unknown,
  opts?: { reset?: boolean },
  attempts = 4,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      await logseq.Editor.upsertBlockProperty!(pageBlockId, shortKey, upsertValue, opts);
      return;
    } catch (error) {
      lastError = error;
      const msg = formatError(error);
      // Date schema errors ("should be a journal date") are non-recoverable by retrying the same value.
      // Let the caller decide (we now pass correct journal-day ints).
      if (/journal date|invalid value|should be a/i.test(msg)) {
        throw error;
      }
      if (attempt + 1 < attempts && /timeout/i.test(msg)) {
        await sleep(400 * (attempt + 1));
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}

async function readCurrentBlockProperty(pageBlockId: string, shortKey: string): Promise<unknown> {
  if (RELATIONSHIP_PROPERTIES.has(shortKey)) {
    const rel = await readRelationshipPropertyValue(pageBlockId, shortKey);
    if (rel !== undefined) return rel;
  }
  const readFrom = (props: Record<string, unknown> | null | undefined): unknown => {
    if (!props) return undefined;
    for (const [key, value] of Object.entries(props)) {
      if (canonicalPropertyKey(key) === shortKey) return value;
    }
    return undefined;
  };
  if (logseq.Editor.getBlockProperties) {
    try {
      const hit = readFrom((await logseq.Editor.getBlockProperties(pageBlockId).catch(() => null)) ?? undefined);
      if (hit !== undefined) return hit;
    } catch {
      /* ignore */
    }
  }
  if (logseq.Editor.getBlock) {
    try {
      const block = await logseq.Editor.getBlock(pageBlockId).catch(() => null);
      const hit = readFrom((block as Record<string, unknown> | null)?.properties as Record<string, unknown> | undefined);
      if (hit !== undefined) return hit;
    } catch {
      /* ignore */
    }
  }
  return undefined;
}

async function dbPropertyValueToRepairString(
  result: Result,
  key: string,
  value: unknown,
): Promise<string> {
  if (value == null) return '';
  if (Array.isArray(value)) {
    const parts = await Promise.all(value.map((item) => dbPropertyValueToRepairString(result, key, item)));
    return parts.filter(Boolean).join(', ');
  }
  const shortKey = canonicalPropertyKey(key);
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (isDateProperty(shortKey)) {
      const label = String(record.name ?? record.originalName ?? record.title ?? '').trim();
      const fromLabel = label ? formatDatePropertyValue(parseDatePropertyValue(label) ?? parseDatePropertyValue(`[[${label}]]`)) : '';
      const fromObject =
        fromLabel ||
        formatDatePropertyValue(record.createdAt) ||
        formatDatePropertyValue(record[':logseq.property/created-at']);
      if (fromObject) return fromObject;
    }
    const name = record.name ?? record.originalName ?? record.content ?? record.title;
    if (name) return `[[${safePageName(String(name))}]]`;
    const id = record.id ?? record.uuid;
    if (id) {
      const resolved = await resolveVisibleNodeToken(result, String(id));
      return `[[${safePageName(resolved)}]]`;
    }
    return String(value);
  }
  const raw = String(value).trim();
  if (!raw) return '';
  if (isDateProperty(shortKey)) {
    const formatted = formatDatePropertyValue(raw);
    if (formatted) return formatted;
    if (raw.startsWith('[[')) return raw;
  }
  if (raw.startsWith('[[')) return raw;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) {
    const resolved = await resolveVisibleNodeToken(result, raw);
    return `[[${safePageName(resolved)}]]`;
  }
  if (looksLikePageEntityId(raw)) {
    const resolved = await resolveVisibleNodeToken(result, raw);
    return `[[${safePageName(resolved)}]]`;
  }
  if (RELATIONSHIP_PROPERTIES.has(shortKey) && !raw.includes('[[') && !raw.includes('#') && !/^https?:/i.test(raw)) {
    const parts = raw.split(',').map((x) => x.trim()).filter(Boolean);
    return parts.map((x) => `[[${safePageName(x)}]]`).join(', ');
  }
  return raw;
}

async function readDbPagePropertyMap(
  result: Result,
  pageName: string,
  pageBlockId: string,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const sources: Array<Record<string, unknown> | null> = [];
  try {
    if (logseq.Editor.getPageProperties) {
      sources.push(await logseq.Editor.getPageProperties(pageName).catch(() => null));
    }
  } catch {
    /* ignore */
  }
  try {
    if (logseq.Editor.getBlockProperties) {
      sources.push(await logseq.Editor.getBlockProperties(pageBlockId).catch(() => null));
    }
  } catch {
    /* ignore */
  }
  for (const src of sources) {
    if (!src) continue;
    for (const [key, value] of Object.entries(src)) {
      if (key === 'tags' || canonicalPropertyKey(key) === 'tags') continue;
      const shortKey = canonicalPropertyKey(key);
      const str = await dbPropertyValueToRepairString(result, shortKey, value);
      if (str) map.set(shortKey, str);
    }
  }
  return map;
}

async function readDbPageTags(result: Result, pageBlockId: string, page: any): Promise<Set<string>> {
  const tags = new Set<string>();
  const pageProps = page?.properties ?? {};
  if (pageProps.tags) {
    for (const tag of repairTagsFromValue(String(pageProps.tags))) tags.add(tag);
  }
  try {
    const block = logseq.Editor.getBlock ? await logseq.Editor.getBlock(pageBlockId).catch(() => null) : null;
    if (block) {
      const blockRecord = block as Record<string, unknown>;
      const blockTags = blockRecord.tags ?? (blockRecord.properties as Record<string, unknown> | undefined)?.tags;
      if (Array.isArray(blockTags)) {
        for (const tag of blockTags) {
          if (typeof tag === 'string') {
            tags.add(safeTag(tag));
            continue;
          }
          const record = tag as Record<string, unknown>;
          const name = record.name ?? record.originalName ?? record.content ?? record.title;
          if (name) tags.add(safeTag(String(name)));
        }
      } else if (blockTags) {
        for (const tag of repairTagsFromValue(String(blockTags))) tags.add(tag);
      }
    }
  } catch {
    /* ignore */
  }
  return tags;
}

async function gatherPageRepairState(
  result: Result,
  pageName: string,
  pageBlockId: string,
  page: any,
  blocks: any[],
): Promise<{ props: Map<string, string>; tags: Set<string> }> {
  const props = new Map<string, string>();
  const tags = new Set<string>();

  for (const block of walkBlocks(blocks)) {
    for (const line of repairPropertyLines(block?.content)) {
      if (line.property === 'tags') {
        for (const tag of repairTagsFromValue(line.value)) tags.add(tag);
      } else if (!props.has(line.property)) {
        props.set(line.property, line.value);
      }
    }
  }

  // Harvest inline #LSSClass tags (e.g. title "FTV #Venture") so repair promotes via addBlockTag.
  // Class tags drive DB (tags "Venture") queries; RegistryObject props are materialized on the page root.
  for (const t of harvestInlineLssClassTags(blocks)) {
    tags.add(t);
  }

  const dbProps = await readDbPagePropertyMap(result, pageName, pageBlockId);
  for (const [key, value] of dbProps) {
    if (!props.has(key)) props.set(key, value);
  }

  const dbTags = await readDbPageTags(result, pageBlockId, page);
  for (const tag of dbTags) tags.add(tag);

  return { props, tags };
}

async function inferObjectTypeForPage(
  pageBlockId: string,
  tags: Set<string>,
  props: Map<string, string>,
): Promise<string | null> {
  const fromState = inferObjectTypeFromPromotedState(tags, props);
  if (fromState) return fromState;
  const identity = entityIdentity(pageBlockId);
  if (!identity) return null;
  for (const obj of allObjects()) {
    const tag = safeTag(obj.tag);
    if (!tag) continue;
    if (tags.has(tag) || (await pageHasClassTag(identity, tag))) return obj.name;
  }
  return null;
}

async function ensureObjectTypeFromTags(
  pageBlockId: string,
  tags: Set<string>,
  props: Map<string, string>,
  result: Result,
): Promise<string | null> {
  const fromTags = await inferObjectTypeForPage(pageBlockId, tags, props);
  if (!fromTags) return null;
  const existing = props.get('lss-object-type');
  if (!existing || !canonicalObjectTypeToken(existing)) {
    props.set('lss-object-type', fromTags);
    result.notes.push(`Inferred lss-object-type:: ${fromTags} from page class/tag #${fromTags}.`);
  }
  return fromTags;
}

async function inferObjectTypeForRepairPage(
  pageName: string,
  pageBlockId: string,
  blocks: any[],
  tags: Set<string>,
  props: Map<string, string>,
  result: Result,
): Promise<string | null> {
  const fromTags = await ensureObjectTypeFromTags(pageBlockId, tags, props, result);
  if (fromTags) return fromTags;

  const fromSections = inferCurrentPageObjectType(pageName, blocks);
  const fromIncoming = fromSections ? null : (await inferVentureFromIncomingFunctions(pageName, pageBlockId, result)) ? 'Venture' : null;
  const inferred = fromSections ?? fromIncoming;
  if (!inferred) return null;
  const obj = objectByName(inferred);
  const tag = obj ? safeTag(obj.tag) : safeTag(inferred);
  if (tag) tags.add(tag);
  if (!props.get('lss-object-type')) props.set('lss-object-type', inferred);
  result.notes.push(
    `Inferred lss-object-type:: ${inferred} from ${fromSections ? 'page sections' : 'incoming Function references'}; bootstrapping page tag #${tag || inferred}.`,
  );
  return inferred;
}

async function repairPageCore(
  result: Result,
  pageName: string,
  pageBlockId: string,
  blocks: any[],
  typeHint: string | null,
  label: string,
): Promise<{ objectType: string | null; repaired: number; linked: number; resolvedTags: Set<string>; props: Map<string, string> }> {
  const page = await getPage(pageName);
  const { props, tags } = await gatherPageRepairState(result, pageName, pageBlockId, page, blocks);
  const inferredType = await inferObjectTypeForRepairPage(pageName, pageBlockId, blocks, tags, props, result);

  // === TAG IS SOLE SCHEMA SOURCE (post "bigger pass" cleanup) ===
  // After inferring type from the (primary) tag, ensure every property declared
  // on the RegistryObject is present on the instance. Templates no longer contribute
  // any property schema lines (bodies stripped + logic ignores body for props).

  if (inferredType) {
    const obj = objectByName(inferredType);
    if (obj) {
      for (const key of uniqueObjectProps(obj)) {
        if (String(props.get(key) ?? '').trim()) {
          result.actions.push(`SKIP canonical property already present from #${inferredType}: ${key}`);
          continue;
        }
        const def = defaultPropertyValue(key, obj);
        props.set(key, def || '');
        result.notes.push(`Ensured canonical property from #${inferredType}: ${key}`);
      }
      await inferMissingRequiredRelationshipProps(result, obj, props, blocks, pageName);
    }
  }

  await normalizeRelationshipPropsForRepair(result, props);

  // Clean invalid node relationship values (e.g. wrong Venture id or unresolvable text)
  // via plugin when user cannot manually remove the property in UI.
  for (const relProp of RELATIONSHIP_PROPERTIES) {
    const curVal = await readCurrentBlockProperty(pageBlockId, relProp);
    if (curVal == null) continue;
    const ids = extractNodeIds(curVal);
    let valid = false;
    for (const id of ids) {
      const p = await resolvePageFromIdentity(id).catch(() => null);
      if (p) {
        const pId = entityIdentity(p) || id;
        if (relProp === 'venture') {
          if (await pageHasClassTag(pId, 'Venture')) {
            valid = true;
            break;
          }
        } else {
          valid = true;
          break;
        }
      }
    }
    if (!valid && ids.length > 0) {
      result.notes.push(
        `Preserved ${relProp} numeric node ref(s) on ${pageName}; Logseq API did not resolve ${ids.join(', ')} during repair.`,
      );
      continue;
    }
    if (!valid) {
      if (logseq.Editor.removeBlockProperty) {
        await logseq.Editor.removeBlockProperty(pageBlockId, relProp).catch(() => null);
        result.actions.push(`CLEARED invalid ${relProp} on ${pageName}`);
      }
    }
  }

  // Hoist schemaProps + propLines (for clean skipping + list visibility ensure).
  // RegistryObject defines the schema; the list is derived for visibility on the entity page root only.
  const schemaProps = new Set<string>();
  if (inferredType) {
    const obj = objectByName(inferredType);
    if (obj) {
      for (const k of uniqueObjectProps(obj)) schemaProps.add(k);
    }
  } else {
    for (const o of allObjects()) {
      for (const k of uniqueObjectProps(o)) schemaProps.add(k);
    }
  }
  let propLines = '';
  if (inferredType) {
    const obj = objectByName(inferredType);
    if (obj) {
      propLines = uniqueObjectProps(obj)
        .map((key) => {
          const val = props.get(key) || defaultPropertyValue(key, obj) || '';
          return `${key}:: ${val}`;
        })
        .join('\n');
    }
  }

  const resolvedTags = await repairResolveTagSet(result, tags);
  for (const tag of resolvedTags) await repairApplyTagToPage(result, pageBlockId, tag);
  const propEntries = [...props.entries()]
    .filter(([prop]) => !SKIP_PROMOTE_KEYS.has(prop) && !prop.startsWith('block/'))
    .sort(([a], [b]) => {
      const aDate = isDateProperty(a) ? 0 : 1;
      const bDate = isDateProperty(b) ? 0 : 1;
      return aDate - bDate;
    });
  for (const [prop, value] of propEntries) {
    await repairUpsertPageProperty(result, pageBlockId, prop, value);
    if (isDateProperty(prop)) {
      await sleep(100);
      if (await isDbGraph()) {
        // Always try to clean [[date]] in content lines on DB so the date text is directly visible
        for (const b of walkBlocks(blocks)) {
          await normalizeDatePropertyLineInContent(result, b, prop);
        }
      }
    }
  }

  // Clean schema prop lines from content for LSS objects/blocks (so properties are only page properties via upsert, not visible in content or on journal).
  // Skip pure properties-list blocks so the visibility list on entity pages is preserved.
  if (schemaProps.size > 0) {
    for (const block of walkBlocks(blocks)) {
      const c = String(block?.content ?? '');
      if (isPropertiesListBlock(c, schemaProps)) {
        continue;
      }
      let content = c;
      const original = content;
      for (const key of schemaProps) {
        const re = new RegExp(`(^|\\n)\\s*${key}::[^\\n]*`, 'gi');
        content = content.replace(re, '');
        const rePlain = new RegExp(`(^|\\n)\\s*[-•*]?\\s*${key}\\s*$`, 'gi');
        content = content.replace(rePlain, '');
      }
      if (content !== original) {
        const label = inferredType || 'LSS block';
        await updateBlockContent(result, block, content.trim(), `Clean schema prop lines from body for ${label} (properties now as page props only)`);
      }
    }
  }

  // For LSS entity pages, ensure/refresh the visible schema properties list (prop:: lines) derived from the tag.
  // We skip these blocks in clean (so they survive) and here we create or update the list block so
  // properties are visible on the entity page (as page props + list) and never on journals (cleaned).
  if (inferredType && propLines && logseq.Editor.appendBlockInPage) {
    await sleep(50);
    let freshBlocks = await getBlocks(pageName);
    if (!freshBlocks?.length) freshBlocks = blocks;
    let existingListId: string | null = null;
    for (const b of walkBlocks(freshBlocks)) {
      if (isPropertiesListBlock(String(b?.content ?? ''), schemaProps)) {
        existingListId = blockId(b);
        break;
      }
    }
    if (existingListId && logseq.Editor.updateBlock) {
      try {
        await logseq.Editor.updateBlock(existingListId, propLines);
        result.actions.push(`REFRESHED schema prop list for visibility on ${inferredType}`);
      } catch {}
    } else {
      await logseq.Editor.appendBlockInPage(pageName, propLines).catch(() => {});
      result.actions.push(`Added schema prop lines to content for visibility on ${inferredType}`);
    }
  }

  await sleep(200);

  let concretized = 0;
  let phantomTagsFixed = 0;
  const flat = walkBlocks(blocks);
  for (const block of flat) {
    let content = String(block?.content ?? '');
    const phantom = fixPhantomTagParenSyntax(content);
    if (phantom.content !== content) {
      content = phantom.content;
      phantomTagsFixed++;
      await updateBlockContent(result, block, content, `Fix phantom (#tag) syntax on ${pageName}`);
    }
  }

  const objectType =
    typeHint ||
    inferObjectTypeFromPromotedState(resolvedTags, props) ||
    inferCurrentPageObjectType(pageName, blocks);
  if (objectType) {
    result.notes.push(`Dashboard query repair: inferred object type for ${pageName}: ${objectType}.`);
  }
  const repaired = await repairDashboardQueries(result, pageName, blocks, objectType);
  const linked = await repairLinkedParentDashboards(result, props, objectType, pageName);

  result.notes.push(
    `Repair ${label}: ${pageName}; promoted ${resolvedTags.size} tag(s), ${props.size} property candidate(s), fixed ${phantomTagsFixed} phantom (#tag) block(s), concretized ${concretized} query block(s), repaired ${repaired} dashboard query block(s), repaired ${linked} linked parent dashboard query block(s).`,
  );

  return { objectType, repaired, linked, resolvedTags, props };
}

function findSectionBlocks(blocks: any[]): Map<string, any> {
  const map = new Map<string, any>();
  for (const block of walkBlocks(blocks)) {
    const section = sectionNameFromLine(block?.content);
    if (section && !map.has(section)) map.set(section, block);
  }
  return map;
}

async function readBlockContent(block: any): Promise<string> {
  const id = blockId(block);
  if (id && logseq.Editor.getBlock) {
    try {
      const fresh = await logseq.Editor.getBlock(id);
      if (fresh?.content != null) return String(fresh.content);
    } catch {
      /* ignore */
    }
  }
  return String(block?.content ?? '');
}

async function repairApplyTagToPage(result: Result, pageBlockId: string, tag: string): Promise<boolean> {
  if (!tag) return false;
  if (!logseq.Editor.addBlockTag) {
    result.notes.push(`addBlockTag API unavailable; could not promote #${tag} to current page.`);
    return false;
  }
  const identity = entityIdentity(pageBlockId);
  if (identity && (await pageHasClassTag(identity, tag))) {
    result.actions.push(`SKIP page tag already present: #${tag}`);
    return false;
  }
  const tagObj = await ensureTagByName(result, tag);
  if (!tagObj) return false;
  const tagId = entityIdentity(tagObj);
  if (!tagId) return false;
  try {
    await logseq.Editor.addBlockTag(pageBlockId, tagId);
    result.actions.push(`PROMOTE page tag: #${tag}`);
    await sleep(15);
    // Immediately ensure the tag's properties are set on the entity page as page properties (not in content/journal).
    const obj = allObjects().find((o) => safeTag(o.tag) === tag);
    if (obj) {
      for (const key of uniqueObjectProps(obj)) {
        let def: any = defaultPropertyValue(key, obj);
        if (def == null && isDateProperty(key)) {
          def = toJournalDay(defaultPropertyValue(key, obj) || '');
        }
        if (def) {
          await repairUpsertPageProperty(result, pageBlockId, key, def);
        }
      }
    }
    return true;
  } catch (error) {
    result.errors.push(`promote page tag #${tag}: ${formatError(error)}`);
    return false;
  }
}

async function normalizeDatePropertyLineInContent(
  result: Result,
  block: any,
  shortKey: string,
) {
  if (!logseq.Editor.updateBlock) return;
  const id = blockId(block);
  if (!id) return;
  const content = String(block?.content ?? '');
  // Match lines like "start-date:: [[2024-06-18]]" or "start-date:: 2024-06-18"
  const re = new RegExp(`^(\\s*-?\\s*)(${shortKey}::\\s*)(.+)$`, 'i');
  const match = content.match(re);
  if (!match) return;
  const prefix = match[1];
  const keyPart = match[2];
  const currentVal = match[3].trim();
  // Only rewrite if it looks like a date wiki or needs cleaning
  if (!currentVal || /^-?\d{8}$/.test(currentVal)) return; // already plain journal day or empty
  const plain = formatDatePropertyValueForContent(currentVal);
  if (!plain || plain === currentVal.replace(/^\[\[|\]\]$/g, '')) return;
  const newContent = `${prefix}${keyPart}${plain}`;
  try {
    await logseq.Editor.updateBlock(id, newContent);
    result.actions.push(`CLEAN date line ${shortKey} (removed [[ ]] for visibility)`);
  } catch (error) {
    result.errors.push(`normalize date line ${shortKey}: ${formatError(error)}`);
  }
}

async function repairUpsertPageProperty(
  result: Result,
  pageBlockId: string,
  property: string,
  value: string,
): Promise<boolean> {
  if (!property || SKIP_PROMOTE_KEYS.has(property) || property.startsWith('block/')) return false;
  if (!String(value ?? '').trim()) {
    const currentValue = await readCurrentBlockProperty(pageBlockId, canonicalPropertyKey(property));
    if (currentValue != null) {
      if (logseq.Editor.removeBlockProperty) {
        await logseq.Editor.removeBlockProperty(pageBlockId, canonicalPropertyKey(property)).catch(() => null);
        result.actions.push(`REMOVED ${property} (cleared)`);
      }
    }
    return false;
  }
  if (!logseq.Editor.upsertBlockProperty) {
    result.notes.push(`upsertBlockProperty API unavailable; could not promote ${property}:: to current page.`);
    return false;
  }
  const shortKey = canonicalPropertyKey(property);
  try {
    const upsertValue = await resolveUpsertPropertyValue(shortKey, value);
    const isNodeRel =
      (await isDbGraph()) &&
      RELATIONSHIP_PROPERTIES.has(shortKey) &&
      String(propertySpec(shortKey)?.type ?? '').toLowerCase() === 'node';
    const currentValue = await readCurrentBlockProperty(pageBlockId, shortKey);
    if (isDateProperty(shortKey) && isValidDatePropertyValue(currentValue)) {
      result.actions.push(`SKIP date property already valid: ${shortKey}`);
      return false;
    }
    if (propertyValuesEquivalent(currentValue, upsertValue, shortKey)) {
      result.actions.push(`SKIP page property unchanged: ${shortKey}`);
      return false;
    }
    if (isDateProperty(shortKey) && upsertValue == null) {
      if (currentValue != null && logseq.Editor.removeBlockProperty) {
        await logseq.Editor.removeBlockProperty(pageBlockId, shortKey).catch(() => null);
        result.actions.push(`CLEAR invalid date property: ${shortKey}`);
        await sleep(15);
      }
      return false;
    }
    // If we are about to write a date and current already parses as valid, skip even if raw values differ
    if (isDateProperty(shortKey) && isValidDatePropertyValue(currentValue) && isValidDatePropertyValue(upsertValue)) {
      const curMs = parseDatePropertyValue(currentValue);
      const upMs = parseDatePropertyValue(upsertValue);
      if (curMs != null && upMs != null && curMs === upMs) {
        result.actions.push(`SKIP date property already valid: ${shortKey}`);
        return false;
      }
    }
    if (isNodeRel && typeof upsertValue === 'string') {
      if (isDbPageRefValue(currentValue)) {
        result.actions.push(`SKIP node property already linked: ${shortKey}`);
        return false;
      }
      const targets = (((propertySpec(shortKey) as { targets?: unknown[] } | undefined)?.targets ?? [])).map(String);
      const targetHint = targets.length ? targets.join('/') : 'target';
      result.notes.push(
        `Node property ${shortKey} could not resolve "${String(value).slice(0, 80)}" to a page id; select or link the ${targetHint} page for ${shortKey}.`,
      );
      return false;
    }
    if (
      isNodeRel &&
      isDbPageRefValue(upsertValue) &&
      isDbPageRefValue(currentValue) &&
      propertyValuesEquivalent(currentValue, upsertValue, shortKey)
    ) {
      result.actions.push(`SKIP node property already linked: ${shortKey}`);
      return false;
    }
    if (isNodeRel && isDbPageRefValue(upsertValue) && logseq.Editor.removeBlockProperty) {
      await logseq.Editor.removeBlockProperty(pageBlockId, shortKey).catch(() => null);
      await sleep(50);
    }
    const opts = isNodeRel ? ({ reset: true } as const) : undefined;
    await upsertBlockPropertyWithRetry(pageBlockId, shortKey, upsertValue, opts);
    const displayValue = isDateProperty(shortKey)
      ? formatDatePropertyValue(upsertValue) || String(value).slice(0, 80)
      : isDbPageRefValue(upsertValue)
        ? JSON.stringify(upsertValue)
        : String(value).slice(0, 80);
    result.actions.push(`PROMOTE page property: ${shortKey}:: ${displayValue}`);
    await sleep(15);
    return true;
  } catch (error) {
    const msg = formatError(error);
    if (isDateProperty(shortKey) && /journal date|invalid value|should be a/i.test(msg)) {
      result.notes.push(`date property ${shortKey} rejected by Logseq (expected journal date): ${msg}`);
      return false;
    }
    result.errors.push(`promote page property ${property}: ${formatError(error)}`);
    return false;
  }
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

async function maybeMarkQueryBlock(result: Result, blockIdValue: string | null, content: string): Promise<void> {
  if (!blockIdValue || !isQueryLikeContent(content)) return;
  if (!logseq.Editor.addBlockTag) {
    result.notes.push(`addBlockTag API unavailable; query block relies on inline #Query only if pasted manually.`);
    return;
  }
  if (await pageHasClassTag(blockIdValue, 'Query')) {
    result.actions.push(`SKIP #Query tag already on query block`);
    return;
  }
  const queryTag = await ensureTagByName(result, 'Query');
  const queryTagId = queryTag ? entityIdentity(queryTag) : null;
  if (!queryTagId) return;
  try {
    await logseq.Editor.addBlockTag(blockIdValue, queryTagId);
    result.actions.push(`ADD #Query tag to query block: ${String(content).slice(0, 80)}`);
    await sleep(15);
  } catch (error) {
    result.errors.push(`query-block-tag: ${formatError(error)}`);
  }
}

async function repairResolveTagSet(result: Result, tags: Set<string>): Promise<Set<string>> {
  const out = new Set<string>();
  for (const tag of tags) out.add(await resolveVisibleNodeToken(result, tag));
  return out;
}

export async function repairDashboardQueries(
  result: Result,
  pageName: string,
  blocks: any[],
  typeHint: string | null = null,
  sectionsFilter: Set<string> | null = null,
): Promise<number> {
  const objectType = typeHint || inferCurrentPageObjectType(pageName, blocks);
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

  for (const view of views) {
    const section = String(view.section ?? '').trim();
    if (!section) continue;
    if (sectionsFilter && !sectionsFilter.has(section)) continue;
    let sectionBlock = sectionBlocks.get(section);
    if (!sectionBlock) {
      if (!logseq.Editor.appendBlockInPage) {
        result.errors.push(`dashboard-section ${section}: logseq.Editor.appendBlockInPage API unavailable`);
        continue;
      }
      try {
        sectionBlock = await logseq.Editor.appendBlockInPage(pageName, section);
        sectionBlocks.set(section, sectionBlock);
        result.actions.push(`INSERT dashboard section: ${objectType} / ${section}`);
        await sleep(THROTTLE_MS);
      } catch (error) {
        result.errors.push(`insert dashboard section ${section}: ${formatError(error)}`);
        continue;
      }
    }
    const queryContent = await dashboardQueryBlockForViewAsync(view, pageName, pageEntity);
    if (!queryContent) continue;
    const queryTitle = (view && view.sourceTags && view.sourceTags.length ? view.sourceTags[0] : section) || section;
    const existingQueries = await findAllQueryBlocksInSectionAsync(sectionBlock);
    if (existingQueries.length) {
      const canonical =
        (await pickCanonicalQueryBlock(existingQueries, queryContent)) ?? existingQueries[0];
      const canonicalId = blockId(canonical);
      const duplicateCount = existingQueries.length - 1;

      for (const existing of existingQueries) {
        if (blockId(existing) === canonicalId) continue;
        if (await removeDashboardQueryBlock(result, existing, `${objectType} / ${section}`)) {
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
      if (needsContent || needsStructure) {
        const hasTagButNoChild = struct.hasQueryClassTag && !struct.hasQueryProperty;
        const hasEdnButNoDisplay = struct.hasQueryClassTag && struct.hasQueryProperty && struct.childTitleHasEdn && !struct.childDisplayTypeIsCode;
        if ((hasTagButNoChild || hasEdnButNoDisplay) && (await forceCreateQueryChild(result, canonical, queryContent))) {
          result.actions.push(`FORCED/REPAIRED query child for ${objectType} / ${section}`);
          await updateBlockContent(result, canonical, queryTitle, `Set query title to ${queryTitle}`);
          changed++;
        } else {
          // Rebuild from scratch
          for (const existing of existingQueries) {
            if (await removeDashboardQueryBlock(result, existing, `${objectType} / ${section}`)) {
              changed++;
            }
          }
          if (!logseq.Editor.insertBlock) {
            result.errors.push(`dashboard-query: insertBlock unavailable for ${section}`);
          } else {
            const fresh = await logseq.Editor.insertBlock(
              blockId(sectionBlock),
              queryTitle,
              { sibling: false, before: false, end: true }
            );
            if (fresh) {
              const freshId = blockId(fresh);
              const queryTagId = await resolveQueryClassTagId();
              if (queryTagId) {
                await logseq.Editor.addBlockTag(freshId, queryTagId).catch(() => {});
              }
              await sleep(20);
              const configured = await configureDbAdvancedQueryBlock(result, fresh, queryContent);
              if (configured) {
                result.actions.push(`REBUILT advanced query from scratch for ${objectType} / ${section}`);
                await updateBlockContent(result, fresh, queryTitle, `Set query title to ${queryTitle}`);
                changed++;
              } else {
                await sleep(120);
                const configured2 = await configureDbAdvancedQueryBlock(result, fresh, queryContent);
                if (configured2) {
                  result.actions.push(`REBUILT + retry configured for ${objectType} / ${section}`);
                  await updateBlockContent(result, fresh, queryTitle, `Set query title to ${queryTitle}`);
                  changed++;
                } else {
                  // The only thing usually left is the :code keyword — hammer it
                  await repairDbQueryBlockUiKeywords(result, fresh);
                  const recheck = await inspectDbQueryBlockStructure(fresh);
                  if (recheck.childDisplayTypeIsCode) {
                    result.actions.push(`SET :code via post-rebuild keywords repair for ${objectType} / ${section}`);
                    changed++;
                  } else {
                    result.notes.push(
                      `Fresh shell created for ${objectType} / ${section} (auto-repair will finalize :code)`
                    );
                    try { scheduleAutoRepair(pageName); } catch {}
                  }
                }
              }
            }
          }
        }
      } else {
        checked++;
      }
    } else if (logseq.Editor.insertBlock) {
      try {
        const isDb = await isDbGraph();
        const shellContent = isDb ? queryTitle : queryContent;
        const inserted = await logseq.Editor.insertBlock(
          blockId(sectionBlock),
          shellContent,
          {
            sibling: false,
            before: false,
            end: true,
          },
        );
        result.actions.push(`INSERT dashboard query shell: ${objectType} / ${section}`);
        changed++;
        if (isDb && inserted && queryContent) {
          let ok = await configureDbAdvancedQueryBlock(result, inserted, queryContent);
          if (!ok) {
            await sleep(150);
            ok = await configureDbAdvancedQueryBlock(result, inserted, queryContent);
          }
          if (ok) {
            result.actions.push(`CONFIGURED advanced query after insert for ${objectType} / ${section}`);
            await updateBlockContent(result, inserted, queryTitle, `Set query title to ${queryTitle}`);
          } else {
            await repairDbQueryBlockUiKeywords(result, inserted);
            await sleep(100);
            const recheck = await inspectDbQueryBlockStructure(inserted);
            if (!dbAdvancedQueryBlockNeedsStructureRepair(recheck)) {
              result.actions.push(`RECOVERED query structure via keywords + recheck for ${objectType} / ${section}`);
              await updateBlockContent(result, inserted, queryTitle, `Set query title to ${queryTitle}`);
            } else {
              result.notes.push(`configure after first insert needed extra pass for ${objectType} / ${section} (auto-repair will help)`);
              try { scheduleAutoRepair(pageName); } catch {}
            }
          }
        } else if (inserted && !isDb) {
          await updateBlockContent(result, inserted, queryTitle, `Set query title to ${queryTitle}`);
        }
      } catch (error) {
        result.errors.push(`insert dashboard query ${section}: ${formatError(error)}`);
      }
    } else {
      result.errors.push(`dashboard-query ${section}: logseq.Editor.insertBlock API unavailable`);
    }
  }

  result.notes.push(
    `Dashboard query repair: inferred ${objectType}; changed/inserted ${changed} query block(s), checked ${checked} existing query block(s).`,
  );
  return changed;
}

async function repairSpecificPage(
  result: Result,
  pageRef: string,
  typeHint: string | null = null,
  label = 'linked',
): Promise<number> {
  let pageName = String(pageRef ?? '').trim();
  if (!pageName) return 0;
  pageName = await resolveVisibleNodeToken(result, pageName);
  let page = (await getPage(pageName)) || (await getPage(safePageName(pageName))) || (await getPage(safeTag(pageName)));
  if (!page) {
    result.errors.push(`Repair ${label}: could not read page ${pageName}`);
    return 0;
  }
  const visibleName = page?.originalName ?? page?.name ?? page?.title ?? pageName;
  if (
    visibleName &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(visibleName))
  ) {
    pageName = String(visibleName);
  }
  const pageBlockId = blockId(page);
  if (!pageBlockId) {
    result.errors.push(`Repair ${label}: page has no uuid/id exposed by Logseq API: ${pageName}`);
    return 0;
  }

  enterRepairSession();
  try {
    let blocks = await getBlocks(pageName);
    if (!blocks?.length && safePageName(pageName) !== pageName) {
      blocks = await getBlocks(safePageName(pageName));
    }
    if (pageRecordIsJournal(page, pageName)) {
      await removeNativeTagSchemaProperties(result);
      const materialized = await materializeJournalEntityBlocks(result, pageName, blocks);
      markRepairCooldown(pageName);
      return materialized;
    }
    const { repaired } = await repairPageCore(result, pageName, pageBlockId, blocks, typeHint, label);
    markRepairCooldown(pageName);
    return repaired;
  } finally {
    exitRepairSession();
  }
}

async function repairLinkedParentDashboards(
  result: Result,
  props: Map<string, string>,
  objectType: string | null,
  currentPage: string,
): Promise<number> {
  let total = 0;
  const repairedKeys = new Set<string>();

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
        const key = `${targetType}:${parentName}:${[...sections].sort().join('|')}`;
        if (repairedKeys.has(key)) continue;
        repairedKeys.add(key);
        result.notes.push(
          `Linked parent repair: ${objectType ?? 'object'} ${currentPage} points to ${targetType} [[${parentName}]] via ${prop}; refreshing ${[...sections].join(', ')}.`,
        );
        const parentBlocks = await getBlocks(parentName);
        total += await repairDashboardQueries(result, parentName, parentBlocks, targetType, sections);
        markRepairCooldown(parentName);
      }
    }
  }
  return total;
}

export async function repairNamedPage(
  result: Result,
  pageRef: string,
  typeHint: string | null = null,
): Promise<number> {
  return repairSpecificPage(result, pageRef, typeHint, 'named');
}

export async function repairCurrentPage(result: Result): Promise<void> {
  const current = await currentPageName();
  if (!current) {
    result.errors.push('No current page detected. Open a page, click inside it, and rerun.');
    return;
  }
  const page = await getPage(current);
  if (!page) {
    result.errors.push(`Could not read current page object: ${current}`);
    return;
  }
  const pageName = String(page.originalName ?? page.name ?? page.title ?? current);
  await repairSpecificPage(result, pageName, null, 'current page');
}
