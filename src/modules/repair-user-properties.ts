import {
  canonicalPropertyKey,
  entityIdentity,
  isDateProperty,
  pageHasClassTag,
} from '../core/db-properties';
import { PLUGIN_ID } from '../config';
import { looksLikeUuid, safeTag } from '../core/names';
import { blockId, ensurePage, ensureTagByName, getPage } from '../core/editor';
import { formatError } from '../core/runner';
import { propertySpec } from '../registry';
import type { Result } from '../core/types';

const REPORT_PLUGIN_PROPERTY_KEYS = new Set([
  'lss-canonical-page',
  'lss-current-page',
  'lss-plugin-mode',
  'lss-plugin-version',
]);

export function isPluginOwnedRegistryPropertyKey(key: string): boolean {
  const raw = String(key ?? '');
  if (!raw.includes(`plugin.property.${PLUGIN_ID}/`)) return false;
  return !REPORT_PLUGIN_PROPERTY_KEYS.has(canonicalPropertyKey(raw));
}

export function isForeignPluginRegistryPropertyKey(key: string): boolean {
  const raw = String(key ?? '');
  if (!raw.includes('plugin.property.')) return false;
  return !raw.includes(`plugin.property.${PLUGIN_ID}/`);
}

export async function cleanForeignPluginPropertyCopies(
  result: Result,
  pageName: string,
  pageBlockId: string,
  managedProps: Set<string>,
): Promise<number> {
  if (!managedProps.size || !logseq.Editor.removeBlockProperty) return 0;
  const sources: Array<Record<string, unknown> | null> = [];
  try {
    if (logseq.Editor.getBlockProperties) {
      sources.push(await logseq.Editor.getBlockProperties(pageBlockId).catch(() => null));
    }
  } catch {
    /* ignore */
  }
  try {
    if (logseq.Editor.getBlock) {
      const block = await logseq.Editor.getBlock(pageBlockId).catch(() => null);
      sources.push(((block as Record<string, unknown> | null)?.properties as Record<string, unknown> | undefined) ?? null);
    }
  } catch {
    /* ignore */
  }

  const keys = new Set<string>();
  for (const src of sources) {
    if (!src) continue;
    for (const key of Object.keys(src)) {
      if (!isForeignPluginRegistryPropertyKey(key)) continue;
      if (!managedProps.has(canonicalPropertyKey(key))) continue;
      keys.add(key);
    }
  }
  for (const key of await readDatascriptForeignPluginPropertyKeys(pageBlockId, managedProps)) {
    keys.add(key);
  }

  for (const key of keys) {
    const withoutColon = key.replace(/^:/, '');
    await logseq.Editor.removeBlockProperty(pageBlockId, key).catch(() => null);
    if (withoutColon !== key) await logseq.Editor.removeBlockProperty(pageBlockId, withoutColon).catch(() => null);
  }
  if (keys.size) {
    result.actions.push(`REMOVED ${keys.size} stale foreign plugin page propert${keys.size === 1 ? 'y' : 'ies'} on ${pageName}`);
  }
  return keys.size;
}

function normalizeIdent(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return String(record.ident ?? record[':db/ident'] ?? record['db/ident'] ?? record.name ?? record.value ?? '').trim();
  }
  return String(value).trim();
}

async function readDatascriptForeignPluginPropertyKeys(
  pageBlockId: string,
  managedProps: Set<string>,
): Promise<Set<string>> {
  const keys = new Set<string>();
  if (!logseq.DB?.datascriptQuery) return keys;
  const pageId = await dbEntityIdForBlockIdentity(entityIdentity(pageBlockId) ?? pageBlockId);
  if (!pageId) return keys;
  try {
    const rows = await logseq.DB.datascriptQuery(
      `[:find ?attr
 :in $ ?p
 :where [?p ?attr ?v]]`,
      pageId,
    );
    for (const row of (rows ?? []) as Array<[unknown]>) {
      const ident = normalizeIdent(row?.[0]);
      if (!ident || !isForeignPluginRegistryPropertyKey(ident)) continue;
      if (!managedProps.has(canonicalPropertyKey(ident))) continue;
      keys.add(ident);
    }
  } catch {
    /* The visible API cleanup above is still useful if Datascript attr introspection is unavailable. */
  }
  return keys;
}

export function isPlaceholderNodeLabel(value: string): boolean {
  const raw = String(value ?? '')
    .replace(/^\[\[/, '')
    .replace(/\]\]$/, '')
    .trim();
  return /^LSS Placeholder(?:\/|\s+-\s+)/i.test(raw);
}

export function isPlaceholderNodeDefault(value: string): boolean {
  return isPlaceholderNodeLabel(value);
}

function placeholderPageNames(value: string): string[] {
  const names = new Set<string>();
  const re = /\[\[(LSS Placeholder(?:\/| - )[^\]]+)\]\]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(String(value ?? '')))) if (match[1]) names.add(match[1]);
  return [...names];
}

function nodePropertyTargetTags(property: string): string[] {
  const spec = propertySpec(canonicalPropertyKey(property));
  return [...new Set(((spec as { targets?: unknown[] } | undefined)?.targets ?? [])
    .map(String)
    .map((target) => safeTag(target))
    .filter((target) => target && !target.includes('/')))];
}

async function ensurePlaceholderTargetTag(result: Result, pageName: string, target: string): Promise<void> {
  if (!logseq.Editor.addBlockTag) return;
  const page = await getPage(pageName);
  const pageBlockId = blockId(page);
  const pageIdentity = entityIdentity(page as Record<string, unknown> | null) ?? pageBlockId;
  if (!pageBlockId || !pageIdentity || await pageHasClassTag(pageIdentity, target)) return;
  const tagObj = await ensureTagByName(result, target);
  const tagId = entityIdentity(tagObj);
  if (!tagId) return;
  try {
    await logseq.Editor.addBlockTag(pageBlockId, tagId);
    result.actions.push(`ADD placeholder target tag: [[${pageName}]] #${target}`);
  } catch (error) {
    result.errors.push(`placeholder target tag ${pageName} #${target}: ${formatError(error)}`);
  }
}

export async function ensurePlaceholderPagesForNodeValue(result: Result, property: string, value: string): Promise<void> {
  const targets = nodePropertyTargetTags(property);
  for (const pageName of placeholderPageNames(value)) {
    await ensurePage(result, pageName, {
      'lss-kind': 'Template Placeholder',
      'lss-status': 'placeholder',
    });
    for (const target of targets) await ensurePlaceholderTargetTag(result, pageName, target);
  }
}

export function discardPlaceholderNodeDefaults(props: Map<string, string>): string[] {
  const dropped: string[] = [];
  for (const [key, value] of props.entries()) {
    const spec = propertySpec(key);
    if (String(spec?.type ?? '').toLowerCase() !== 'node') continue;
    if (!isPlaceholderNodeDefault(String(value ?? ''))) continue;
    props.set(key, '');
    dropped.push(key);
  }
  return dropped;
}

function safeUserPropertyAttr(shortKey: string): string {
  const key = canonicalPropertyKey(shortKey);
  return /^[A-Za-z0-9_.-]+$/.test(key) ? `:user.property/${key}` : '';
}

function safePluginPropertyAttr(shortKey: string): string {
  const key = canonicalPropertyKey(shortKey);
  return /^[A-Za-z0-9_.-]+$/.test(key) ? `:plugin.property.${PLUGIN_ID}/${key}` : '';
}

async function dbEntityIdForBlockIdentity(identity: string | number): Promise<number | null> {
  if (typeof identity === 'number' && Number.isFinite(identity) && identity > 0) return identity;
  const raw = String(identity ?? '').trim();
  if (!raw || !logseq.DB?.datascriptQuery) return null;
  if (/^\d+$/.test(raw)) return Number(raw);
  try {
    const block = await logseq.Editor.getBlock?.(raw).catch(() => null);
    const blockId = (block as Record<string, unknown> | null)?.id;
    if (typeof blockId === 'number' && Number.isFinite(blockId) && blockId > 0) return blockId;
  } catch {
    /* try page and DB lookup */
  }
  try {
    const page = await logseq.Editor.getPage?.(raw).catch(() => null);
    const pageId = (page as Record<string, unknown> | null)?.id;
    if (typeof pageId === 'number' && Number.isFinite(pageId) && pageId > 0) return pageId;
  } catch {
    /* try DB lookup */
  }
  if (!looksLikeUuid(raw)) return null;
  try {
    const rows = await logseq.DB.datascriptQuery(
      '[:find ?e :in $ ?uuid :where [?e :block/uuid ?uuid]]',
      `#uuid "${raw}"`,
    );
    const found = Array.isArray(rows) ? rows[0]?.[0] : null;
    return typeof found === 'number' ? found : null;
  } catch {
    return null;
  }
}

async function readEntityScalar(entityId: number, attr: string): Promise<unknown> {
  if (!logseq.DB?.datascriptQuery) return undefined;
  try {
    const rows = await logseq.DB.datascriptQuery(
      `[:find ?v
 :in $ ?e
 :where [?e ${attr} ?v]]`,
      entityId,
    );
    return Array.isArray(rows) ? rows[0]?.[0] : undefined;
  } catch {
    return undefined;
  }
}

async function readEntityTitle(entityId: number): Promise<string> {
  for (const attr of [':block/title', ':block/original-name', ':block/name']) {
    const value = await readEntityScalar(entityId, attr);
    const title = String(value ?? '').trim();
    if (title) return title;
  }
  return '';
}

async function normalizeDatascriptUserPropertyValue(shortKey: string, value: unknown): Promise<unknown> {
  const specType = String(propertySpec(shortKey)?.type ?? '').toLowerCase();
  if (typeof value !== 'number') {
    if (specType === 'node' && value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      return record[':logseq.property/value'] ?? record['logseq.property/value'] ?? record.value ?? value;
    }
    return value;
  }
  if (specType === 'node') {
    return (await readEntityScalar(value, ':logseq.property/value')) ?? value;
  }
  if (isDateProperty(shortKey)) {
    const journalDay = await readEntityScalar(value, ':block/journal-day');
    return journalDay ?? (await readEntityScalar(value, ':logseq.property/value')) ?? value;
  }
  return (await readEntityScalar(value, ':logseq.property/value')) ?? (await readEntityTitle(value)) ?? value;
}

export async function readDatascriptUserPropertyValue(pageBlockId: string, shortKey: string): Promise<unknown> {
  if (!logseq.DB?.datascriptQuery) return undefined;
  const attrs = [safeUserPropertyAttr(shortKey), safePluginPropertyAttr(shortKey)].filter(Boolean);
  if (!attrs.length) return undefined;
  const identity = entityIdentity(pageBlockId);
  if (identity == null) return undefined;
  const pageId = await dbEntityIdForBlockIdentity(identity);
  if (!pageId) return undefined;
  for (const attr of attrs) {
    try {
      const rows = await logseq.DB.datascriptQuery(
        `[:find ?v
 :in $ ?p
 :where [?p ${attr} ?v]]`,
        pageId,
      );
      const values = Array.isArray(rows) ? rows.map((row) => row?.[0]).filter((value) => value != null) : [];
      if (!values.length) continue;
      const normalized: unknown[] = [];
      for (const value of values) normalized.push(await normalizeDatascriptUserPropertyValue(shortKey, value));
      return normalized.length === 1 ? normalized[0] : normalized;
    } catch {
      /* try next property namespace */
    }
  }
  return undefined;
}

export async function datascriptNodePropertyHasValueWrapper(pageBlockId: string, shortKey: string): Promise<boolean> {
  if (!logseq.DB?.datascriptQuery) return false;
  if (String(propertySpec(shortKey)?.type ?? '').toLowerCase() !== 'node') return false;
  const attrs = [safeUserPropertyAttr(shortKey), safePluginPropertyAttr(shortKey)].filter(Boolean);
  if (!attrs.length) return false;
  const identity = entityIdentity(pageBlockId);
  if (identity == null) return false;
  const pageId = await dbEntityIdForBlockIdentity(identity);
  if (!pageId) return false;
  for (const attr of attrs) {
    try {
      const rows = await logseq.DB.datascriptQuery(
        `[:find ?v
 :in $ ?p
 :where [?p ${attr} ?v]]`,
        pageId,
      );
      const values = Array.isArray(rows) ? rows.map((row) => row?.[0]).filter((value) => value != null) : [];
      for (const value of values) {
        if (value && typeof value === 'object') {
          const record = value as Record<string, unknown>;
          if (
            record[':logseq.property/value'] != null ||
            record['logseq.property/value'] != null ||
            record.value != null
          ) {
            return true;
          }
        }
        if (typeof value === 'number' && (await readEntityScalar(value, ':logseq.property/value')) != null) {
          return true;
        }
      }
    } catch {
      /* try next property namespace */
    }
  }
  return false;
}
