import { MODE, THROTTLE_MS, VERSION } from '../config';
import { isLogseqBuiltinTag } from './builtin-tags';
import { pageForCanonical } from '../registry';
import { entityVisibleLabel, looksLikeUuid, safePageName, safeTag } from './names';
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

function normalizePageEntityRecord(record: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!record) return null;
  return {
    ...record,
    id: record.id ?? record[':db/id'] ?? record['db/id'],
    uuid: record.uuid ?? record[':block/uuid'] ?? record['block/uuid'],
    name: record.name ?? record[':block/name'] ?? record['block/name'],
    originalName:
      record.originalName ??
      record[':block/original-name'] ??
      record['block/original-name'] ??
      record.title ??
      record[':block/title'] ??
      record['block/title'],
    title: record.title ?? record[':block/title'] ?? record['block/title'],
  };
}

async function resolvePageByDbId(entityId: string | number): Promise<any | null> {
  const id = Number(entityId);
  if (!Number.isFinite(id) || id <= 0 || !logseq.DB?.datascriptQuery) return null;
  try {
    const rows = await logseq.DB.datascriptQuery(
      `[:find (pull ?b [*])
 :in $ ?id
 :where
 [?b :db/id ?id]]`,
      id,
    );
    const record = Array.isArray(rows) ? rows[0]?.[0] : null;
    return normalizePageEntityRecord((record as Record<string, unknown> | null) ?? null);
  } catch {
    return null;
  }
}

export async function resolvePageFromIdentity(identity: string | number): Promise<any | null> {
  const raw = String(identity ?? '').trim();
  if (!raw) return null;
  let page = await getPage(raw);
  if (page) return page;
  if (/^\d+$/.test(raw)) {
    page = await resolvePageByDbId(raw);
    if (page) return page;
  }
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
    if (!page && blockRecord.id != null) page = await resolvePageByDbId(blockRecord.id as string | number);
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

async function pageNameFromIdentityCandidate(candidate: unknown): Promise<string | null> {
  const raw = String(candidate ?? '').trim();
  if (!raw) return null;
  const decoded = decodeURIComponent(raw).trim();
  const token = decoded.replace(/^#/, '').replace(/^\[\[/, '').replace(/\]\]$/, '').trim();
  if (!token || token === '/' || /^\/?(journals?|graph|all-pages|plugins|logseq)\b/i.test(token)) return null;
  if (looksLikeUuid(token) && logseq.Editor.getBlock) {
    const block = await logseq.Editor.getBlock(token).catch(() => null);
    const blockPage = normalizePageEntityRecord(((block as Record<string, unknown> | null)?.page as Record<string, unknown> | null) ?? null);
    const blockPageName = pageVisibleName(blockPage);
    if (blockPageName) return blockPageName;
  }
  const page =
    (await resolvePageFromIdentity(token).catch(() => null)) ||
    (await getPage(token)) ||
    (await getPage(safePageName(token))) ||
    (await getPage(token.toLowerCase()));
  return pageVisibleName(page, token) || null;
}

function routePageCandidates(route: any): string[] {
  const out: string[] = [];
  const add = (value: unknown) => {
    const raw = String(value ?? '').trim();
    if (raw && !out.includes(raw)) out.push(raw);
  };
  const params = (route?.parameters ?? {}) as Record<string, unknown>;
  for (const key of ['name', 'page', 'pageName', 'page-name', 'id', 'uuid', 'blockId', 'block-id']) {
    add(params[key]);
  }
  add(route?.path);

  try {
    const host = (logseq.Experiments as { ensureHostScope?: () => Window } | undefined)?.ensureHostScope?.() ?? window.top;
    add(host?.location?.hash);
    add(host?.document?.title);
  } catch {
    /* cross-frame access may be unavailable */
  }
  try {
    const topHash = window.top?.location?.hash;
    add(topHash);
  } catch {
    /* cross-frame access may be unavailable */
  }
  try {
    add(window.location?.hash);
  } catch {
    /* ignore */
  }

  const expanded: string[] = [];
  for (const raw of out) {
    const decoded = decodeURIComponent(raw).trim();
    const path = decoded.replace(/^#/, '');
    const pageMatch = path.match(/\/page\/([^/?#]+)/i);
    if (pageMatch?.[1]) expanded.push(pageMatch[1]);
    const namedMatch = path.match(/[?&](?:page|name)=([^&#]+)/i);
    if (namedMatch?.[1]) expanded.push(namedMatch[1]);
    expanded.push(path.replace(/[?#].*$/, ''));
  }
  return [...new Set(expanded)];
}

async function currentPageFromFocusedBlock(): Promise<string | null> {
  if (!logseq.Editor.getCurrentBlock) return null;
  try {
    const block = await logseq.Editor.getCurrentBlock();
    const page = normalizePageEntityRecord(((block as Record<string, unknown> | null)?.page as Record<string, unknown> | null) ?? null);
    return pageVisibleName(page) || null;
  } catch {
    return null;
  }
}

async function currentPageFromRoute(): Promise<string | null> {
  let route: any = null;
  try {
    route = await logseq.App.getCurrentRoute?.();
  } catch {
    route = null;
  }
  for (const candidate of routePageCandidates(route)) {
    const name = await pageNameFromIdentityCandidate(candidate);
    if (name) return name;
  }
  return null;
}

function hostDocument(): Document | null {
  try {
    const host = (logseq.Experiments as { ensureHostScope?: () => Window } | undefined)?.ensureHostScope?.();
    if (host?.document) return host.document;
  } catch {
    /* host scope can be unavailable before the app shell is ready */
  }
  try {
    return window.top?.document ?? document;
  } catch {
    return document;
  }
}

function isHostChromeElement(el: Element): boolean {
  return Boolean(
    el.closest(
      [
        'nav',
        'aside',
        '[role="navigation"]',
        '.left-sidebar',
        '.cp__left-sidebar',
        '.cp__right-sidebar',
        '[class*="left-sidebar"]',
        '[class*="right-sidebar"]',
        '[class*="sidebar-item"]',
      ].join(','),
    ),
  );
}

function visibleElementScore(el: Element, viewportHeight: number): number {
  if (isHostChromeElement(el)) return -1;
  const rect = el.getBoundingClientRect();
  if (rect.width < 20 || rect.height < 12) return -1;
  if (rect.bottom < 0 || rect.top > viewportHeight) return -1;
  const style = el.ownerDocument.defaultView?.getComputedStyle(el);
  if (!style || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return -1;
  const fontSize = Number.parseFloat(style.fontSize || '0') || 0;
  const aboveFoldBonus = rect.top >= 0 && rect.top < Math.max(480, viewportHeight * 0.55) ? 1000 : 0;
  const mainPaneBonus = rect.left >= 160 ? 260 : -600;
  const mainRootBonus = el.closest('main,[role="main"],.cp__sidebar-main-content') ? 500 : 0;
  return aboveFoldBonus + mainPaneBonus + mainRootBonus + fontSize * 14 - Math.max(0, rect.top);
}

function titleCandidatesFromElement(el: Element): string[] {
  const raw = String((el as HTMLElement).innerText || el.textContent || '').trim();
  if (!raw) return [];
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^(add icon|set property|add property|live query|#query)$/i.test(line))
    .filter((line) => !/[{}()[\]]/.test(line) || /^\[\[[^\]]+\]\]$/.test(line))
    .filter((line) => line.length <= 160);
}

async function currentPageFromHostDom(): Promise<string | null> {
  const doc = hostDocument();
  if (!doc) return null;
  const win = doc.defaultView ?? window;
  const viewportHeight = win.innerHeight || 900;
  const selectors = [
    '[data-testid="page-title"]',
    '[data-test-id="page-title"]',
    '.page-title',
    '.ls-page-title',
    '.page h1',
    'main h1',
    'h1',
    '[contenteditable="true"][class*="title"]',
    '[class*="page"][class*="title"]',
  ];
  const scored: Array<{ text: string; score: number }> = [];
  const seen = new Set<Element>();
  const collect = (selector: string, broadPenalty = 0) => {
    for (const el of Array.from(doc.querySelectorAll(selector))) {
      if (seen.has(el)) continue;
      seen.add(el);
      const score = visibleElementScore(el, viewportHeight) - broadPenalty;
      if (score < 0) continue;
      for (const text of titleCandidatesFromElement(el)) scored.push({ text, score });
    }
  };
  for (const selector of selectors) collect(selector);
  if (!scored.length) {
    const root =
      doc.querySelector('main') ||
      doc.querySelector('[role="main"]') ||
      doc.querySelector('.cp__sidebar-main-content') ||
      doc.body;
    for (const el of Array.from(root.querySelectorAll('h1,h2,[contenteditable="true"],div,span,a')).slice(0, 500)) {
      if (isHostChromeElement(el)) continue;
      if (seen.has(el)) continue;
      seen.add(el);
      const score = visibleElementScore(el, viewportHeight) - 120;
      if (score < 0) continue;
      for (const text of titleCandidatesFromElement(el)) scored.push({ text, score });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  for (const candidate of scored) {
    const name = await pageNameFromIdentityCandidate(candidate.text);
    if (name) return name;
  }
  return null;
}

export async function currentPageName(): Promise<string | null> {
  const fromRoute = await currentPageFromRoute();
  if (fromRoute) return fromRoute;

  try {
    const p = await logseq.Editor.getCurrentPage();
    const name = pageVisibleName(p);
    if (name) return name;
  } catch {
    /* try DOM fallback */
  }

  const fromDom = await currentPageFromHostDom();
  if (fromDom) return fromDom;

  return await currentPageFromFocusedBlock();
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
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw);
  const isDbId = /^\d+$/.test(raw);
  if (!isUuid && !isDbId) {
    return raw;
  }
  const node = await resolvePageFromIdentity(raw);
  const visible = pageVisibleName(node);
  if (visible) {
    const resolved = safePageName(visible);
    result.actions.push(`RESOLVE visible node token: ${raw} -> ${resolved}`);
    return resolved;
  }
  result.notes.push(`Could not resolve DB node token ${raw}; leaving it unchanged.`);
  return raw;
}

export function pageVisibleName(page: any, fallback = ''): string {
  return entityVisibleLabel((page as Record<string, unknown> | null) ?? null, fallback);
}
