import { blockId, walkBlocks } from '../core/editor';
import { safeTag } from '../core/names';
import {
  blockHasQueryClassTag,
  inspectDbQueryBlockStructure,
  isAdvancedQueryBlockContent,
  propertyBlockRefId,
  QUERY_PROPERTY_KEY,
  readCanonicalProperty,
} from './advanced-query-blocks';
import { isSimpleQueryBlockContent, queryBlockNeedsRepair } from './query-edn';

export function sectionNameFromLine(line: string): string | null {
  let text = String(line ?? '').trim();
  if (!text || text.includes('::')) return null;
  if (text.startsWith('(') || text.startsWith('{{') || text.startsWith('<!--') || text.startsWith('```')) {
    return null;
  }
  text = text.replace(/^[-*]\s+/, '').replace(/#Template\b/g, '').trim();
  if (!text || text === '-') return null;
  return text;
}

function blockSnapshotHasQueryClassTag(block: any): boolean {
  const tags = block?.tags ?? (block?.properties as Record<string, unknown> | undefined)?.tags;
  const names = new Set<string>();
  const collect = (tag: unknown) => {
    if (typeof tag === 'string') names.add(safeTag(tag).toLowerCase());
    else if (tag && typeof tag === 'object') {
      const record = tag as Record<string, unknown>;
      const name = record.name ?? record.originalName ?? record.title ?? record.ident;
      if (name) names.add(String(name).toLowerCase());
    }
  };
  if (Array.isArray(tags)) tags.forEach(collect);
  else if (tags) collect(tags);
  return names.has('query') || names.has('logseq.class/query');
}

/** Sync heuristic: content, #Query shell, query property ref, or Query class tag on block snapshot. */
export function isQueryLikeBlockSnapshot(block: any): boolean {
  if (isQueryLikeContent(String(block?.content ?? ''))) return true;
  const props = (block?.properties ?? {}) as Record<string, unknown>;
  if (propertyBlockRefId(readCanonicalProperty(props, 'query') ?? props[`:${QUERY_PROPERTY_KEY}`]) != null) {
    return true;
  }
  return blockSnapshotHasQueryClassTag(block);
}

export async function isQueryLikeBlockAsync(block: any): Promise<boolean> {
  if (isQueryLikeBlockSnapshot(block)) return true;
  const id = blockId(block);
  return id != null ? blockHasQueryClassTag(id) : false;
}

/** Dashboard queries are direct children of the section heading — not nested code-child blocks. */
export function findAllQueryBlocksInSection(sectionBlock: any): any[] {
  return (sectionBlock?.children ?? []).filter((block: any) => isQueryLikeBlockSnapshot(block));
}

export async function findAllQueryBlocksInSectionAsync(sectionBlock: any): Promise<any[]> {
  const results: any[] = [];
  for (const block of sectionBlock?.children ?? []) {
    if (await isQueryLikeBlockAsync(block)) results.push(block);
  }
  return results;
}

export function readQueryBlockContentFromSnapshot(queryBlock: any): string {
  const parent = String(queryBlock?.content ?? '').trim();
  if (isQueryLikeContent(parent) && isAdvancedQueryBlockContent(parent)) return parent;
  if (isSimpleQueryBlockContent(parent)) return parent;
  const props = (queryBlock?.properties ?? {}) as Record<string, unknown>;
  const childId = propertyBlockRefId(
    readCanonicalProperty(props, 'query') ?? props[`:${QUERY_PROPERTY_KEY}`],
  );
  if (childId != null) {
    for (const child of queryBlock?.children ?? []) {
      const cid = blockId(child);
      if (cid != null && String(cid) === String(childId)) {
        const childContent = String(child?.content ?? child?.title ?? '').trim();
        if (childContent) return childContent;
      }
    }
  }
  // fallback scan: any child with edn content (snapshot props may not expose internal query prop)
  for (const child of queryBlock?.children ?? []) {
    const cc = String(child?.content ?? child?.title ?? '').trim();
    if (isAdvancedQueryBlockContent(cc)) return cc;
  }
  return parent;
}

export async function readDashboardQueryBlockContent(queryBlock: any): Promise<string> {
  const fromSnapshot = readQueryBlockContentFromSnapshot(queryBlock);
  if (isAdvancedQueryBlockContent(fromSnapshot) || isSimpleQueryBlockContent(fromSnapshot)) {
    return fromSnapshot;
  }
  const parentId = blockId(queryBlock);
  if (!parentId || !logseq.Editor.getBlockProperties) return fromSnapshot;
  const props = ((await logseq.Editor.getBlockProperties(parentId).catch(() => null)) ?? {}) as Record<
    string,
    unknown
  >;
  const childId = propertyBlockRefId(
    readCanonicalProperty(props, 'query') ?? props[`:${QUERY_PROPERTY_KEY}`],
  );
  if (childId == null || !logseq.Editor.getBlock) return fromSnapshot;
  const child = await logseq.Editor.getBlock(childId).catch(() => null);
  let result = child ? String((child as Record<string, unknown>).content ?? (child as Record<string, unknown>).title ?? '').trim() : fromSnapshot;
  if (!result && queryBlock) {
    // fallback: scan the queryBlock's children for any that look like the edn child
    const kids = queryBlock.children ?? [];
    for (const ch of kids) {
      const cc = String(ch?.content ?? ch?.title ?? '').trim();
      if (isAdvancedQueryBlockContent(cc)) {
        result = cc;
        break;
      }
    }
  }
  return result;
}

export async function scoreQueryBlockCandidate(block: any, expectedContent: string): Promise<number> {
  const content = await readDashboardQueryBlockContent(block);
  const struct = await inspectDbQueryBlockStructure(block);
  let score = 0;
  if (struct.hasQueryClassTag) score += 10;
  if (struct.hasQueryProperty) score += 20;
  if (struct.hasCodeChild) score += 30;
  if (!struct.rawEdnInParentContent) score += 5;
  if (struct.queryEdnInChild) score += 15;
  if (!queryBlockNeedsRepair(content, expectedContent)) score += 50;
  if (struct.rawEdnInParentContent) score -= 5;
  return score;
}

export async function pickCanonicalQueryBlock(
  blocks: any[],
  expectedContent: string,
): Promise<any | null> {
  if (!blocks.length) return null;
  const scored = await Promise.all(
    blocks.map(async (block) => ({
      block,
      score: await scoreQueryBlockCandidate(block, expectedContent),
    })),
  );
  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.block ?? null;
}

export function findQueryBlockInSection(sectionBlock: any): any | null {
  return findAllQueryBlocksInSection(sectionBlock)[0] ?? null;
}

export function findSectionQueryContent(blocks: any[], section: string): string | null {
  for (const block of walkBlocks(blocks)) {
    if (sectionNameFromLine(block?.content) !== section) continue;
    const queryBlock = findQueryBlockInSection(block);
    if (queryBlock) return readQueryBlockContentFromSnapshot(queryBlock);
  }
  return null;
}

export function isQueryLikeContent(content: string): boolean {
  const text = String(content ?? '').trim();
  return (
    isAdvancedQueryBlockContent(text) ||
    isSimpleQueryBlockContent(text) ||
    text.includes('<% current page %>') ||
    text.includes('{{query') ||
    text.includes('Manual post-filter:') ||
    /^#Query\b/i.test(text)
  );
}
