import {
  canonicalPropertyKey,
  pageHasClassTag,
} from '../core/db-properties';
import {
  blockId,
  getPage,
  pageVisibleName,
  walkBlocks,
} from '../core/editor';
import { safePageName, safeTag, visiblePageLabel } from '../core/names';
import type { Result } from '../core/types';
import { allObjects, allRelationships, objectByName, propertySpec, registry } from '../registry';
import type { RegistryObject } from '../registry/types';
import { uniqueObjectProps } from './templates';

const MATERIALISE_HINT_IGNORE_TAGS = new Set([
  'Page',
  'Pages',
  'Block',
  'Blocks',
  'Tag',
  'Tags',
  'Class',
  'Property',
  'Properties',
  'Template',
  'Task',
  'Query',
  'Code',
  'Asset',
  'Status',
  'Area',
  'Owner',
  'LssObjectType',
  'LssObjectTag',
]);

function canonicalObjectTypeToken(token: string): string | null {
  const raw = safePageName(safeTag(token));
  if (!raw) return null;
  const object = objectByName(raw);
  return object?.name ?? null;
}

export function isInstanceHintTag(tag: string): boolean {
  const clean = safeTag(tag);
  const propertyKey = canonicalPropertyKey(clean);
  return Boolean(clean) &&
    !MATERIALISE_HINT_IGNORE_TAGS.has(clean) &&
    !propertySpec(propertyKey) &&
    !allRelationships().some((rel) => canonicalPropertyKey(rel.property ?? '') === propertyKey) &&
    !canonicalObjectTypeToken(clean);
}

export function harvestInlineTags(blocks: any[]): Set<string> {
  const tags = new Set<string>();
  for (const block of walkBlocks(blocks)) {
    const text = String(block?.content ?? '');
    const re = /#(?:\[\[([^\]]+?)\]\]|([A-Za-z0-9_-]+))/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text))) {
      const tag = safeTag(match[1] || match[2]);
      if (tag) tags.add(tag);
    }
  }
  return tags;
}

function pageNamesEquivalent(a: string, b: string): boolean {
  return safePageName(a).toLowerCase() === safePageName(b).toLowerCase();
}

function relationshipNamesFromText(value: string): string[] {
  const text = String(value ?? '').trim();
  if (!text) return [];
  const refs: string[] = [];
  const re = /\[\[([^\]]+)\]\]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) if (match[1]) refs.push(visiblePageLabel(match[1]));
  if (refs.length) return refs;
  if (text.includes('#') || /^https?:/i.test(text)) return [];
  return text
    .split(',')
    .map((item) => visiblePageLabel(item.trim().replace(/^"|"$/g, '')))
    .filter(Boolean);
}

function relationshipRefText(value: string): string {
  const label = safePageName(visiblePageLabel(value));
  return label ? `[[${label}]]` : '';
}

function appendRelationshipText(current: string | undefined, refText: string): string {
  if (!refText) return current ?? '';
  const existing = new Set(relationshipNamesFromText(current ?? '').map((item) => safePageName(item)));
  const label = safePageName(visiblePageLabel(refText));
  if (label) existing.add(label);
  return [...existing].map(relationshipRefText).filter(Boolean).join(', ');
}

function registryListIncludes(value: unknown, sourceType: string): boolean {
  const list = Array.isArray(value)
    ? value
    : String(value ?? '')
        .split(/[,\s]+/)
        .filter(Boolean);
  return list.map((item) => String(item).toLowerCase()).includes(sourceType.toLowerCase());
}

function relationshipPriority(property: string, targetType: string): number {
  const priorities: Record<string, string[]> = {
    Venture: ['venture', 'related-venture'],
    Project: ['project', 'related-project'],
    Function: ['function', 'related-function'],
    Person: ['participants', 'attendees', 'owner', 'assigned-to', 'stakeholders', 'related-person'],
    Organisation: ['participants', 'organisation', 'stakeholders', 'related-organisation'],
    Subject: ['subject', 'related-subject'],
    Condition: ['condition', 'related-condition'],
    Area: ['area', 'areas'],
  };
  const idx = (priorities[targetType] ?? []).indexOf(property);
  return idx === -1 ? 100 : idx;
}

function relationshipPropertyForHint(object: RegistryObject, targetType: string): string | null {
  const sourceProps = new Set(uniqueObjectProps(object).map(canonicalPropertyKey));
  if (targetType === 'Area') {
    if (sourceProps.has('area')) return 'area';
    if (sourceProps.has('areas')) return 'areas';
  }
  const candidates = allRelationships()
    .filter((rel) => sourceProps.has(canonicalPropertyKey(rel.property ?? '')))
    .filter((rel) => {
      const targets = [
        ...((rel.targets ?? []) as unknown[]),
        ...((rel.allowedTargets ?? []) as unknown[]),
        ...((rel.targetTags ?? []) as unknown[]),
      ].map((item) => safeTag(String(item)).toLowerCase());
      return !targets.length || targets.includes(targetType.toLowerCase());
    })
    .filter((rel) => registryListIncludes(rel.requiredBy, object.name) || registryListIncludes(rel.optionalBy, object.name))
    .sort((a, b) => {
      const aRequired = registryListIncludes(a.requiredBy, object.name) ? 0 : 1;
      const bRequired = registryListIncludes(b.requiredBy, object.name) ? 0 : 1;
      return aRequired - bRequired || relationshipPriority(a.property ?? '', targetType) - relationshipPriority(b.property ?? '', targetType);
    });
  return candidates[0]?.property ?? null;
}

async function objectTypeForResolvedPage(pageName: string): Promise<string | null> {
  const page = (await getPage(pageName)) || (await getPage(safePageName(pageName))) || (await getPage(pageName.toLowerCase()));
  const pageId = blockId(page);
  if (!pageId) return null;
  for (const object of allObjects()) {
    if (await pageHasClassTag(pageId, safeTag(object.tag))) return object.name;
  }
  if (await pageHasClassTag(pageId, 'Area')) return 'Area';
  return null;
}

async function resolveHintTagToPage(tag: string): Promise<string | null> {
  const clean = safePageName(safeTag(tag));
  if (!clean) return null;
  const page = (await getPage(clean)) || (await getPage(clean.toLowerCase()));
  const label = pageVisibleName(page, clean);
  return label ? safePageName(label) : null;
}

export async function applyInstanceHintTagsToProps(
  result: Result,
  object: RegistryObject,
  props: Map<string, string>,
  instanceHints: Set<string>,
  pageName: string,
): Promise<void> {
  if (!instanceHints.size) return;
  const sourceProps = new Set(uniqueObjectProps(object).map(canonicalPropertyKey));
  for (const hint of [...instanceHints].filter(isInstanceHintTag)) {
    const page = await resolveHintTagToPage(hint);
    if (!page) {
      result.notes.push(`Materialise hint #${hint}: no matching page found.`);
      continue;
    }
    if (pageNamesEquivalent(page, pageName)) continue;
    const targetType = await objectTypeForResolvedPage(page);
    if (!targetType) {
      result.notes.push(`Materialise hint #${hint}: resolved to [[${page}]] but target page has no LSS type.`);
      continue;
    }
    const relationship = relationshipPropertyForHint(object, targetType);
    if (relationship) {
      const spec = propertySpec(relationship);
      const ref = relationshipRefText(page);
      if (String((spec as { cardinality?: string } | undefined)?.cardinality ?? '').toLowerCase() === 'many') {
        props.set(relationship, appendRelationshipText(props.get(relationship), ref));
      } else if (!String(props.get(relationship) ?? '').trim()) {
        props.set(relationship, ref);
      } else {
        result.notes.push(`Materialise hint #${hint}: ${relationship} already has a value on ${pageName}; left existing value.`);
      }
      result.actions.push(`MATERIALISE hint #${hint}: ${relationship} -> [[${page}]]`);
    } else {
      result.notes.push(`Materialise hint #${hint}: no specific relationship maps ${object.name} to ${targetType}.`);
      if (sourceProps.has('related-to')) {
        props.set('related-to', appendRelationshipText(props.get('related-to'), relationshipRefText(page)));
      }
    }
  }
}
