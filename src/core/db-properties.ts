import { PLUGIN_ID } from '../config';
import { getPage, resolvePageFromIdentity } from './editor';
import { entityVisibleLabel, safePageName, visiblePageLabel } from './names';
import { formatError } from './runner';
import { propertySpec } from '../registry';

export function canonicalPropertyKey(key: string): string {
  const raw = String(key ?? '').trim();
  const pluginMatch = raw.match(/:plugin\.property\.[^/]+\/(.+)$/);
  if (pluginMatch) return pluginMatch[1];
  if (raw.includes('plugin.property') && raw.includes('/')) {
    return raw.split('/').pop() ?? raw;
  }
  return raw.replace(/^:/, '');
}

/** Stable plugin ident for LSS registry properties (Logseq simple queries require idents). */
export function pluginPropertyIdent(shortName: string): string {
  return `:plugin.property.${PLUGIN_ID}/${canonicalPropertyKey(shortName)}`;
}

function shouldUsePluginPropertyIdent(shortName: string): boolean {
  const key = canonicalPropertyKey(shortName);
  return key === 'lss-object-type' || propertySpec(key) != null;
}

/** Fallback when getProperty is unavailable (sync helpers only). */
export function propertyQueryName(shortName: string): string {
  const key = canonicalPropertyKey(shortName);
  return shouldUsePluginPropertyIdent(key) ? pluginPropertyIdent(key) : key;
}

const propertyQueryNameCache = new Map<string, string>();

/** Logseq simple queries require the property :db/ident from getProperty (e.g. :plugin.property.<id>/venture). */
export async function resolvePropertyQueryName(shortName: string): Promise<string> {
  const key = canonicalPropertyKey(shortName);
  if (propertyQueryNameCache.has(key)) return propertyQueryNameCache.get(key)!;
  let resolved = shouldUsePluginPropertyIdent(key) ? pluginPropertyIdent(key) : key;
  if (logseq.Editor.getProperty) {
    try {
      const prop = (await logseq.Editor.getProperty(key).catch(() => null)) as Record<string, unknown> | null;
      const ident = String(prop?.ident ?? '').trim();
      if (ident) resolved = ident;
    } catch {
      /* ignore */
    }
  }
  propertyQueryNameCache.set(key, resolved);
  return resolved;
}

export function getCanonicalProp(props: Record<string, unknown>, shortName: string): unknown {
  const target = canonicalPropertyKey(shortName);
  for (const [key, value] of Object.entries(props)) {
    if (canonicalPropertyKey(key) === target) return value;
  }
  return undefined;
}

export function isDateProperty(property: string): boolean {
  const spec = propertySpec(canonicalPropertyKey(property));
  return String(spec?.type ?? '').toLowerCase() === 'date';
}

function parseDateFromRawString(raw: string): number | null {
  const text = visiblePageLabel(String(raw ?? '').trim());
  if (!text || /^\[\[\s*\]\]$/.test(text)) return null;
  if (/^today$/i.test(text)) {
    const d = new Date();
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12, 0, 0, 0);
  }

  const wiki = text.match(/\[\[(\d{4}-\d{2}-\d{2})\]\]/);
  if (wiki?.[1]) {
    const ms = Date.parse(`${wiki[1]}T12:00:00.000Z`);
    return Number.isNaN(ms) ? null : ms;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const ms = Date.parse(`${text}T12:00:00.000Z`);
    return Number.isNaN(ms) ? null : ms;
  }
  const journalTitle = text.match(/^([A-Za-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th),\s*(\d{4})$/);
  if (journalTitle) {
    const monthNames = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    const month = monthNames.indexOf(journalTitle[1].slice(0, 3).toLowerCase());
    const day = Number(journalTitle[2]);
    const year = Number(journalTitle[3]);
    if (month >= 0 && day >= 1 && day <= 31 && year >= 1900 && year <= 2100) {
      const ms = Date.UTC(year, month, day, 12, 0, 0, 0);
      return Number.isNaN(ms) ? null : ms;
    }
  }
  // Recognize Logseq journal-day (YYYYMMDD) as 8-digit int
  if (/^\d{8}$/.test(text)) {
    const jd = Number(text);
    const fromJd = journalDayToMs(jd);
    if (fromJd != null) return fromJd;
  }
  if (/^\d+$/.test(text)) {
    const num = Number(text);
    if (!Number.isNaN(num) && num >= 1e11) return num;
  }
  return null;
}

function journalDayToMs(jd: number): number | null {
  const s = String(jd);
  if (!/^\d{8}$/.test(s)) return null;
  const y = parseInt(s.slice(0, 4), 10);
  const m = parseInt(s.slice(4, 6), 10);
  const d = parseInt(s.slice(6, 8), 10);
  if (y < 1900 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const ms = Date.UTC(y, m - 1, d, 12, 0, 0, 0);
  return Number.isNaN(ms) ? null : ms;
}

export function toJournalDay(value: unknown): number | null {
  const ms = parseDatePropertyValue(value);
  if (ms == null || Number.isNaN(ms)) return null;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return Number(`${y}${m}${day}`);
}

export function parseDatePropertyValue(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === 'number' && !Number.isNaN(value)) {
    if (value >= 1e11) return value; // epoch ms
    const fromJd = journalDayToMs(value);
    if (fromJd != null) return fromJd;
    return null;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const journalDay =
      record.journalDay ??
      record['journal-day'] ??
      record[':block/journal-day'] ??
      record['block/journal-day'];
    if (typeof journalDay === 'number') {
      const fromJd = journalDayToMs(journalDay);
      if (fromJd != null) return fromJd;
    }
    const label = entityVisibleLabel(record);
    if (label) {
      const fromLabel = parseDateFromRawString(label) ?? parseDateFromRawString(`[[${label}]]`);
      if (fromLabel != null) return fromLabel;
    }
  }
  return parseDateFromRawString(String(value));
}

export function isValidDatePropertyValue(value: unknown): boolean {
  return parseDatePropertyValue(value) != null;
}

export function formatDatePropertyValue(value: unknown): string {
  let ms = typeof value === 'number' ? value : parseDatePropertyValue(value);
  if (ms == null || Number.isNaN(ms)) return '';
  // If a small number that looks like journal-day was passed directly, convert it
  if (ms < 1e11) {
    const fromJd = journalDayToMs(ms);
    if (fromJd != null) ms = fromJd;
  }
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `[[${y}-${m}-${day}]]`;
}

/** Plain date string for use in block content (no wiki brackets) so dates render visibly on DB graphs. */
export function formatDatePropertyValueForContent(value: unknown): string {
  let ms = typeof value === 'number' ? value : parseDatePropertyValue(value);
  if (ms == null || Number.isNaN(ms)) return '';
  if (ms < 1e11) {
    const fromJd = journalDayToMs(ms);
    if (fromJd != null) ms = fromJd;
  }
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function journalDayTitle(jd: number): string {
  const s = String(jd);
  const year = Number(s.slice(0, 4));
  const month = Number(s.slice(4, 6));
  const day = Number(s.slice(6, 8));
  const monthName = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][month - 1] ?? 'Jan';
  const suffix = day % 100 >= 11 && day % 100 <= 13 ? 'th' : day % 10 === 1 ? 'st' : day % 10 === 2 ? 'nd' : day % 10 === 3 ? 'rd' : 'th';
  return `${monthName} ${day}${suffix}, ${year}`;
}

function numericEntityId(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 1e9) return value;
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  for (const key of ['id', ':db/id', 'db/id']) {
    const raw = record[key];
    if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0 && raw < 1e9) return raw;
  }
  return null;
}

function recordJournalDay(value: unknown): number | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  for (const key of ['journalDay', 'journal-day', ':block/journal-day', 'block/journal-day']) {
    const raw = record[key];
    if (typeof raw === 'number' && journalDayToMs(raw) != null) return raw;
  }
  return null;
}

async function journalPageIdForDay(jd: number): Promise<number | null> {
  if (!logseq.DB?.datascriptQuery) return null;
  try {
    const rows = await logseq.DB.datascriptQuery(
      `[:find ?p
 :in $ ?day
 :where [?p :block/journal-day ?day]]`,
      jd,
    );
    const raw = Array.isArray(rows) ? rows[0]?.[0] : null;
    return numericEntityId(raw);
  } catch {
    return null;
  }
}

export async function resolveJournalDatePropertyValue(value: unknown): Promise<number | null> {
  const directId = numericEntityId(value);
  if (directId != null && recordJournalDay(value) != null) return directId;
  const jd = toJournalDay(value);
  if (jd == null) return null;
  const existingId = await journalPageIdForDay(jd);
  if (existingId != null) return existingId;

  const title = journalDayTitle(jd);
  const page = (await getPage(title)) || (await getPage(title.toLowerCase()));
  const pageId = numericEntityId(page);
  if (pageId != null && recordJournalDay(page) === jd) return pageId;

  if (logseq.Editor.createPage) {
    try {
      await logseq.Editor.createPage(title, {}, { createFirstBlock: true });
      return await journalPageIdForDay(jd);
    } catch {
      return null;
    }
  }
  return null;
}

export function looksLikePageEntityId(raw: string): boolean {
  return /^\d+$/.test(raw) && Number(raw) < 1e9;
}

export function coerceNodePropertyReadValue(value: unknown): unknown {
  if (value == null) return undefined;
  const toId = (item: unknown): number | null => {
    if (typeof item === 'number' && looksLikePageEntityId(String(item))) return Number(item);
    if (typeof item === 'object' && item != null) {
      const id = (item as Record<string, unknown>).id;
      if (id != null && looksLikePageEntityId(String(id))) return Number(id);
    }
    const raw = String(item ?? '').trim();
    if (looksLikePageEntityId(raw)) return Number(raw);
    return null;
  };
  if (Array.isArray(value)) {
    const ids = value.map(toId).filter((id): id is number => id != null);
    return ids.length ? ids : value;
  }
  const id = toId(value);
  return id != null ? id : value;
}

export function isDbPageRefValue(value: unknown): boolean {
  const isRef = (item: unknown): boolean => {
    if (item == null) return false;
    if (typeof item === 'number') return looksLikePageEntityId(String(item));
    if (typeof item === 'object') {
      const record = item as Record<string, unknown>;
      if (record.id != null) return looksLikePageEntityId(String(record.id));
      return false;
    }
    const raw = String(item).trim();
    if (!raw || raw.startsWith('[[')) return false;
    return looksLikePageEntityId(raw);
  };
  if (Array.isArray(value)) return value.some(isRef);
  return isRef(value);
}

export type NativePropertySpec = {
  name?: string;
  property?: string;
  key?: string;
  type?: string;
  cardinality?: string;
  choices?: string[];
  targets?: string[];
};

export async function isDbGraph(): Promise<boolean> {
  try {
    return Boolean(await logseq.App.checkCurrentIsDbGraph?.());
  } catch {
    // Default to true for DB-focused usage (prevents templates/queries falling back to simple on transient check failures)
    return true;
  }
}

export function entityIdentity(entity: unknown): string | number | null {
  if (entity == null) return null;
  if (typeof entity === 'string' || typeof entity === 'number') return entity;
  const record = entity as Record<string, unknown>;
  return (record.uuid as string) ?? (record.id as string | number) ?? null;
}

export function entityIdentityCandidates(entity: unknown): Array<string | number> {
  const out: Array<string | number> = [];
  const add = (value: unknown) => {
    if (value == null) return;
    if (typeof value !== 'string' && typeof value !== 'number') return;
    const raw = String(value).trim();
    if (!raw) return;
    if (!out.some((item) => String(item) === raw)) out.push(value);
  };
  if (typeof entity === 'string' || typeof entity === 'number') {
    add(entity);
    return out;
  }
  if (entity && typeof entity === 'object') {
    const record = entity as Record<string, unknown>;
    add(record.id);
    add(record[':db/id']);
    add(record['db/id']);
    add(record.uuid);
    add(record[':block/uuid']);
    add(record['block/uuid']);
  }
  return out;
}

async function expandPageIdentityCandidates(identity: string | number): Promise<Set<string>> {
  const targets = new Set(entityIdentityCandidates(identity).map((value) => String(value)));
  const raw = String(identity ?? '').trim();
  if (!raw) return targets;
  const page =
    (await getPage(raw)) ||
    (await getPage(safePageName(raw))) ||
    (await getPage(raw.toLowerCase()));
  for (const candidate of entityIdentityCandidates(page)) targets.add(String(candidate));
  return targets;
}

export async function readRelationshipPropertyValue(
  pageBlockId: string,
  shortKey: string,
): Promise<unknown> {
  if (logseq.Editor.getBlockProperty) {
    const identities = await expandPageIdentityCandidates(pageBlockId);
    for (const identity of identities) {
      try {
        const direct = await logseq.Editor.getBlockProperty(identity, shortKey);
        if (direct != null) return coerceNodePropertyReadValue(direct);
      } catch {
        /* try next identity form */
      }
    }
  }
  return undefined;
}

export function nativePropertySchema(spec: NativePropertySpec): Record<string, unknown> {
  const rawType = String(spec.type ?? 'default').toLowerCase();
  const schema: Record<string, unknown> = {
    cardinality: String(spec.cardinality ?? 'one').toLowerCase() === 'many' ? 'many' : 'one',
    public: true,
    hide: false,
  };
  if (rawType === 'node') schema.type = 'node';
  else if (rawType === 'date') schema.type = 'date';
  else if (rawType === 'url') schema.type = 'url';
  else if (rawType === 'number') schema.type = 'number';
  else if (rawType === 'checkbox') schema.type = 'checkbox';
  else schema.type = 'default';
  return schema;
}

async function ensureChoicePropertyValues(name: string, choices: string[]): Promise<void> {
  if (!choices.length || !logseq.Editor.getProperty || !logseq.Editor.upsertBlockProperty) return;
  const propEntity = await logseq.Editor.getProperty(name).catch(() => null);
  const propId = (propEntity as Record<string, unknown> | null)?.id;
  if (propId == null) return;
  await logseq.Editor.upsertBlockProperty(propId, ':logseq.property/closed-value-mode', true);
  await logseq.Editor.upsertBlockProperty(propId, ':logseq.property/closed-values', choices);
}

async function resolveTagIdsForNodeProperty(targets: string[] = []): Promise<number[]> {
  const ids: number[] = [];
  for (const target of targets) {
    const tagName = String(target ?? '').trim();
    if (!tagName) continue;
    const tag =
      (await logseq.Editor.getTag?.(tagName).catch(() => null)) ||
      (await logseq.Editor.getTagsByName?.(tagName).then((matches) => matches?.[0] ?? null).catch(() => null));
    const id = (tag as Record<string, unknown> | null)?.id;
    if (id != null && !Number.isNaN(Number(id))) ids.push(Number(id));
  }
  return [...new Set(ids)];
}

async function ensureNodePropertyTargetTags(name: string, spec: NativePropertySpec): Promise<string | null> {
  if (String(spec.type ?? '').toLowerCase() !== 'node') return null;
  const targets = (spec.targets ?? []).map(String).filter(Boolean);
  if (!targets.length) return null;
  if (!logseq.Editor.setPropertyNodeTags) {
    return `node target tags not configured; setPropertyNodeTags API unavailable for ${targets.join(', ')}`;
  }
  if (!logseq.Editor.getProperty) return `node target tags not configured; getProperty API unavailable`;
  const property = await logseq.Editor.getProperty(name).catch(() => null);
  const propertyIdentity =
    (property as Record<string, unknown> | null)?.uuid ??
    (property as Record<string, unknown> | null)?.id;
  if (propertyIdentity == null) return `node target tags not configured; property entity not found`;
  const tagIds = await resolveTagIdsForNodeProperty(targets);
  if (!tagIds.length) return `node target tags not configured; target tag(s) missing: ${targets.join(', ')}`;
  await logseq.Editor.setPropertyNodeTags(propertyIdentity as any, tagIds);
  return `node target tags configured: ${targets.map((target) => `#${target}`).join(', ')}`;
}

export type EnsureNativePropertyResult = {
  name: string;
  created: boolean;
  skipped?: boolean;
  note?: string;
};

export type EnsureNativePropertyOptions = {
  refreshExistingSchema?: boolean;
};

function isPropertySchemaConflict(message: string): boolean {
  return /can't be changed|existing data|cannot be changed/i.test(message);
}

function isDeferredTimeout(message: string): boolean {
  return /deferred timeout|async call/i.test(message);
}

export function isPluginPropertyOwnershipError(message: string): boolean {
  return /plugins can only upsert (?:its own|their own|own) properties/i.test(message);
}

function skippedNativeProperty(name: string, note: string): EnsureNativePropertyResult {
  return { name, created: false, skipped: true, note };
}

function shouldRefreshExistingPropertySchema(
  name: string,
  spec: NativePropertySpec,
  options: EnsureNativePropertyOptions = {},
): boolean {
  if (options.refreshExistingSchema === false) return false;
  const key = canonicalPropertyKey(name);
  const type = String(spec.type ?? '').toLowerCase();
  // DB node properties are critical picker fields. Older failed setup runs can
  // leave them as text/default properties, which makes page ids render as raw
  // numbers and removes filtered dropdowns.
  return Boolean(key) && type === 'node';
}

function normalizeSchemaAtom(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return normalizeSchemaAtom(
      record.name ??
        record.title ??
        record.ident ??
        record[':db/ident'] ??
        record['db/ident'] ??
        record.value,
    );
  }
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return '';
  const withoutKeyword = raw.replace(/^:/, '');
  return withoutKeyword.split('/').pop()?.replace(/^:/, '') ?? withoutKeyword;
}

function schemaFieldFromSources(sources: Array<Record<string, unknown> | null | undefined>, keys: string[]): unknown {
  for (const source of sources) {
    if (!source) continue;
    for (const key of keys) {
      const value = source[key];
      if (value != null) return value;
    }
  }
  return undefined;
}

async function nativePropertyRecordSources(name: string): Promise<Array<Record<string, unknown> | null | undefined>> {
  if (!logseq.Editor.getProperty) return [];
  const prop = (await logseq.Editor.getProperty(name).catch(() => null)) as Record<string, unknown> | null;
  if (!prop) return [];
  const props = (prop.properties as Record<string, unknown> | undefined) ?? null;
  const identity = prop.uuid ?? prop.id ?? prop[':block/uuid'] ?? prop['block/uuid'] ?? prop[':db/id'] ?? prop['db/id'];
  const blockProps =
    identity != null && logseq.Editor.getBlockProperties
      ? ((await logseq.Editor.getBlockProperties(identity as any).catch(() => null)) as Record<string, unknown> | null)
      : null;
  return [prop, props, blockProps];
}

export async function nativePropertyResetReasonForSpec(spec: NativePropertySpec): Promise<string | null> {
  const name = spec.name ?? spec.property ?? spec.key;
  if (!name || String(spec.type ?? '').toLowerCase() !== 'node') return null;
  const sources = await nativePropertyRecordSources(name);
  if (!sources.length) return null;
  const actualType = normalizeSchemaAtom(
    schemaFieldFromSources(sources, ['type', ':logseq.property/type', 'logseq.property/type']),
  );
  const expectedType = normalizeSchemaAtom(nativePropertySchema(spec).type);
  if (actualType && actualType !== expectedType) return `expected type ${expectedType}, found ${actualType}`;

  const actualCardinality = normalizeSchemaAtom(
    schemaFieldFromSources(sources, ['cardinality', ':logseq.property/cardinality', 'logseq.property/cardinality']),
  );
  const expectedCardinality = normalizeSchemaAtom(nativePropertySchema(spec).cardinality);
  if (actualCardinality && actualCardinality !== expectedCardinality) {
    return `expected cardinality ${expectedCardinality}, found ${actualCardinality}`;
  }
  return null;
}

export async function ensureNativeProperty(
  spec: NativePropertySpec,
  options: EnsureNativePropertyOptions = {},
): Promise<EnsureNativePropertyResult | null> {
  const name = spec.name ?? spec.property ?? spec.key;
  if (!name || !logseq.Editor.upsertProperty) return null;

  const displayName = name === 'lss-object-type' ? 'LSS Object Type' : name;
  const existing = logseq.Editor.getProperty
    ? await logseq.Editor.getProperty(name).catch(() => null)
    : null;

  if (existing) {
    let schemaNote = 'property already exists in graph; schema refresh skipped for idempotent setup';
    if (shouldRefreshExistingPropertySchema(name, spec, options)) {
      try {
        await logseq.Editor.upsertProperty(name, nativePropertySchema(spec), { name: displayName });
        schemaNote = 'property already exists in graph; schema refreshed for DB picker compatibility';
      } catch (error) {
        const message = formatError(error);
        if (isPropertySchemaConflict(message)) {
          schemaNote = `property already exists in graph; schema left unchanged: ${message}`;
        } else if (isPluginPropertyOwnershipError(message)) {
          schemaNote = 'property is owned by Logseq or another plugin; schema left unchanged';
        } else if (isDeferredTimeout(message)) {
          schemaNote = `Logseq API timed out while refreshing property schema; rerun setup after Logseq settles: ${message}`;
        } else {
          throw error;
        }
      }
    }
    let nodeTargetNote: string | null = null;
    try {
      nodeTargetNote = await ensureNodePropertyTargetTags(name, spec);
    } catch (error) {
      const message = formatError(error);
      if (isPluginPropertyOwnershipError(message)) {
        nodeTargetNote = 'property is owned by Logseq or another plugin; node target tags left unchanged';
      } else {
        nodeTargetNote = `node target tags not updated: ${message}`;
      }
    }
    return skippedNativeProperty(
      name,
      [schemaNote, nodeTargetNote].filter(Boolean).join('; '),
    );
  }

  try {
    await logseq.Editor.upsertProperty(name, nativePropertySchema(spec), { name: displayName });
    const nodeTargetNote = await ensureNodePropertyTargetTags(name, spec);
    if (String(spec.type ?? '').toLowerCase() === 'choice' && Array.isArray(spec.choices)) {
      await ensureChoicePropertyValues(name, spec.choices);
    }
    return { name, created: true, note: nodeTargetNote ?? undefined };
  } catch (error) {
    const message = formatError(error);
    if (isPropertySchemaConflict(message)) {
      return skippedNativeProperty(name, message);
    }
    if (isPluginPropertyOwnershipError(message)) {
      return skippedNativeProperty(
        name,
        'property is owned by Logseq or another plugin; schema left unchanged',
      );
    }
    if (isDeferredTimeout(message)) {
      return skippedNativeProperty(name, `Logseq API timed out while creating property; rerun setup after Logseq settles: ${message}`);
    }
    throw error;
  }
}

export async function ensureLssObjectTypeProperty(): Promise<void> {
  try {
    await ensureNativeProperty({ name: 'lss-object-type', type: 'default', cardinality: 'one' });
  } catch {
    /* best-effort */
  }
}

function pageNamesFromValue(value: string): string[] {
  const refs: string[] = [];
  const raw = String(value ?? '').trim();
  const whole = visiblePageLabel(raw);
  if (whole && whole !== raw && !whole.includes('[[') && !whole.includes(']]')) return [whole];
  const re = /\[\[([^\]]+)\]\]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw))) {
    if (match[1]) refs.push(visiblePageLabel(match[1]).trim());
  }
  if (!refs.length) {
    if (raw) refs.push(...raw.split(',').map((x) => visiblePageLabel(x.trim())).filter(Boolean));
  }
  return refs;
}

async function getPageByExactTitle(name: string): Promise<Record<string, unknown> | null> {
  if (!logseq.DB?.datascriptQuery) return null;
  const title = String(name ?? '').trim();
  if (!title) return null;
  try {
    const rows = await logseq.DB.datascriptQuery(
      `[:find (pull ?p [*])
 :in $ ?title ?name
 :where
 (or [?p :block/title ?title]
     [?p :block/original-name ?title]
     [?p :block/name ?name])]`,
      title,
      title.toLowerCase(),
    );
    const record = Array.isArray(rows) ? (rows[0]?.[0] as Record<string, unknown> | undefined) : undefined;
    if (!record) return null;
    return {
      ...record,
      id: record.id ?? record[':db/id'] ?? record['db/id'],
      title: record.title ?? record[':block/title'] ?? record['block/title'],
      name: record.name ?? record[':block/name'] ?? record['block/name'],
      originalName:
        record.originalName ??
        record[':block/original-name'] ??
        record['block/original-name'] ??
        record.title ??
        record[':block/title'] ??
        record['block/title'],
    };
  } catch {
    return null;
  }
}

function pageLabelMatchesNodeRef(label: string, requestedName: string): boolean {
  const actual = visiblePageLabel(label).trim().toLowerCase();
  const requested = visiblePageLabel(requestedName).trim().toLowerCase();
  if (!actual || !requested) return false;
  if (actual === requested) return true;
  // Slash titles are semantically meaningful in DB graphs. Do not silently map
  // [[LSS Placeholder/Person]] to [[LSS Placeholder - Person]].
  if (requested.includes('/')) return false;
  return safePageName(actual).toLowerCase() === safePageName(requested).toLowerCase();
}

function pageEntityIdFromRecord(
  page: Record<string, unknown> | null | undefined,
  requestedName: string,
): string | number | null {
  if (!page) return null;
  const id =
    page.id ??
    page[':db/id'] ??
    page['db/id'];
  if (id == null) return null;
  // Node properties must point to a page entity. Some Logseq APIs can return
  // property value/block entities for ambiguous names; those have ids but no
  // visible page title and must not be used as node property targets.
  const label = entityVisibleLabel(page);
  return label && pageLabelMatchesNodeRef(label, requestedName) ? (id as string | number) : null;
}

export async function resolveNodePropertyIds(value: string): Promise<Array<string | number>> {
  const ids: Array<string | number> = [];
  for (const name of pageNamesFromValue(value)) {
    const candidates = [
      await getPageByExactTitle(name),
      await getPage(name),
      await getPage(safePageName(name)),
      await getPage(name.toLowerCase()),
      await resolvePageFromIdentity(name).catch(() => null),
    ];
    for (const page of candidates) {
      const id = pageEntityIdFromRecord(page as Record<string, unknown> | null, name);
      if (id == null) continue;
      ids.push(id as string | number);
      break;
    }
  }
  return ids;
}

export async function resolveUpsertPropertyValue(property: string, value: string): Promise<unknown> {
  if (property === 'lss-object-type') {
    return value;
  }

  const spec = propertySpec(property);
  const type = String(spec?.type ?? '').toLowerCase();
  if (!(await isDbGraph())) return value;

  if (type === 'date') {
    // Logseq DB date properties are ref-valued. The value must be the journal page entity id,
    // not a raw compact journal-day number.
    return resolveJournalDatePropertyValue(value);
  }

  if (type !== 'node') return value;

  const ids = await resolveNodePropertyIds(value);
  if (!ids.length) return value;
  const cardinality = String((spec as { cardinality?: string } | undefined)?.cardinality ?? '').toLowerCase();
  return cardinality === 'many' ? ids : ids[0];
}

export async function pageHasClassTag(pageIdentity: string | number, tagName: string): Promise<boolean> {
  if (!logseq.Editor.getTagObjects) return false;
  try {
    const objects = await logseq.Editor.getTagObjects(tagName);
    if (!objects?.length) return false;
    const targets = await expandPageIdentityCandidates(pageIdentity);
    return objects.some((obj) => {
      for (const candidate of entityIdentityCandidates(obj)) {
        if (targets.has(String(candidate))) return true;
      }
      return false;
    });
  } catch {
    return false;
  }
}
