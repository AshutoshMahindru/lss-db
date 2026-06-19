import { MODE, THROTTLE_MS, VERSION } from '../config';
import { isLogseqBuiltinTag } from './builtin-tags';
import { pageForCanonical } from '../registry';
import { safePageName, safeTag } from './names';
import type { Result } from './types';
import { formatError, sleep } from './runner';

export function blockId(block: any): string | null {
  return block?.uuid ?? block?.id ?? block?.[0]?.uuid ?? block?.[0]?.id ?? null;
}

export function blockContent(block: any): string {
  const text = String(block?.content ?? block?.properties?.content ?? '');
  const props = block?.properties ?? {};
  const extra: string[] = [];
  for (const key of ['lss-template-key', 'template-name', 'template']) {
    if (props[key] != null) extra.push(`${key}:: ${props[key]}`);
  }
  return [text, ...extra].filter(Boolean).join('\n');
}

export async function getPage(name: string): Promise<any | null> {
  try {
    return await logseq.Editor.getPage(name);
  } catch {
    return null;
  }
}

export async function resolvePageFromIdentity(identity: string | number): Promise<any | null> {
  const raw = String(identity ?? '').trim();
  if (!raw) return null;
  let page = await getPage(raw);
  if (page) return page;
  if (!logseq.Editor.getBlock) return null;
  try {
    const block = await logseq.Editor.getBlock(raw).catch(() => null);
    if (!block) return null;
    const blockRecord = block as Record<string, unknown>;
    const title = String(blockRecord.title ?? blockRecord.fullTitle ?? '').trim();
    if (title) {
      page = (await getPage(title)) || (await getPage(title.toLowerCase()));
      if (page) return page;
    }
    const blockPage = blockRecord.page as Record<string, unknown> | undefined;
    if (blockPage?.id != null) page = await getPage(String(blockPage.id));
    if (!page && blockPage?.uuid != null) page = await getPage(String(blockPage.uuid));
    if (!page && blockRecord.uuid != null) page = await getPage(String(blockRecord.uuid));
  } catch {
    return null;
  }
  return page;
}

export async function getBlocks(page: string): Promise<any[]> {
  try {
    return await logseq.Editor.getPageBlocksTree(page);
  } catch {
    return [];
  }
}

export function containsMarker(blocks: any[], marker: string): boolean {
  const stack = [...(blocks ?? [])];
  while (stack.length) {
    const b = stack.shift();
    if (String(b?.content ?? '').includes(marker)) return true;
    if (b?.children) stack.push(...b.children);
  }
  return false;
}

export function findBlockByMarker(blocks: any[], markerId: string): any | null {
  const marker = `lss-managed:${markerId}`;
  for (const block of walkBlocks(blocks)) {
    if (String(block?.content ?? '').includes(marker)) return block;
  }
  return null;
}

export async function ensurePage(
  result: Result,
  canonicalName: string,
  props: Record<string, any> = {},
): Promise<string> {
  const name = pageForCanonical(canonicalName);
  const fullProps = {
    ...props,
    'lss-current-page': name,
    'lss-canonical-page': canonicalName,
    'lss-plugin-mode': MODE,
    'lss-plugin-version': VERSION,
  };
  if (await getPage(name)) {
    result.actions.push(`SKIP page exists: ${name}`);
    return name;
  }
  try {
    await logseq.Editor.createPage(name, fullProps, { createFirstBlock: true });
    result.actions.push(`CREATE page: ${name}`);
    await sleep(THROTTLE_MS);
  } catch (error) {
    result.errors.push(`create-page ${name}: ${formatError(error)}`);
  }
  return name;
}

export async function appendManagedBlock(
  result: Result,
  canonicalPage: string,
  markerId: string,
  body: string,
): Promise<void> {
  const page = await ensurePage(result, canonicalPage);
  const marker = `lss-managed:${markerId}`;
  const blocks = await getBlocks(page);
  if (containsMarker(blocks, marker)) {
    result.actions.push(`SKIP block exists: ${page}:${markerId}`);
    return;
  }
  const content = `${body}\n\n<!-- ${marker} -->`;
  try {
    await logseq.Editor.appendBlockInPage(page, content);
    result.actions.push(`APPEND block: ${page}:${markerId}`);
    await sleep(THROTTLE_MS);
  } catch (error) {
    result.errors.push(`append-block ${page}:${markerId}: ${formatError(error)}`);
  }
}

export async function insertAtCursor(result: Result, content: string, label: string): Promise<void> {
  try {
    await logseq.Editor.insertAtEditingCursor(content);
    result.actions.push(`INSERT at cursor: ${label}`);
    await sleep(THROTTLE_MS);
  } catch (error) {
    result.errors.push(`insert-at-cursor ${label}: ${formatError(error)}`);
  }
}

export function walkBlocks(blocks: any[]): any[] {
  const out: any[] = [];
  const walk = (bs: any[]) => {
    for (const b of bs ?? []) {
      out.push(b);
      if (b?.children?.length) walk(b.children);
    }
  };
  walk(blocks);
  return out;
}

export function flattenBlockText(blocks: any[]): string {
  const out: string[] = [];
  const walk = (bs: any[]) => {
    for (const b of bs ?? []) {
      out.push(String(b?.content ?? ''));
      if (b?.children) walk(b.children);
    }
  };
  walk(blocks);
  return out.join('\n');
}

export async function currentPageName(): Promise<string | null> {
  try {
    const p = await logseq.Editor.getCurrentPage();
    return p?.originalName ?? p?.name ?? p?.title ?? null;
  } catch {
    return null;
  }
}

export async function updateBlockContent(
  result: Result,
  block: any,
  content: string,
  reason: string,
): Promise<void> {
  const id = blockId(block);
  if (!id) {
    result.errors.push(`update-block missing uuid/id for ${reason}`);
    return;
  }
  try {
    await logseq.Editor.updateBlock(id, content);
    result.actions.push(`UPDATE block: ${reason}`);
    await sleep(THROTTLE_MS);
  } catch (error) {
    result.errors.push(`update-block ${reason}: ${formatError(error)}`);
  }
}

export async function resolveTagEntity(tag: string): Promise<any | null> {
  const clean = safeTag(tag);
  if (!clean) return null;
  let obj = await logseq.Editor.getTag(clean).catch(() => null);
  if (obj) return obj;
  if (logseq.Editor.getTagsByName) {
    const matches = await logseq.Editor.getTagsByName(clean).catch(() => null);
    if (matches?.length) return matches[0];
  }
  if (!isLogseqBuiltinTag(clean)) {
    obj = await logseq.Editor.createTag(clean).catch(() => null);
  }
  return obj;
}

export async function ensureTagByName(result: Result, tag: string): Promise<any | null> {
  const clean = safeTag(tag);
  if (!clean) return null;
  try {
    const obj = await resolveTagEntity(clean);
    if (!obj && isLogseqBuiltinTag(clean)) {
      result.notes.push(`Built-in tag #${clean} is managed by Logseq; skipped createTag.`);
    }
    return obj;
  } catch (error) {
    result.errors.push(`tag #${clean}: ${formatError(error)}`);
    return null;
  }
}

export async function resolveVisibleNodeToken(result: Result, token: string): Promise<string> {
  const raw = String(token ?? '').trim();
  if (!raw) return raw;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) {
    return raw;
  }
  let node: any = null;
  try {
    node = logseq.Editor.getPage ? await logseq.Editor.getPage(raw).catch(() => null) : null;
  } catch {
    /* ignore */
  }
  if (!node) {
    try {
      node = logseq.Editor.getBlock ? await logseq.Editor.getBlock(raw).catch(() => null) : null;
    } catch {
      /* ignore */
    }
  }
  const visible = node?.name ?? node?.originalName ?? node?.title ?? node?.content ?? null;
  if (visible) {
    const resolved = safePageName(visible);
    result.actions.push(`RESOLVE visible node token: ${raw} -> ${resolved}`);
    return resolved;
  }
  result.notes.push(`Could not resolve UUID-like visible node token ${raw}; leaving it unchanged.`);
  return raw;
}

export function pageVisibleName(page: any): string {
  return String(page?.originalName ?? page?.name ?? page?.title ?? page?.content ?? '').trim();
}