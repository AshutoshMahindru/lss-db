import { MODE, THROTTLE_MS, VERSION } from '../config';
import { isLogseqBuiltinTag } from './builtin-tags';
import { pageForCanonical } from '../registry';
import { entityVisibleLabel, looksLikeUuid, safePageName, safeTag } from './names';
import type { CommandContext, Result } from './types';
import { formatError, sleep } from './runner';

export function blockId(block: any): string | null {
  return block?.uuid ?? block?.id ?? block?.[0]?.uuid ?? block?.[0]?.id ?? null;
}

function samePageIdentity(a: any, b: any): boolean {
  const aid = a?.id ?? a?.[':db/id'] ?? a?.['db/id'];
  const bid = b?.id ?? b?.[':db/id'] ?? b?.['db/id'];
  if (aid != null && bid != null && String(aid) === String(bid)) return true;
  const au = a?.uuid ?? a?.[':block/uuid'] ?? a?.['block/uuid'];
  const bu = b?.uuid ?? b?.[':block/uuid'] ?? b?.['block/uuid'];
  if (au && bu && String(au) === String(bu)) return true;
  const an = safePageName(pageVisibleName(a)).toLowerCase();
  const bn = safePageName(pageVisibleName(b)).toLowerCase();
  return Boolean(an && bn && an === bn);
}

function blockIdentityValues(block: any): string[] {
  return [
    block?.uuid,
    block?.id,
    block?.[':block/uuid'],
    block?.['block/uuid'],
    block?.[':db/id'],
    block?.['db/id'],
  ]
    .map((value) => String(value ?? '').trim())
    .filter(Boolean);
}

function blockMatchesRef(block: any, ref: string | number): boolean {
  const raw = String(ref ?? '').trim();
  return Boolean(raw && blockIdentityValues(block).includes(raw));
}

async function blockPageRecord(blockRef: string | number): Promise<Record<string, unknown> | null> {
  if (logseq.Editor.getBlock) {
    const block = (await logseq.Editor.getBlock(blockRef).catch(() => null)) as Record<string, unknown> | null;
    const page = normalizePageEntityRecord((block?.page as Record<string, unknown> | null) ?? null);
    if (page) return page;
  }
  if (!logseq.DB?.datascriptQuery) return null;
  const raw = String(blockRef).trim();
  try {
    const rows = /^\d+$/.test(raw)
      ? await logseq.DB.datascriptQuery(
        '[:find (pull ?p [*]) :in $ ?e :where [?b :db/id ?e] [?b :block/page ?p]]',
        Number(raw),
      )
      : await logseq.DB.datascriptQuery(
        '[:find (pull ?p [*]) :in $ ?u :where [?b :block/uuid ?u] [?b :block/page ?p]]',
        `#uuid "${raw}"`,
      );
    return normalizePageEntityRecord((Array.isArray(rows) ? rows[0]?.[0] : null) as Record<string, unknown> | null);
  } catch {
    return null;
  }
}

async function blockEntityId(blockRef: string | number): Promise<number | null> {
  const raw = String(blockRef).trim();
  if (/^\d+$/.test(raw)) return Number(raw);
  if (!logseq.DB?.datascriptQuery) return null;
  try {
    const rows = await logseq.DB.datascriptQuery(
      '[:find ?e :in $ ?u :where [?e :block/uuid ?u]]',
      `#uuid "${raw}"`,
    );
    const id = Array.isArray(rows) ? rows[0]?.[0] : null;
    return typeof id === 'number' && id > 0 ? id : null;
  } catch {
    return null;
  }
}

async function blockParentEntityId(blockRef: string | number): Promise<number | null> {
  const entityId = await blockEntityId(blockRef);
  if (entityId == null || !logseq.DB?.datascriptQuery) return null;
  try {
    const rows = await logseq.DB.datascriptQuery(
      '[:find ?p :in $ ?e :where [?b :db/id ?e] [?b :block/parent ?p]]',
      entityId,
    );
    const parentId = Array.isArray(rows) ? rows[0]?.[0] : null;
    return typeof parentId === 'number' && parentId > 0 ? parentId : null;
  } catch {
    return null;
  }
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

async function resolvePageByUuid(uuid: string): Promise<any | null> {
  const raw = String(uuid ?? '').trim();
  if (!looksLikeUuid(raw) || !logseq.DB?.datascriptQuery) return null;
  try {
    const rows = await logseq.DB.datascriptQuery(
      `[:find (pull ?b [*])
 :in $ ?u
 :where
 [?b :block/uuid ?u]
 [?b :block/name]]`,
      `#uuid "${raw}"`,
    );
    const record = Array.isArray(rows) ? rows[0]?.[0] : null;
    const normalized = normalizePageEntityRecord((record as Record<string, unknown> | null) ?? null);
    return pageVisibleName(normalized) ? normalized : null;
  } catch {
    return null;
  }
}

async function resolvePageByDatascriptName(rawName: string): Promise<any | null> {
  if (!logseq.DB?.datascriptQuery) return null;
  const values = [
    rawName,
    safePageName(rawName),
    rawName.toLowerCase(),
    safePageName(rawName).toLowerCase(),
  ]
    .map((value) => String(value ?? '').trim())
    .filter(Boolean);
  const attrs = [':block/name', ':block/original-name', ':block/title'];
  const seen = new Set<string>();
  for (const attr of attrs) {
    for (const value of values) {
      const key = `${attr}:${value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        const rows = await logseq.DB.datascriptQuery(
          `[:find (pull ?b [*])
 :in $ ?v
 :where
 [?b ${attr} ?v]]`,
          value,
        );
        const record = Array.isArray(rows) ? rows[0]?.[0] : null;
        const normalized = normalizePageEntityRecord((record as Record<string, unknown> | null) ?? null);
        if (pageVisibleName(normalized, value)) return normalized;
      } catch {
        /* try next page identity field */
      }
    }
  }
  return null;
}

export async function resolvePageFromIdentity(identity: string | number): Promise<any | null> {
  const raw = String(identity ?? '').trim();
  if (!raw) return null;
  let page =
    (await getPage(raw)) ||
    (await getPage(safePageName(raw))) ||
    (await getPage(raw.toLowerCase()));
  if (page) return page;
  if (/^\d+$/.test(raw)) {
    page = await resolvePageByDbId(raw);
    if (page) return page;
  }
  if (looksLikeUuid(raw)) {
    page = await resolvePageByUuid(raw);
    if (page) return page;
  }
  page = await resolvePageByDatascriptName(raw);
  if (page) return page;
  if (!logseq.Editor.getBlock) return null;
  try {
    const block = await logseq.Editor.getBlock(raw).catch(() => null);
    if (!block) return null;
    const blockRecord = block as Record<string, unknown>;
    const title = String(blockRecord.title ?? blockRecord.fullTitle ?? '').trim();
    if (title) {
      page = title === raw ? await resolvePageByDatascriptName(title) : await resolvePageFromIdentity(title);
      if (page) return page;
    }
    const blockPage = normalizePageEntityRecord((blockRecord.page as Record<string, unknown> | null) ?? null);
    if (blockPage?.id != null) page = await resolvePageByDbId(blockPage.id as string | number);
    if (!page && blockPage?.uuid != null && String(blockPage.uuid) !== raw) page = await resolvePageFromIdentity(String(blockPage.uuid));
    if (!page && blockRecord.uuid != null && String(blockRecord.uuid) !== raw) page = await resolvePageFromIdentity(String(blockRecord.uuid));
    if (!page && blockRecord.id != null) page = await resolvePageByDbId(blockRecord.id as string | number);
  } catch {
    return null;
  }
  return page;
}

export async function getBlocks(page: string | number): Promise<any[]> {
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

export async function blockBelongsToPage(blockRef: string | number, pageName: string): Promise<boolean> {
  const target = await resolvePageFromIdentity(pageName);
  const actual = await blockPageRecord(blockRef);
  return Boolean(target && actual && samePageIdentity(target, actual));
}

export async function filterBlocksForPage(blocks: any[], pageName: string): Promise<any[]> {
  const out: any[] = [];
  for (const block of blocks ?? []) {
    const id = blockId(block);
    if (id && await blockBelongsToPage(id, pageName)) out.push(block);
  }
  return out;
}

export async function filterTopLevelBlocksForPage(blocks: any[], pageName: string): Promise<any[]> {
  const page = await resolvePageFromIdentity(pageName);
  const pageRootId = blockId(page);
  const pageEntityId = pageRootId ? await blockEntityId(pageRootId) : null;
  if (pageEntityId == null) return filterBlocksForPage(blocks, pageName);
  const out: any[] = [];
  let sawParentMetadata = false;
  for (const block of blocks ?? []) {
    const id = blockId(block);
    if (!id) continue;
    const parentId = await blockParentEntityId(id);
    if (parentId != null) sawParentMetadata = true;
    if (parentId === pageEntityId) out.push(block);
  }
  if (out.length) return out;
  if (!sawParentMetadata) return blocks ?? [];
  return out;
}

function findBlockInTree(blocks: any[], ref: string | number): any | null {
  for (const block of walkBlocks(blocks ?? [])) {
    if (blockMatchesRef(block, ref)) return block;
  }
  return null;
}

async function blockTreeParentMatches(
  targetPageName: string,
  parentBlockId: string | number,
  childBlockId: string | number,
): Promise<boolean> {
  const blocks = await getBlocks(targetPageName);
  const page = await resolvePageFromIdentity(targetPageName);
  if (page && blockMatchesRef(page, parentBlockId)) {
    return (blocks ?? []).some((block) => blockMatchesRef(block, childBlockId));
  }
  const parent = findBlockInTree(blocks, parentBlockId);
  return Boolean((parent?.children ?? []).some((child: any) => blockMatchesRef(child, childBlockId)));
}

export async function insertBlockUnderParentVerified(
  result: Result,
  targetPageName: string,
  parentBlockId: string | number,
  content: string,
  label: string,
): Promise<any | null> {
  if (!logseq.Editor.insertBlock) return null;
  const expectedParentId = await blockEntityId(parentBlockId);
  const inserted = await logseq.Editor.insertBlock(parentBlockId, content, {
    sibling: false,
    before: false,
    end: true,
  });
  const id = blockId(inserted);
  let actualParentId: number | null = null;
  let verifiedByPageTree = false;
  if (id) {
    for (let attempt = 0; attempt < 6; attempt++) {
      actualParentId = await blockParentEntityId(id);
      if (actualParentId != null) break;
      verifiedByPageTree = await blockTreeParentMatches(targetPageName, parentBlockId, id).catch(() => false);
      if (verifiedByPageTree) break;
      await sleep(THROTTLE_MS * (attempt + 1));
    }
  }
  const verifiedByParentId =
    Boolean(id && expectedParentId != null && actualParentId === expectedParentId && await blockBelongsToPage(id, targetPageName));
  if (id && (verifiedByParentId || verifiedByPageTree)) {
    result.actions.push(`INSERT block under verified parent on ${targetPageName}: ${label}`);
    await sleep(THROTTLE_MS);
    return inserted;
  }
  if (id && logseq.Editor.removeBlock) {
    await logseq.Editor.removeBlock(id).catch(() => null);
  }
  result.errors.push(
    `insert block ${label}: Logseq inserted outside expected parent for ${targetPageName} (expected parent ${expectedParentId ?? 'unknown'}, got ${actualParentId ?? 'unknown'}); removed unsafe block`,
  );
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

export async function ensureExactPage(
  result: Result,
  pageName: string,
  props: Record<string, any> = {},
): Promise<string> {
  const name = String(pageName ?? '').trim();
  if (!name) {
    result.errors.push('create-page: blank page name');
    return name;
  }
  const fullProps = {
    ...props,
    'lss-current-page': name,
    'lss-canonical-page': name,
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

export async function appendBlockInPageVerified(
  result: Result,
  pageName: string,
  content: string,
  label: string,
  verifyMarker?: string,
): Promise<boolean> {
  const hasAppendApi = Boolean(logseq.Editor.appendBlockInPage);
  const verifyInserted = async (): Promise<boolean> => {
    const marker = verifyMarker || String(content ?? '').slice(0, 160);
    for (let attempt = 0; attempt < 4; attempt++) {
      await sleep(THROTTLE_MS * (attempt + 1));
      const blocks = await getBlocks(pageName);
      if (marker && walkBlocks(blocks).some((block) => String(block?.content ?? '').includes(marker))) return true;
    }
    return false;
  };
  const insertViaPageRoot = async (): Promise<boolean> => {
    if (!logseq.Editor.insertBlock) return false;
    const page = await resolvePageFromIdentity(pageName);
    const pageRootId = blockId(page);
    if (!pageRootId) return false;
    const inserted = await insertBlockUnderParentVerified(result, pageName, pageRootId, content, label);
    if (inserted || (await verifyInserted())) {
      if (!inserted) result.actions.push(`INSERT block via page root: ${label}`);
      await sleep(THROTTLE_MS);
      return true;
    }
    return false;
  };
  try {
    let inserted = hasAppendApi
      ? await logseq.Editor.appendBlockInPage(pageName, content)
      : null;
    const id = blockId(inserted);
    if (id) {
      result.actions.push(`APPEND block: ${label}`);
      await sleep(THROTTLE_MS);
      return true;
    }
    if (await verifyInserted()) {
      result.actions.push(`APPEND block: ${label}`);
      return true;
    }
    if (await insertViaPageRoot()) return true;
    if (!hasAppendApi) {
      result.errors.push(`append-block ${label}: appendBlockInPage API unavailable and page-root insert failed`);
      return false;
    }
    result.errors.push(`append-block ${label}: no block returned by Logseq and inserted content was not visible after retry`);
    return false;
  } catch (error) {
    if (await insertViaPageRoot().catch(() => false)) return true;
    result.errors.push(`append-block ${label}: ${formatError(error)}`);
    return false;
  }
}

async function currentPageFromCurrentBlocks(): Promise<string | null> {
  if (!logseq.Editor.getCurrentPageBlocksTree) return null;
  try {
    const blocks = await logseq.Editor.getCurrentPageBlocksTree();
    for (const block of walkBlocks(blocks ?? [])) {
      const page = normalizePageEntityRecord(((block as Record<string, unknown>)?.page as Record<string, unknown> | null) ?? null);
      const pageName = pageVisibleName(page);
      if (pageName) return pageName;
    }
  } catch {
    return null;
  }
  return null;
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
  await appendBlockInPageVerified(result, page, content, `${page}:${markerId}`, marker);
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
  let token = decoded.replace(/^#/, '').replace(/^\[\[/, '').replace(/\]\]$/, '').trim();
  const pageRouteMatch = token.match(/\/page\/([^/?#&]+)/i);
  if (pageRouteMatch?.[1]) token = pageRouteMatch[1].trim();
  const namedPageMatch = token.match(/[?&](?:page|name)=([^&#]+)/i);
  if (namedPageMatch?.[1]) token = namedPageMatch[1].trim();
  if (!token || token === '/' || /^\/?(journals?|graph|all-pages|plugins|logseq)\b/i.test(token)) return null;
  if (looksLikeUuid(token) && logseq.Editor.getBlock) {
    const page = await resolvePageByUuid(token);
    const pageName = pageVisibleName(page);
    if (pageName) return pageName;
    const block = await logseq.Editor.getBlock(token).catch(() => null);
    const blockPage = normalizePageEntityRecord(((block as Record<string, unknown> | null)?.page as Record<string, unknown> | null) ?? null);
    const blockPageName = pageVisibleName(blockPage);
    if (blockPageName) return blockPageName;
    const datascriptPage = await blockPageRecord(token);
    const datascriptPageName = pageVisibleName(datascriptPage);
    if (datascriptPageName) return datascriptPageName;
    const directPage = await resolvePageByUuid(token);
    return pageVisibleName(directPage) || null;
  }
  const page =
    (await resolvePageFromIdentity(token).catch(() => null)) ||
    (await getPage(token)) ||
    (await getPage(safePageName(token))) ||
    (await getPage(token.toLowerCase()));
  return pageVisibleName(page) || null;
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
    add(host?.location?.href);
    add(host?.location?.pathname);
    add(host?.document?.title);
  } catch {
    /* cross-frame access may be unavailable */
  }
  try {
    const topHash = window.top?.location?.hash;
    add(topHash);
    add(window.top?.location?.href);
    add(window.top?.location?.pathname);
  } catch {
    /* cross-frame access may be unavailable */
  }
  try {
    add(window.location?.hash);
    add(window.location?.href);
    add(window.location?.pathname);
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

function commandContextIdentityCandidates(context?: CommandContext): string[] {
  const out: string[] = [];
  const seen = new Set<unknown>();
  const keys = new Set([
    'uuid',
    'id',
    'blockUuid',
    'blockUUID',
    'blockId',
    'blockID',
    'page',
    'pageName',
    'pageId',
    'pageUuid',
    'payload',
    'block',
    'currentBlock',
    'editingBlock',
  ]);
  const add = (value: unknown, depth = 0) => {
    if (value == null || depth > 4 || seen.has(value)) return;
    seen.add(value);
    if (typeof value === 'string' || typeof value === 'number') {
      const raw = String(value).trim();
      if (raw) out.push(raw);
      return;
    }
    if (typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    const pageName = pageVisibleName(normalizePageEntityRecord(record));
    if (pageName) out.push(pageName);
    for (const [key, child] of Object.entries(record)) {
      if (keys.has(key)) add(child, depth + 1);
    }
  };
  add(context);
  return [...new Set(out)];
}

async function currentPageFromCommandContext(context?: CommandContext): Promise<string | null> {
  for (const candidate of commandContextIdentityCandidates(context)) {
    if (looksLikeUuid(candidate) && logseq.Editor.getBlock) {
      const block = await logseq.Editor.getBlock(candidate).catch(() => null);
      const blockPage = normalizePageEntityRecord(
        ((block as Record<string, unknown> | null)?.page as Record<string, unknown> | null) ?? null,
      );
      const blockPageName = pageVisibleName(blockPage);
      if (blockPageName) return blockPageName;
    }
    const pageName = await pageNameFromIdentityCandidate(candidate);
    if (pageName) return pageName;
  }
  return null;
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

type CurrentPageNameOptions = {
  reject?: (pageName: string) => boolean;
};

function acceptedPageName(name: string | null, options?: CurrentPageNameOptions): string | null {
  if (!name) return null;
  return options?.reject?.(name) ? null : name;
}

export async function currentPageName(context?: CommandContext, options: CurrentPageNameOptions = {}): Promise<string | null> {
  const fromCommandContext = await currentPageFromCommandContext(context);
  const acceptedCommandContext = acceptedPageName(fromCommandContext, options);
  if (acceptedCommandContext) return acceptedCommandContext;

  const fromRoute = await currentPageFromRoute();
  const acceptedRoute = acceptedPageName(fromRoute, options);
  if (acceptedRoute) return acceptedRoute;

  const fromDom = await currentPageFromHostDom();
  const acceptedDom = acceptedPageName(fromDom, options);
  if (acceptedDom) return acceptedDom;

  const fromCurrentBlocks = await currentPageFromCurrentBlocks();
  const acceptedCurrentBlocks = acceptedPageName(fromCurrentBlocks, options);
  if (acceptedCurrentBlocks) return acceptedCurrentBlocks;

  try {
    const p = await logseq.Editor.getCurrentPage();
    const name = pageVisibleName(p);
    const acceptedCurrentPage = acceptedPageName(name, options);
    if (acceptedCurrentPage) return acceptedCurrentPage;
  } catch {
    /* try later fallbacks */
  }

  const fromFocusedBlock = await currentPageFromFocusedBlock();
  const acceptedFocusedBlock = acceptedPageName(fromFocusedBlock, options);
  if (acceptedFocusedBlock) return acceptedFocusedBlock;

  return null;
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
