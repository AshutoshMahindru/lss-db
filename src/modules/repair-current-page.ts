import { blockId, getPage, pageVisibleName } from '../core/editor';
import { entityIdentity, pageHasClassTag } from '../core/db-properties';
import { formatError, newResult } from '../core/runner';
import { safePageName, safeTag } from '../core/names';
import type { Result } from '../core/types';
import { allObjects } from '../registry';
import { primaryObjectTypesFromTags, readIncomingSourceTagsForPage } from './repair-source-tags';

function pageNamesEquivalent(a: string, b: string): boolean {
  const norm = (value: string) => safePageName(String(value ?? '').trim()).toLowerCase();
  return norm(a) === norm(b);
}

type TaggedLssPageRow = {
  title: string;
  tag: string;
  updated: number;
};

async function taggedLssPageRows(result?: Result): Promise<TaggedLssPageRow[]> {
  if (!logseq.DB?.datascriptQuery) return [];
  const tags = allObjects()
    .map((obj) => safeTag(obj.tag))
    .filter(Boolean);
  if (!tags.length) return [];

  try {
    const rows = await logseq.DB.datascriptQuery(
      `[:find ?title ?tag ?updated
 :in $ [?tag ...]
 :where
 [?p :block/title ?title]
 [?p :block/tags ?t]
 [?t :block/title ?tag]
 [?p :block/updated-at ?updated]]`,
      tags,
    );
    return (rows as Array<[unknown, unknown, unknown]>)
      .map((row) => ({
        title: pageVisibleName(null, String(row?.[0] ?? '').trim()),
        tag: safeTag(String(row?.[1] ?? '').trim()),
        updated: Number(row?.[2] ?? 0),
      }))
      .filter((row) => row.title && row.tag && Number.isFinite(row.updated));
  } catch (error) {
    result?.notes.push(`Tagged LSS page lookup unavailable: ${formatError(error)}`);
    return [];
  }
}

export async function pageLooksMaterializable(pageName: string): Promise<boolean> {
  const page = await getPage(pageName);
  const identity = entityIdentity(page) || blockId(page);
  if (identity) {
    for (const obj of allObjects()) {
      const tag = safeTag(obj.tag);
      if (tag && (await pageHasClassTag(identity, tag))) return true;
    }
  }
  const pageBlockId = blockId(page);
  if (pageBlockId) {
    const incoming = await readIncomingSourceTagsForPage(newResult('lss:materialise-probe'), pageName, pageBlockId, page);
    if (primaryObjectTypesFromTags(incoming.classTags).size === 1) return true;
  }
  const title = pageVisibleName(page, pageName) || pageName;
  const rows = await taggedLssPageRows();
  return rows.some((row) => pageNamesEquivalent(row.title, title));
}

export async function recentTaggedLssPageFallback(result: Result, rejectedPage: string): Promise<string | null> {
  const rows = await taggedLssPageRows(result);
  const byTitle = new Map<string, number>();
  for (const row of rows) {
    const title = row.title;
    const updated = row.updated;
    if (pageNamesEquivalent(title, rejectedPage) || /^LSS Placeholder\//i.test(title)) continue;
    byTitle.set(title, Math.max(byTitle.get(title) ?? 0, updated));
  }

  const candidates = [...byTitle.entries()]
    .sort((a, b) => b[1] - a[1]);
  for (const [title, updated] of candidates) {
    result.notes.push(
      `Current-page API returned untyped ${rejectedPage}; using most recently edited tagged LSS page ${title} (${new Date(updated).toISOString()}).`,
    );
    return title;
  }
  return null;
}
