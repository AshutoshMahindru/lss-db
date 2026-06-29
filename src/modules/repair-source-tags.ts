import { resolvePageFromIdentity } from '../core/editor';
import { entityVisibleLabel, safePageName, safeTag, visiblePageLabel } from '../core/names';
import type { Result } from '../core/types';
import { allObjects, objectByName } from '../registry';
import { formatError } from '../core/runner';
import { isInstanceHintTag } from './repair-hints';

function canonicalObjectTypeToken(token: string): string | null {
  const raw = safePageName(safeTag(token));
  if (!raw) return null;
  const object = objectByName(raw);
  return object?.name ?? null;
}

export function primaryObjectTypesFromTags(tags: Set<string>): Set<string> {
  const types = new Set<string>();
  for (const tag of tags) {
    const type = canonicalObjectTypeToken(tag);
    if (type) types.add(type);
  }
  return types;
}

function numericDbId(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

function recordDbId(record: unknown): number | null {
  const direct = numericDbId(record);
  if (direct) return direct;
  if (!record || typeof record !== 'object') return null;
  const r = record as Record<string, unknown>;
  return numericDbId(r.id ?? r[':db/id'] ?? r['db/id']);
}

function pageNamesEquivalent(a: string, b: string): boolean {
  return safePageName(a).toLowerCase() === safePageName(b).toLowerCase();
}

function visibleEntityName(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return visiblePageLabel(value);
  if (typeof value === 'number') return '';
  if (typeof value !== 'object') return '';
  return entityVisibleLabel(value as Record<string, unknown>);
}

async function readTagObject(tag: string): Promise<unknown> {
  const editor = (logseq as unknown as { Editor?: Record<string, any>; api?: Record<string, any> }).Editor;
  const api = (logseq as unknown as { api?: Record<string, any> }).api;
  try {
    if (editor?.getTag) return await Promise.resolve(editor.getTag(tag));
  } catch {
    /* try alternate host shape */
  }
  try {
    if (api?.get_tag) return await Promise.resolve(api.get_tag(tag));
  } catch {
    /* ignore */
  }
  return null;
}

async function primaryTagIdMap(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const object of allObjects()) {
    const tag = safeTag(object.tag ?? object.name);
    if (!tag) continue;
    const tagObject = await readTagObject(tag);
    const id = recordDbId(tagObject);
    if (id) out.set(String(id), tag);
  }
  return out;
}

function sourceBlockKey(block: unknown, fallback: number): string {
  if (!block || typeof block !== 'object') return `linked-${fallback}`;
  const record = block as Record<string, unknown>;
  return String(record.uuid ?? record.id ?? record[':db/id'] ?? record['db/id'] ?? `linked-${fallback}`);
}

function isLinkedBlockRecord(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Boolean(
    record.content != null ||
      record.title != null ||
      record.fullTitle != null ||
      record.tags != null ||
      record.refs != null ||
      record.parent != null ||
      record.page != null ||
      record.properties != null,
  );
}

function flattenLinkedReferenceBlocks(value: unknown, out: unknown[] = []): unknown[] {
  if (!value) return out;
  if (Array.isArray(value)) {
    if (value.length === 2 && Array.isArray(value[1])) {
      flattenLinkedReferenceBlocks(value[1], out);
      return out;
    }
    for (const item of value) flattenLinkedReferenceBlocks(item, out);
    return out;
  }
  if (isLinkedBlockRecord(value)) {
    out.push(value);
    return out;
  }
  if (typeof value === 'object') {
    for (const nested of Object.values(value as Record<string, unknown>)) flattenLinkedReferenceBlocks(nested, out);
  }
  return out;
}

async function readLinkedReferences(pageName: string): Promise<unknown> {
  const editor = (logseq as unknown as { Editor?: Record<string, any>; api?: Record<string, any> }).Editor;
  const api = (logseq as unknown as { api?: Record<string, any> }).api;
  try {
    if (editor?.getPageLinkedReferences) return await Promise.resolve(editor.getPageLinkedReferences(pageName));
  } catch {
    /* try alternate host shape */
  }
  try {
    if (api?.get_page_linked_references) return await Promise.resolve(api.get_page_linked_references(pageName));
  } catch {
    /* ignore */
  }
  return null;
}

function addTagCandidate(
  tagName: string,
  pageName: string,
  classTags: Set<string>,
  instanceHints: Set<string>,
): void {
  const tag = safeTag(visiblePageLabel(tagName));
  if (!tag) return;
  if (canonicalObjectTypeToken(tag)) {
    classTags.add(tag);
  } else if (!pageNamesEquivalent(tag, pageName) && isInstanceHintTag(tag)) {
    instanceHints.add(tag);
  }
}

function collectTextTags(
  value: unknown,
  pageName: string,
  classTags: Set<string>,
  instanceHints: Set<string>,
): void {
  const text = String(value ?? '');
  if (!text.includes('#')) return;
  const re = /#(?:\[\[([^\]]+?)\]\]|([A-Za-z0-9_/-]+))/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) addTagCandidate(match[1] || match[2] || '', pageName, classTags, instanceHints);
}

async function resolveLinkedTagName(
  raw: unknown,
  pageName: string,
  targetPageIds: Set<string>,
  primaryById: Map<string, string>,
  resolvedById: Map<string, string | null>,
): Promise<string> {
  const directName = visibleEntityName(raw);
  if (directName) return safeTag(directName);

  const id = recordDbId(raw);
  if (!id) return '';
  const key = String(id);
  const primary = primaryById.get(key);
  if (primary) return primary;
  if (targetPageIds.has(key)) return '';

  if (!resolvedById.has(key)) {
    const page = await resolvePageFromIdentity(id).catch(() => null);
    const label = entityVisibleLabel(page as Record<string, unknown> | null, '');
    resolvedById.set(key, label && !pageNamesEquivalent(label, pageName) ? safeTag(label) : null);
  }
  return resolvedById.get(key) ?? '';
}

async function collectLinkedTagValues(
  raw: unknown,
  pageName: string,
  targetPageIds: Set<string>,
  primaryById: Map<string, string>,
  resolvedById: Map<string, string | null>,
  classTags: Set<string>,
  instanceHints: Set<string>,
): Promise<void> {
  const values = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
  for (const value of values) {
    const tag = await resolveLinkedTagName(value, pageName, targetPageIds, primaryById, resolvedById);
    addTagCandidate(tag, pageName, classTags, instanceHints);
  }
}

async function resolvePageDbEntityId(pageName: string, pageBlockId: string, page: any): Promise<number | null> {
  const direct = recordDbId(page);
  if (direct) return direct;
  if (!logseq.DB?.datascriptQuery) return null;

  const uuid =
    typeof page?.uuid === 'string'
      ? page.uuid
      : /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(pageBlockId ?? ''))
        ? String(pageBlockId)
        : '';
  if (uuid) {
    try {
      const rows = await logseq.DB.datascriptQuery(
        '[:find ?e :in $ ?uuid :where [?e :block/uuid ?uuid]]',
        `#uuid "${uuid}"`,
      );
      const found = numericDbId(Array.isArray(rows) ? rows[0]?.[0] : null);
      if (found) return found;
    } catch {
      /* fall through to title lookup */
    }
  }

  const title = String(page?.originalName ?? page?.title ?? page?.name ?? pageName ?? '').trim();
  if (!title) return null;
  for (const candidate of [...new Set([title, safePageName(title)])].filter(Boolean)) {
    try {
      const rows = await logseq.DB.datascriptQuery(
        `[:find ?e :in $ ?title ?name
 :where
 (or [?e :block/title ?title]
     [?e :block/original-name ?title]
     [?e :block/name ?name])]`,
        candidate,
        safePageName(candidate).toLowerCase(),
      );
      const found = numericDbId(Array.isArray(rows) ? rows[0]?.[0] : null);
      if (found) return found;
    } catch {
      /* try next candidate */
    }
  }
  return null;
}

async function readIncomingSourceTagsFromLinkedReferences(
  pageName: string,
  pageBlockId: string,
  page: any,
): Promise<{ classTags: Set<string>; instanceHints: Set<string>; sourceBlocks: Set<string> }> {
  const classTags = new Set<string>();
  const instanceHints = new Set<string>();
  const sourceBlocks = new Set<string>();

  const linkedReferences = await readLinkedReferences(pageName);
  const blocks = flattenLinkedReferenceBlocks(linkedReferences);
  if (!blocks.length) return { classTags, instanceHints, sourceBlocks };

  const targetPageIds = new Set<string>();
  const directPageId = recordDbId(page);
  if (directPageId) targetPageIds.add(String(directPageId));
  const resolvedPageId = await resolvePageDbEntityId(pageName, pageBlockId, page);
  if (resolvedPageId) targetPageIds.add(String(resolvedPageId));

  const primaryById = await primaryTagIdMap();
  const resolvedById = new Map<string, string | null>();

  let idx = 0;
  for (const block of blocks) {
    sourceBlocks.add(sourceBlockKey(block, idx++));
    const record = (block ?? {}) as Record<string, unknown>;
    await collectLinkedTagValues(record.tags, pageName, targetPageIds, primaryById, resolvedById, classTags, instanceHints);
    await collectLinkedTagValues(
      (record.properties as Record<string, unknown> | undefined)?.tags,
      pageName,
      targetPageIds,
      primaryById,
      resolvedById,
      classTags,
      instanceHints,
    );
    await collectLinkedTagValues(record.refs, pageName, targetPageIds, primaryById, resolvedById, classTags, instanceHints);
    collectTextTags(record.content, pageName, classTags, instanceHints);
    collectTextTags(record.title, pageName, classTags, instanceHints);
    collectTextTags(record.fullTitle, pageName, classTags, instanceHints);
  }

  return { classTags, instanceHints, sourceBlocks };
}

export async function readIncomingSourceTagsForPage(
  result: Result,
  pageName: string,
  pageBlockId: string,
  page: any,
): Promise<{ classTags: Set<string>; instanceHints: Set<string>; sourceBlocks: number }> {
  const classTags = new Set<string>();
  const instanceHints = new Set<string>();
  const sourceBlocks = new Set<string>();

  const pageId = logseq.DB?.datascriptQuery ? await resolvePageDbEntityId(pageName, pageBlockId, page) : null;

  if (pageId && logseq.DB?.datascriptQuery) {
    for (const attr of [':block/title', ':block/original-name', ':block/name']) {
      try {
        const rows = await logseq.DB.datascriptQuery(
          `[:find ?tagTitle ?b
 :in $ ?targetId
 :where
 [?b :block/refs ?targetId]
 [?b :block/tags ?tag]
 [?tag ${attr} ?tagTitle]]`,
          pageId,
        );
        for (const row of Array.isArray(rows) ? rows : []) {
          const tag = safeTag(Array.isArray(row) ? row[0] : '');
          const sourceId = String(Array.isArray(row) ? row[1] : '');
          if (sourceId) sourceBlocks.add(sourceId);
          addTagCandidate(tag, pageName, classTags, instanceHints);
        }
      } catch (error) {
        result.notes.push(`Source tag inference query failed for ${pageName} (${attr}): ${formatError(error)}`);
      }
    }
  }

  const linked = await readIncomingSourceTagsFromLinkedReferences(pageName, pageBlockId, page);
  for (const tag of linked.classTags) classTags.add(tag);
  for (const hint of linked.instanceHints) instanceHints.add(hint);
  for (const block of linked.sourceBlocks) sourceBlocks.add(block);

  return { classTags, instanceHints, sourceBlocks: sourceBlocks.size };
}

export async function applyIncomingSourceTagsForPage(
  result: Result,
  pageName: string,
  pageBlockId: string,
  page: any,
  tags: Set<string>,
  instanceHints: Set<string>,
): Promise<void> {
  const incoming = await readIncomingSourceTagsForPage(result, pageName, pageBlockId, page);
  for (const hint of incoming.instanceHints) instanceHints.add(hint);

  const currentPrimaryTypes = primaryObjectTypesFromTags(tags);
  const incomingPrimaryTypes = primaryObjectTypesFromTags(incoming.classTags);
  if (currentPrimaryTypes.size === 0 && incomingPrimaryTypes.size === 1) {
    const type = [...incomingPrimaryTypes][0];
    const obj = objectByName(type);
    const tag = safeTag(obj?.tag ?? type);
    if (tag) {
      tags.add(tag);
      result.notes.push(
        `Inferred primary LSS tag #${tag} from ${incoming.sourceBlocks} source block(s) that reference [[${safePageName(pageName)}]].`,
      );
    }
  } else if (currentPrimaryTypes.size === 0 && incomingPrimaryTypes.size > 1) {
    result.notes.push(
      `Source blocks referencing [[${safePageName(pageName)}]] have multiple LSS type tags: ${[...incomingPrimaryTypes]
        .map((type) => `#${type}`)
        .join(', ')}. Add exactly one primary LSS type tag to the page or source block.`,
    );
  } else if (currentPrimaryTypes.size > 0 && incomingPrimaryTypes.size > 0) {
    const conflicts = [...incomingPrimaryTypes].filter((type) => !currentPrimaryTypes.has(type));
    if (conflicts.length) {
      result.notes.push(
        `Ignored conflicting source LSS type tag(s) for [[${safePageName(pageName)}]]: ${conflicts
          .map((type) => `#${type}`)
          .join(', ')}. Page primary tag remains ${[...currentPrimaryTypes].map((type) => `#${type}`).join(', ')}.`,
      );
    }
  }
}
