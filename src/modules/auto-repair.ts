import { canonicalPropertyKey, entityIdentity, pageHasClassTag } from '../core/db-properties';
import { blockId, currentPageName, getBlocks, getPage, walkBlocks } from '../core/editor';
import { formatError, newResult, writeReport } from '../core/runner';
import { safePageName, safeTag } from '../core/names';
import { allObjects, layerPages, rootPages } from '../registry';
import { isQueryLikeContent, relationshipPropertyNames } from './queries';
import { repairNamedPage } from './repair';
import { primaryObjectTypesFromTags, readIncomingSourceTagsForPage } from './repair-source-tags';

const DEBOUNCE_MS = 1800;
const COOLDOWN_MS = 5000;
const AUTO_REPAIR_SETTING_KEY = 'autoRepairEnabled';
const SKIP_PAGE_RE =
  /^(LSS |LSS$|Template(?:\/| - )|Dashboard(?:\/| - )|Entity-Page(?:\/| - )|Tag Properties(?:\/| - )|Property Reference(?:\/| - )|DB Tag(?:\/| - )|Tag Reference(?:\/| - )|Relationship(?:\/| - )|Area(?:\/| - ))/i;
const SKIP_PAGE_NAMES = new Set([...rootPages(), ...layerPages()].map((name) => safePageName(name).toLowerCase()));

const RELATIONSHIP_PROPERTIES = new Set(relationshipPropertyNames());
const LSS_OBJECT_TAGS = new Set(allObjects().map((o) => safeTag(o.tag)).filter(Boolean));

const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();
const cooldownUntil = new Map<string, number>();
const repairingPages = new Set<string>();
let repairSessionDepth = 0;

export function registerAutoRepairSettings(): void {
  if (!logseq.useSettingsSchema) return;
  logseq.useSettingsSchema([
    {
      key: AUTO_REPAIR_SETTING_KEY,
      type: 'boolean',
      default: true,
      title: 'Enable LSS auto-repair',
      description: 'Automatically materialize properties on tagged LSS pages after relevant graph changes.',
    },
  ]);
}

export function isAutoRepairEnabled(): boolean {
  return logseq.settings?.[AUTO_REPAIR_SETTING_KEY] !== false;
}

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
  return SKIP_PAGE_RE.test(name) || SKIP_PAGE_NAMES.has(safePageName(name).toLowerCase());
}

function isUserPageEntity(page: Record<string, unknown> | null): boolean {
  if (!page) return false;
  const type = String(page.type ?? 'page').toLowerCase();
  return type === 'page' || type === 'journal' || type === 'whiteboard';
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

function referencedPageName(ref: unknown): string {
  if (ref == null) return '';
  if (typeof ref === 'string') return ref.trim();
  if (typeof ref === 'number') return '';
  if (typeof ref !== 'object') return '';
  const record = ref as Record<string, unknown>;
  const name = record.originalName ?? record.name ?? record.title ?? record.fullTitle;
  return typeof name === 'string' ? name.trim() : '';
}

function collectReferencedPageNames(block: Record<string, unknown>): Set<string> {
  const names = new Set<string>();
  const add = (name: string) => {
    const clean = safePageName(name);
    if (!clean || shouldSkipPage(clean) || LSS_OBJECT_TAGS.has(safeTag(clean))) return;
    names.add(clean);
  };

  const refs = [
    block.refs,
    block['block/refs'],
    block.references,
    block['block/references'],
  ];
  for (const value of refs) {
    if (Array.isArray(value)) {
      for (const ref of value) add(referencedPageName(ref));
    } else {
      add(referencedPageName(value));
    }
  }

  const text = blockText(block);
  for (const match of text.matchAll(/\[\[([^\]]+?)\]\]/g)) add(match[1] ?? '');
  return names;
}

function changeEventRelevant(
  blocks: Array<Record<string, unknown>>,
  txData: Array<[number, string, unknown, number, boolean]>,
): boolean {
  if (txDataRelevant(txData)) return true;
  return (blocks ?? []).some((block) => blockContentRelevant(blockText(block)));
}

async function collectPageNames(blocks: Array<Record<string, unknown>>, includeReferences = false): Promise<Set<string>> {
  const pages = new Set<string>();
  for (const block of blocks ?? []) {
    const pageName = await pageNameFromChangedBlock(block);
    if (pageName && !shouldSkipPage(pageName)) pages.add(pageName);
    if (includeReferences || blockContentRelevant(blockText(block))) {
      for (const linkedPageName of collectReferencedPageNames(block)) pages.add(linkedPageName);
    }
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
  if (shouldSkipPage(pageName)) return false;
  const page = await readPageRecord(pageName);
  if (!isUserPageEntity(page)) return false;

  const pageBlockId = blockId(page);
  if (!pageBlockId) return false;

  try {
    const props = logseq.Editor.getPageProperties
      ? await logseq.Editor.getPageProperties(pageName).catch(() => null)
      : null;
    for (const [rawKey, value] of Object.entries(props ?? {})) {
      const key = canonicalPropertyKey(rawKey);
      if (key === 'lss-object-type' && value != null && value !== '') return true;
      if (RELATIONSHIP_PROPERTIES.has(key) && value != null && value !== '') return true;
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

  const incoming = await readIncomingSourceTagsForPage(newResult('lss:auto-repair-probe'), pageName, pageBlockId, page);
  if (primaryObjectTypesFromTags(incoming.classTags).size === 1) return true;

  const blocks = await getBlocks(pageName);
  for (const block of walkBlocks(blocks)) {
    if (blockContentRelevant(String(block?.content ?? block?.title ?? ''))) return true;
  }

  return false;
}

async function runAutoRepair(pageName: string): Promise<void> {
  if (isRepairSessionActive()) {
    scheduleAutoRepair(pageName);
    return;
  }
  if (shouldSkipPage(pageName) || repairingPages.has(pageName)) return;

  const page = await readPageRecord(pageName);
  if (!isUserPageEntity(page)) return;
  if (!(await pageQualifiesForAutoRepair(pageName))) return;

  repairingPages.add(pageName);
  cooldownUntil.set(pageName, Date.now() + COOLDOWN_MS);
  const result = newResult('lss:auto-repair');
  try {
    await repairNamedPage(result, pageName, null, { allowUntypedBootstrap: false, repairLinkedParents: false, maxDashboardQueryViews: 0 });
  } catch (error) {
    result.errors.push(formatError(error));
  } finally {
    repairingPages.delete(pageName);
  }

  if (result.errors.length) {
    await writeReport(result);
    await logseq.UI.showMsg(`LSS auto-sync ${pageName}: ${result.errors[0]}`, 'warning', { timeout: 5000 });
    return;
  }
  const meaningful = result.actions.filter((action) => !/^SKIP\b/i.test(action));
  if (meaningful.length) {
    await logseq.UI.showMsg(`LSS synced ${pageName}`, 'success', { timeout: 2500 });
  }
}

export function scheduleAutoRepair(pageName: string): void {
  if (!isAutoRepairEnabled()) return;
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

export async function scheduleCurrentPageAutoRepair(): Promise<void> {
  if (!isAutoRepairEnabled()) return;
  const pageName = await currentPageName();
  if (pageName) scheduleAutoRepair(pageName);
}

export async function handleGraphChange(
  blocks: Array<Record<string, unknown>>,
  txData: Array<[number, string, unknown, number, boolean]>,
): Promise<void> {
  if (!isAutoRepairEnabled()) return;
  if (isRepairSessionActive()) return;
  const hasRelevantTx = txDataRelevant(txData);
  if (!hasRelevantTx && !changeEventRelevant(blocks, txData)) return;
  const pages = await collectPageNames(blocks, hasRelevantTx);
  for (const pageName of pages) scheduleAutoRepair(pageName);
}

export function registerAutoRepairHooks(): void {
  if (!logseq.DB?.onChanged) {
    console.warn('[LSS] logseq.DB.onChanged unavailable; auto-repair hooks not registered.');
    return;
  }
  if (!isAutoRepairEnabled()) {
    console.info('[LSS] auto-repair disabled by plugin setting; hooks registered but idle until enabled.');
  }

  logseq.DB.onChanged(({ blocks, txData }) => {
    void handleGraphChange((blocks ?? []) as Array<Record<string, unknown>>, txData ?? []);
  });
}
