import { entityIdentity, pageHasClassTag } from '../core/db-properties';
import { blockId, getBlocks, getPage, walkBlocks } from '../core/editor';
import { formatError, newResult } from '../core/runner';
import { safePageName, safeTag } from '../core/names';
import { allObjects } from '../registry';
import { isQueryLikeContent, relationshipPropertyNames } from './queries';
import { repairNamedPage } from './repair';

const DEBOUNCE_MS = 1800;
const COOLDOWN_MS = 5000;
const SKIP_PAGE_RE =
  /^(LSS |LSS$|Template\/|Dashboard\/|Entity-Page\/|Tag Properties\/|Property Reference\/|DB Tag\/|Tag Reference\/|Relationship\/|Area\/)/i;

const RELATIONSHIP_PROPERTIES = new Set(relationshipPropertyNames());
const LSS_OBJECT_TAGS = new Set(allObjects().map((o) => safeTag(o.tag)).filter(Boolean));

const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();
const cooldownUntil = new Map<string, number>();
const repairingPages = new Set<string>();
let repairSessionDepth = 0;

export function enterRepairSession(): void {
  repairSessionDepth++;
}

export function exitRepairSession(): void {
  repairSessionDepth = Math.max(0, repairSessionDepth - 1);
}

export function isRepairSessionActive(): boolean {
  return repairSessionDepth > 0;
}

export function markRepairCooldown(pageName: string, ms = COOLDOWN_MS * 3): void {
  const name = String(pageName ?? '').trim();
  if (!name) return;
  cooldownUntil.set(name, Date.now() + ms);
  const pending = pendingTimers.get(name);
  if (pending) {
    clearTimeout(pending);
    pendingTimers.delete(name);
  }
}

function shouldSkipPage(pageName: string): boolean {
  const name = String(pageName ?? '').trim();
  if (!name) return true;
  return SKIP_PAGE_RE.test(name);
}

function isUserPageEntity(page: Record<string, unknown> | null): boolean {
  if (!page) return false;
  const type = String(page.type ?? 'page').toLowerCase();
  return type === 'page' || type === 'whiteboard';
}

function txAttributeRelevant(attribute: string): boolean {
  const attr = String(attribute ?? '').toLowerCase();
  if (!attr) return false;
  if (attr.includes('tags')) return true;
  if (attr.includes('lss-object-type')) return true;
  for (const prop of RELATIONSHIP_PROPERTIES) {
    if (attr.includes(prop.toLowerCase())) return true;
  }
  return false;
}

function blockText(block: Record<string, unknown>): string {
  return String(block.content ?? block.title ?? '');
}

function blockContentRelevant(content: string): boolean {
  const text = String(content ?? '');
  if (!text) return false;
  if (text.includes('<% current page %>')) return true;
  if (isQueryLikeContent(text)) return true;
  if (/\blss-object-type::/i.test(text)) return true;
  if (text.includes('lss-managed:')) return true;
  for (const prop of RELATIONSHIP_PROPERTIES) {
    if (new RegExp(`\\b${prop}::`, 'i').test(text)) return true;
  }
  for (const tag of LSS_OBJECT_TAGS) {
    if (text.includes(`#${tag}`)) return true;
  }
  return false;
}

function txDataRelevant(txData: Array<[number, string, unknown, number, boolean]>): boolean {
  return (txData ?? []).some((tuple) => txAttributeRelevant(tuple[1]));
}

async function resolvePageRecord(pageRef: unknown): Promise<Record<string, unknown> | null> {
  if (pageRef == null) return null;
  const pageId =
    typeof pageRef === 'object'
      ? (pageRef as Record<string, unknown>).id ?? (pageRef as Record<string, unknown>).uuid
      : pageRef;
  if (pageId == null) return null;
  const page = await getPage(String(pageId)).catch(() => null);
  return page as Record<string, unknown> | null;
}

async function pageNameFromChangedBlock(block: Record<string, unknown>): Promise<string | null> {
  const uuid = typeof block.uuid === 'string' ? block.uuid : null;
  if (uuid) {
    const asPage = (await getPage(uuid).catch(() => null)) as Record<string, unknown> | null;
    if (isUserPageEntity(asPage)) {
      const pageName = asPage?.originalName ?? asPage?.name ?? asPage?.title;
      if (pageName) return String(pageName);
    }
  }

  const page = await resolvePageRecord(block.page);
  if (!isUserPageEntity(page)) return null;
  const pageName = page?.originalName ?? page?.name ?? page?.title;
  return pageName ? String(pageName) : null;
}

function changeEventRelevant(
  blocks: Array<Record<string, unknown>>,
  txData: Array<[number, string, unknown, number, boolean]>,
): boolean {
  if (txDataRelevant(txData)) return true;
  return (blocks ?? []).some((block) => blockContentRelevant(blockText(block)));
}

async function collectPageNames(blocks: Array<Record<string, unknown>>): Promise<Set<string>> {
  const pages = new Set<string>();
  for (const block of blocks ?? []) {
    const pageName = await pageNameFromChangedBlock(block);
    if (pageName && !shouldSkipPage(pageName)) pages.add(pageName);
  }
  return pages;
}

async function readPageRecord(pageName: string): Promise<Record<string, unknown> | null> {
  const page =
    (await getPage(pageName)) ||
    (await getPage(safePageName(pageName))) ||
    (await getPage(safeTag(pageName)));
  return page as Record<string, unknown> | null;
}

async function pageQualifiesForAutoRepair(pageName: string): Promise<boolean> {
  const page = await readPageRecord(pageName);
  if (!isUserPageEntity(page)) return false;

  const pageBlockId = blockId(page);
  if (!pageBlockId) return false;

  try {
    const props = logseq.Editor.getPageProperties
      ? await logseq.Editor.getPageProperties(pageName).catch(() => null)
      : null;
    if (props?.['lss-object-type']) return true;
    for (const prop of RELATIONSHIP_PROPERTIES) {
      if (props?.[prop] != null && props[prop] !== '') return true;
    }
  } catch {
    /* ignore */
  }

  const identity = entityIdentity(pageBlockId);
  if (identity) {
    for (const tag of LSS_OBJECT_TAGS) {
      if (await pageHasClassTag(identity, tag)) return true;
    }
  }

  const blocks = await getBlocks(pageName);
  for (const block of walkBlocks(blocks)) {
    if (blockContentRelevant(String(block?.content ?? block?.title ?? ''))) return true;
  }

  return false;
}

async function runAutoRepair(pageName: string): Promise<void> {
  if (shouldSkipPage(pageName) || repairingPages.has(pageName)) return;

  const page = await readPageRecord(pageName);
  if (!isUserPageEntity(page)) return;
  if (!(await pageQualifiesForAutoRepair(pageName))) return;

  repairingPages.add(pageName);
  cooldownUntil.set(pageName, Date.now() + COOLDOWN_MS);
  const result = newResult('lss:auto-repair');
  try {
    await repairNamedPage(result, pageName);
  } catch (error) {
    result.errors.push(formatError(error));
  } finally {
    repairingPages.delete(pageName);
  }

  if (result.errors.length) {
    await logseq.UI.showMsg(`LSS auto-sync ${pageName}: ${result.errors[0]}`, 'warning', { timeout: 5000 });
    return;
  }
  const meaningful = result.actions.filter((action) => !/^SKIP\b/i.test(action));
  if (meaningful.length) {
    await logseq.UI.showMsg(`LSS synced ${pageName}`, 'success', { timeout: 2500 });
  }
}

export function scheduleAutoRepair(pageName: string): void {
  const name = String(pageName ?? '').trim();
  if (!name || shouldSkipPage(name)) return;
  if (Date.now() < (cooldownUntil.get(name) ?? 0)) return;

  const existing = pendingTimers.get(name);
  if (existing) clearTimeout(existing);
  pendingTimers.set(
    name,
    setTimeout(() => {
      pendingTimers.delete(name);
      void runAutoRepair(name);
    }, DEBOUNCE_MS),
  );
}

export async function handleGraphChange(
  blocks: Array<Record<string, unknown>>,
  txData: Array<[number, string, unknown, number, boolean]>,
): Promise<void> {
  if (isRepairSessionActive()) return;
  if (!changeEventRelevant(blocks, txData)) return;
  const pages = await collectPageNames(blocks);
  for (const pageName of pages) scheduleAutoRepair(pageName);
}

export function registerAutoRepairHooks(): void {
  if (!logseq.DB?.onChanged) {
    console.warn('[LSS] logseq.DB.onChanged unavailable; auto-repair hooks not registered.');
    return;
  }

  logseq.DB.onChanged(({ blocks, txData }) => {
    void handleGraphChange((blocks ?? []) as Array<Record<string, unknown>>, txData ?? []);
  });
}