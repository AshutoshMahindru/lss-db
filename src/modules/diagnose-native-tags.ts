import { canonicalPropertyKey, entityIdentity } from '../core/db-properties';
import { safeTag } from '../core/names';
import { allObjects } from '../registry';
import { uniqueObjectProps } from './templates';

export type NativeTagSchemaFinding = {
  tag: string;
  objectType: string;
  properties: string[];
};

const PROPERTY_NAME_FIELDS = [
  'name',
  'property',
  'key',
  'ident',
  ':db/ident',
  'db/ident',
  'title',
  'originalName',
  'original-name',
] as const;

function normalizePropertyToken(raw: unknown): string {
  let text = String(raw ?? '').trim();
  if (!text) return '';
  text = text.replace(/^:+/, ':');
  text = canonicalPropertyKey(text);
  const propertyTail = text.match(/(?:plugin|user|logseq)\.property(?:\.[^/]+)?\/(.+)$/i);
  if (propertyTail?.[1]) text = propertyTail[1];
  if (text.includes('/')) text = text.split('/').pop() ?? text;
  return text.replace(/^:/, '').trim().toLowerCase();
}

function expectedSchemaPropertyMap(objectType: string, tag: string): Map<string, string> {
  const object = allObjects().find((item) => safeTag(item.tag) === safeTag(tag) || item.name === objectType);
  const map = new Map<string, string>();
  if (!object) return map;
  for (const prop of [...uniqueObjectProps(object), 'lss-object-type', 'lss-object-tag']) {
    const key = normalizePropertyToken(prop);
    if (key && !map.has(key)) map.set(key, prop);
  }
  return map;
}

function collectExpectedPropertyToken(
  value: unknown,
  expected: Map<string, string>,
  found: Set<string>,
): void {
  const key = normalizePropertyToken(value);
  const display = expected.get(key);
  if (display) found.add(display);
}

function collectDirectPropertyKeys(
  source: Record<string, unknown> | null | undefined,
  expected: Map<string, string>,
  found: Set<string>,
): void {
  if (!source) return;
  for (const key of Object.keys(source)) collectExpectedPropertyToken(key, expected, found);
}

function isLikelySchemaContainerKey(key: string): boolean {
  return /tag.*propert|schema.*propert|propert.*schema|properties|property-list/i.test(key);
}

function collectPropertyNamesFromSchemaValue(
  value: unknown,
  expected: Map<string, string>,
  found: Set<string>,
  depth = 0,
): void {
  if (value == null || depth > 5) return;
  if (typeof value === 'string' || typeof value === 'number') {
    collectExpectedPropertyToken(value, expected, found);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectPropertyNamesFromSchemaValue(item, expected, found, depth + 1);
    return;
  }
  if (typeof value !== 'object') return;

  const record = value as Record<string, unknown>;
  for (const field of PROPERTY_NAME_FIELDS) {
    if (record[field] != null) collectExpectedPropertyToken(record[field], expected, found);
  }
  for (const [key, nested] of Object.entries(record)) {
    if (isLikelySchemaContainerKey(key)) {
      collectDirectPropertyKeys(nested as Record<string, unknown>, expected, found);
      collectPropertyNamesFromSchemaValue(nested, expected, found, depth + 1);
    }
  }
}

function collectSchemaContainersFromRecord(
  source: Record<string, unknown> | null | undefined,
  expected: Map<string, string>,
  found: Set<string>,
): void {
  if (!source) return;
  for (const [key, nested] of Object.entries(source)) {
    if (!isLikelySchemaContainerKey(key)) continue;
    collectDirectPropertyKeys(nested as Record<string, unknown>, expected, found);
    collectPropertyNamesFromSchemaValue(nested, expected, found);
  }
}

async function readNativeTagObjects(tag: string): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  const add = (tagObject: unknown) => {
    if (!tagObject || typeof tagObject !== 'object') return;
    const record = tagObject as Record<string, unknown>;
    const id = String(record.uuid ?? record.id ?? record.name ?? JSON.stringify(record));
    if (seen.has(id)) return;
    seen.add(id);
    out.push(record);
  };

  if (logseq.Editor.getTag) add(await logseq.Editor.getTag(tag).catch(() => null));
  if (logseq.Editor.getTagsByName) {
    const matches = await logseq.Editor.getTagsByName(tag).catch(() => null);
    for (const match of matches ?? []) add(match);
  }
  return out;
}

async function collectNativeTagSchemaProperties(
  tagObject: Record<string, unknown>,
  expected: Map<string, string>,
): Promise<string[]> {
  const found = new Set<string>();
  collectSchemaContainersFromRecord(tagObject, expected, found);
  collectDirectPropertyKeys(tagObject.properties as Record<string, unknown> | undefined, expected, found);

  const identity = entityIdentity(tagObject);
  if (identity != null && logseq.Editor.getBlockProperties) {
    const blockProps = (await logseq.Editor.getBlockProperties(identity).catch(() => null)) as
      | Record<string, unknown>
      | null;
    collectDirectPropertyKeys(blockProps, expected, found);
    collectSchemaContainersFromRecord(blockProps, expected, found);
  }
  if (identity != null && logseq.Editor.getBlock) {
    const block = (await logseq.Editor.getBlock(identity).catch(() => null)) as Record<string, unknown> | null;
    collectSchemaContainersFromRecord(block, expected, found);
    collectDirectPropertyKeys(block?.properties as Record<string, unknown> | undefined, expected, found);
  }

  return [...found].sort((a, b) => a.localeCompare(b));
}

export async function readNativeTagSchemaFindings(): Promise<{
  available: boolean;
  findings: NativeTagSchemaFinding[];
}> {
  if (!logseq.Editor.getTag && !logseq.Editor.getTagsByName) return { available: false, findings: [] };
  const findings: NativeTagSchemaFinding[] = [];
  const objectsByTag = new Map<string, string>();
  for (const object of allObjects()) {
    const tag = safeTag(object.tag);
    if (tag && !objectsByTag.has(tag)) objectsByTag.set(tag, object.name);
  }

  for (const [tag, objectType] of objectsByTag) {
    const expected = expectedSchemaPropertyMap(objectType, tag);
    if (!expected.size) continue;
    const tagObjects = await readNativeTagObjects(tag);
    const found = new Set<string>();
    for (const tagObject of tagObjects) {
      for (const prop of await collectNativeTagSchemaProperties(tagObject, expected)) found.add(prop);
    }
    if (found.size) {
      findings.push({ tag, objectType, properties: [...found].sort((a, b) => a.localeCompare(b)) });
    }
  }
  return { available: true, findings };
}

export async function diagnoseNativeTagSchemaProperties(): Promise<string[]> {
  const lines = ['## Native tag schema properties'];
  const { available, findings } = await readNativeTagSchemaFindings();
  if (!available) {
    lines.push('native-tag-schema-inspection:: unavailable');
    lines.push('- getTag/getTagsByName APIs unavailable; run lss:11 if journal blocks still show schema fields.');
    return lines;
  }

  if (!findings.length) {
    lines.push('native-tag-schema-pollution:: none');
    lines.push('- LSS native tags do not expose registry schema properties through inspected tag metadata.');
    return lines;
  }

  lines.push(`native-tag-schema-pollution:: ${findings.length}`);
  for (const finding of findings) {
    lines.push(
      `- #${finding.tag} (${finding.objectType}) still has native schema properties: ${finding.properties.join(', ')}`,
    );
  }
  lines.push('- action: run lss: 11setup-db-native-config to remove native tag schema properties, then run lss: materialise page on polluted journals.');
  return lines;
}
