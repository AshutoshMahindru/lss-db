import { canonicalPropertyKey, entityIdentityCandidates, readRelationshipPropertyValue } from '../core/db-properties';
import { blockId, pageVisibleName, resolvePageFromIdentity } from '../core/editor';
import { safePageName, visiblePageLabel } from '../core/names';
import type { Result } from '../core/types';

function pageNamesEquivalent(a: string, b: string): boolean {
  const norm = (value: string) => safePageName(value).toLowerCase();
  return norm(a) === norm(b);
}

export function relationshipValueReferencesPage(value: unknown, pageName: string, pageId: unknown): boolean {
  const test = (item: unknown): boolean => {
    if (item == null) return false;
    if (typeof item === 'number') return pageId != null && String(item) === String(pageId);
    if (typeof item === 'object') {
      const record = item as Record<string, unknown>;
      const id = record.id ?? record.dbId ?? record[':db/id'];
      if (id != null && pageId != null && String(id) === String(pageId)) return true;
      const name = pageVisibleName(record);
      return name ? pageNamesEquivalent(name, pageName) : false;
    }
    const raw = String(item).trim();
    if (!raw) return false;
    if (pageId != null && raw.toLowerCase() === String(pageId).toLowerCase()) return true;
    if (/^\d+$/.test(raw) && pageId != null) return raw === String(pageId);
    return pageNamesEquivalent(visiblePageLabel(raw), pageName);
  };
  return Array.isArray(value) ? value.some(test) : test(value);
}

export function currentPageReferenceHints(pageName: string, page: any, pageBlockId: string): Set<string> {
  const hints = new Set<string>([String(pageBlockId), safePageName(pageName)]);
  for (const id of entityIdentityCandidates(page)) {
    const raw = String(id).trim();
    if (raw) hints.add(raw);
  }
  const lower = String(pageBlockId).trim().toLowerCase();
  if (lower) hints.add(lower);
  return hints;
}

export function referencesCurrentPage(value: unknown, pageName: string, currentPageHints: Set<string>): boolean {
  if (!currentPageHints.size) return pageNamesEquivalent(String(value ?? ''), pageName);
  for (const hint of currentPageHints) {
    if (relationshipValueReferencesPage(value, pageName, hint)) return true;
  }
  return false;
}

export function filterSelfPageRefsFromNodeValue(
  value: unknown,
  pageName: string,
  currentPageHints: Set<string>,
): { value: unknown; removed: boolean } {
  if (value == null) return { value, removed: false };
  const isSelf = (item: unknown): boolean => referencesCurrentPage(item, pageName, currentPageHints);

  if (Array.isArray(value)) {
    const filtered = value.filter((item) => !isSelf(item));
    if (filtered.length === value.length) return { value, removed: false };
    return { value: filtered.length ? filtered : null, removed: true };
  }

  return { value: isSelf(value) ? null : value, removed: isSelf(value) };
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

export async function inferVentureFromIncomingFunctions(
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
