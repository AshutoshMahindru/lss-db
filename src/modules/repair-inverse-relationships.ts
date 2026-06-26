import {
  canonicalPropertyKey,
  entityIdentity,
  looksLikePageEntityId,
  pageHasClassTag,
  readRelationshipPropertyValue,
  resolveUpsertPropertyValue,
} from '../core/db-properties';
import { blockId, getPage, pageVisibleName, resolvePageFromIdentity } from '../core/editor';
import { safePageName, safeTag } from '../core/names';
import { formatError, sleep } from '../core/runner';
import type { Result } from '../core/types';
import { allObjects, propertySpec } from '../registry';
import type { RegistryObject } from '../registry/types';
import { uniqueObjectProps } from './templates';
import { readDatascriptUserPropertyValue } from './repair-user-properties';
import { upsertBlockPropertyViaHost } from './advanced-query-blocks';

function repairPageRefsFromValue(value: string): string[] {
  const refs: string[] = [];
  const re = /\[\[([^\]]+)\]\]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(String(value ?? '')))) if (match[1]) refs.push(safePageName(match[1]));
  return refs;
}

function pageNamesEquivalent(a: string, b: string): boolean {
  return safePageName(a).toLowerCase() === safePageName(b).toLowerCase();
}

function relationshipRefText(pageName: string): string {
  const safe = safePageName(pageName);
  return safe ? `[[${safe}]]` : '';
}

function isPlaceholderPageRefName(name: string): boolean {
  const raw = String(name ?? '').trim();
  const safe = safePageName(raw);
  return /^LSS Placeholder(?:\/| - )/i.test(raw) || /^LSS Placeholder(?:\/| - )/i.test(safe);
}

function pageRefListText(names: string[]): string {
  return names.map(relationshipRefText).filter(Boolean).join(', ');
}

function propertyTargetsObject(property: string, object: RegistryObject): boolean {
  const spec = propertySpec(property) as Record<string, unknown> | undefined;
  if (String(spec?.type ?? '').toLowerCase() !== 'node') return false;
  const targets = ((spec?.targets as unknown[] | undefined) ?? [])
    .map((target) => safeTag(String(target)))
    .filter(Boolean);
  return targets.includes(safeTag(object.tag || object.name));
}

function propertyAllowsTarget(property: string, target: RegistryObject): boolean {
  const spec = propertySpec(property) as Record<string, unknown> | undefined;
  const targets = ((spec?.targets as unknown[] | undefined) ?? [])
    .map((item) => safeTag(String(item)))
    .filter(Boolean);
  return !targets.length || targets.includes(safeTag(target.tag || target.name));
}

function inverseRelationshipPropertyForTarget(target: RegistryObject, current: RegistryObject): string | null {
  for (const property of uniqueObjectProps(target)) {
    if (property === 'related-to') continue;
    if (propertyTargetsObject(property, current)) return property;
  }
  return null;
}

async function typedPageObject(pageName: string): Promise<{ object: RegistryObject; pageBlockId: string } | null> {
  const page =
    (await getPage(pageName)) ||
    (await getPage(safePageName(pageName))) ||
    (await getPage(pageName.toLowerCase()));
  const pageBlockId = blockId(page);
  if (!pageBlockId) return null;
  const identity = entityIdentity(page) || pageBlockId;
  for (const object of allObjects()) {
    const tag = safeTag(object.tag || object.name);
    if (tag && (await pageHasClassTag(identity, tag))) return { object, pageBlockId };
  }
  return null;
}

async function pageNameFromIdentity(identity: unknown): Promise<string | null> {
  if (identity == null) return null;
  if (typeof identity === 'object') {
    const name = pageVisibleName(identity as Record<string, unknown>);
    if (name) return safePageName(name);
    const id = (identity as Record<string, unknown>).id ?? (identity as Record<string, unknown>).uuid;
    if (id == null) return null;
    return pageNameFromIdentity(id);
  }
  const raw = String(identity).trim();
  if (!raw) return null;
  if (!looksLikePageEntityId(raw) && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) {
    return safePageName(raw);
  }
  const page = await resolvePageFromIdentity(raw).catch(() => null);
  const name = pageVisibleName(page as Record<string, unknown> | null, raw);
  return name ? safePageName(name) : null;
}

async function pageNamesFromPropertyValue(value: unknown): Promise<string[]> {
  if (value == null) return [];
  if (Array.isArray(value)) {
    const nested = await Promise.all(value.map((item) => pageNamesFromPropertyValue(item)));
    return nested.flat();
  }
  if (typeof value === 'string') {
    const refs = repairPageRefsFromValue(value);
    if (refs.length) return refs;
  }
  const name = await pageNameFromIdentity(value);
  return name ? [name] : [];
}

async function readCurrentRelationshipValue(pageBlockId: string, property: string): Promise<unknown> {
  const userValue = await readDatascriptUserPropertyValue(pageBlockId, property);
  if (userValue !== undefined) return userValue;
  const relValue = await readRelationshipPropertyValue(pageBlockId, property);
  if (relValue !== undefined) return relValue;
  if (!logseq.Editor.getBlockProperties) return undefined;
  const props = ((await logseq.Editor.getBlockProperties(pageBlockId).catch(() => null)) ?? {}) as Record<string, unknown>;
  for (const [key, value] of Object.entries(props)) {
    if (canonicalPropertyKey(key) === property) return value;
  }
  return undefined;
}

async function upsertRelationshipValue(
  result: Result,
  pageBlockId: string,
  property: string,
  textValue: string,
): Promise<boolean> {
  const upsertValue = await resolveUpsertPropertyValue(property, textValue);
  if (typeof upsertValue === 'string') {
    result.notes.push(`Inverse relationship sync skipped ${property}; could not resolve ${textValue}.`);
    return false;
  }
  try {
    await logseq.Editor.upsertBlockProperty?.(pageBlockId, property, upsertValue, { reset: true });
    await sleep(15);
    return true;
  } catch (error) {
    if (!/timeout|deferred|async call/i.test(formatError(error))) {
      result.errors.push(`sync inverse relationship ${property}: ${formatError(error)}`);
      return false;
    }
    const host = await upsertBlockPropertyViaHost(pageBlockId, property, upsertValue, { reset: true });
    if (host.ok) {
      result.notes.push(`Used host API fallback for inverse relationship ${property}.`);
      await sleep(15);
      return true;
    }
    result.errors.push(`sync inverse relationship ${property}: ${formatError(error)}; host fallback failed: ${host.error ?? 'unknown error'}`);
    return false;
  }
}

export async function syncInverseRelationshipProperties(
  result: Result,
  pageName: string,
  currentObject: RegistryObject,
  props: Map<string, string>,
): Promise<number> {
  let changed = 0;
  const touched = new Set<string>();
  const schemaProps = new Set(uniqueObjectProps(currentObject).map(canonicalPropertyKey));

  for (const [rawProp, rawValue] of props.entries()) {
    const prop = canonicalPropertyKey(rawProp);
    if (!schemaProps.has(prop)) continue;
    const spec = propertySpec(prop) as Record<string, unknown> | undefined;
    if (String(spec?.type ?? '').toLowerCase() !== 'node' || spec?.bidirectional !== true) continue;

    for (const ref of repairPageRefsFromValue(rawValue)) {
      if (!ref || isPlaceholderPageRefName(ref) || pageNamesEquivalent(ref, pageName)) continue;
      const target = await typedPageObject(ref);
      if (!target || !propertyAllowsTarget(prop, target.object)) continue;

      const inverseProp = inverseRelationshipPropertyForTarget(target.object, currentObject);
      if (!inverseProp) continue;
      const touchKey = `${target.pageBlockId}:${inverseProp}`;
      if (touched.has(touchKey)) continue;
      touched.add(touchKey);

      const currentValue = await readCurrentRelationshipValue(target.pageBlockId, inverseProp);
      const existingNames = (await pageNamesFromPropertyValue(currentValue))
        .map(safePageName)
        .filter((name) => name && !isPlaceholderPageRefName(name));
      if (existingNames.some((name) => pageNamesEquivalent(name, pageName))) continue;

      const inverseSpec = propertySpec(inverseProp) as Record<string, unknown> | undefined;
      const cardinality = String(inverseSpec?.cardinality ?? '').toLowerCase();
      if (cardinality === 'one' && existingNames.length) {
        result.notes.push(
          `Inverse relationship sync skipped ${safePageName(ref)}.${inverseProp}; existing single-valued relationship is already set.`,
        );
        continue;
      }

      const nextText = pageRefListText([...existingNames, pageName]);
      if (!nextText) continue;
      if (await upsertRelationshipValue(result, target.pageBlockId, inverseProp, nextText)) {
        changed++;
        result.actions.push(
          `SYNC inverse relationship: [[${safePageName(ref)}]].${inverseProp} includes [[${safePageName(pageName)}]]`,
        );
      }
    }
  }

  if (changed) result.notes.push(`Synced ${changed} inverse relationship property value(s) for ${currentObject.name}.`);
  return changed;
}
