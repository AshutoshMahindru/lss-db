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
  const text = String(raw ?? '').trim();
  if (!text || /^\[\[\s*\]\]$/.test(text)) return null;

  const wiki = text.match(/\[\[(\d{4}-\d{2}-\d{2})\]\]/);
  if (wiki?.[1]) {
    const ms = Date.parse(`${wiki[1]}T12:00:00.000Z`);
    return Number.isNaN(ms) ? null : ms;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const ms = Date.parse(`${text}T12:00:00.000Z`);
    return Number.isNaN(ms) ? null : ms;
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

function isPropertySchemaConflict(message: string): boolean {
  return /can't be changed|existing data|cannot be changed/i.test(message);
}

export function isPluginPropertyOwnershipError(message: string): boolean {
  return /plugins can only upsert (?:its own|their own|own) properties/i.test(message);
}

function skippedNativeProperty(name: string, note: string): EnsureNativePropertyResult {
  return { name, created: false, skipped: true, note };
}

export async function ensureNativeProperty(spec: NativePropertySpec): Promise<EnsureNativePropertyResult | null> {
  const name = spec.name ?? spec.property ?? spec.key;
  if (!name || !logseq.Editor.upsertProperty) return null;

  const displayName = name === 'lss-object-type' ? 'LSS Object Type' : name;
  const existing = logseq.Editor.getProperty
    ? await logseq.Editor.getProperty(name).catch(() => null)
    : null;

  if (existing) {
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
    if (String(spec.type ?? '').toLowerCase() === 'choice' && Array.isArray(spec.choices)) {
      try {
        await ensureChoicePropertyValues(name, spec.choices);
      } catch (error) {
        const message = formatError(error);
        if (isPluginPropertyOwnershipError(message)) {
          return skippedNativeProperty(
            name,
            'property is owned by Logseq or another plugin; choice values left unchanged',
          );
        }
        return skippedNativeProperty(name, `choice values not updated: ${message}`);
      }
    }
    return skippedNativeProperty(
      name,
      ['property already exists in graph; schema left unchanged', nodeTargetNote].filter(Boolean).join('; '),
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

export async function resolveNodePropertyIds(value: string): Promise<Array<string | number>> {
  const ids: Array<string | number> = [];
  for (const name of pageNamesFromValue(value)) {
    const page =
      (await getPage(name)) ||
      (await getPage(safePageName(name))) ||
      (await getPage(name.toLowerCase())) ||
      (await resolvePageFromIdentity(name).catch(() => null));
    const id = (page as Record<string, unknown> | null)?.id;
    if (id != null) ids.push(id as string | number);
  }
  return ids;
}

export async function resolveUpsertPropertyValue(property: string, value: string): Promise<unknown> {
  if (property === 'lss-object-type') {
    await ensureLssObjectTypeProperty();
    return value;
  }

  const spec = propertySpec(property);
  const type = String(spec?.type ?? '').toLowerCase();
  if (!(await isDbGraph())) return value;

  if (type === 'date') {
    // Logseq DB date properties (type 'date') expect a "journal date" (YYYYMMDD integer)
    // rather than epoch milliseconds. Return the compact journal day number.
    const jd = toJournalDay(value);
    if (jd != null) return jd;
    // Fallback: if we couldn't parse, return null so caller can decide to clear/skip.
    return null;
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
