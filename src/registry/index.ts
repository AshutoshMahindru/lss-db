import { isLogseqBuiltinTag } from '../core/builtin-tags';
import rawRegistry from './data.json';
import { pageForCanonical, safePageName, safeTag } from '../core/names';
import type { LssRegistry, RegistryObject, RegistryRelationship, RegistryTemplate } from './types';

export const registry = rawRegistry as LssRegistry;

export { pageForCanonical };

export function normalizeAreaRef(area: string | undefined): string {
  return String(area ?? 'Area/Cross-Cutting').replace('Cross-Area', 'Area/Cross-Cutting');
}

export function allObjects(): RegistryObject[] {
  return [...(registry.entityTypes ?? []), ...(registry.formTypes ?? []), ...(registry.wordExtenderTypes ?? [])];
}

function registryPropertyName(spec: Record<string, unknown>): string {
  return String(spec.name ?? spec.property ?? spec.key ?? '').trim();
}

function registryPropertySpec(name: string): Record<string, unknown> | undefined {
  return (registry.propertyRegistry ?? []).find((p) => p.name === name || p.property === name || p.key === name) as
    | Record<string, unknown>
    | undefined;
}

function targetTags(spec: Record<string, unknown> | undefined): string[] {
  return ((spec?.targets as unknown[] | undefined) ?? []).map((target) => safeTag(String(target))).filter(Boolean);
}

function entitySlug(object: RegistryObject): string {
  const tag = safeTag(object.tag || object.name);
  if (tag === 'WorkStream') return 'workstream';
  return tag
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

function pluralSlug(slug: string): string {
  if (slug.endsWith('y')) return `${slug.slice(0, -1)}ies`;
  if (slug.endsWith('s')) return `${slug}es`;
  return `${slug}s`;
}

function registeredManyRelatedPropertyForTarget(target: RegistryObject): string | null {
  const targetTag = safeTag(target.tag || target.name);
  const slug = entitySlug(target);
  const candidates = ((registry.propertyRegistry ?? []) as Array<Record<string, unknown>>).filter((spec) => {
    const name = registryPropertyName(spec);
    return (
      name.startsWith('related-') &&
      name !== 'related-to' &&
      String(spec.type ?? '').toLowerCase() === 'node' &&
      String(spec.cardinality ?? '').toLowerCase() === 'many' &&
      targetTags(spec).includes(targetTag)
    );
  });
  return (
    registryPropertyName(candidates.find((spec) => registryPropertyName(spec) === `related-${slug}`) ?? {}) ||
    registryPropertyName(candidates[0] ?? {}) ||
    null
  );
}

export function areaRelationshipPropertyNameForTarget(target: RegistryObject): string {
  const registered = registeredManyRelatedPropertyForTarget(target);
  if (registered) return registered;
  const slug = entitySlug(target);
  const base = `related-${slug}`;
  const existing = registryPropertySpec(base);
  if (!existing) return base;
  const plural = `related-${pluralSlug(slug)}`;
  return registryPropertySpec(plural) ? `${base}-items` : plural;
}

function objectHasRelationshipToTarget(object: RegistryObject, target: RegistryObject): boolean {
  const targetTag = safeTag(target.tag || target.name);
  for (const prop of [...(object.requiredProperties ?? []), ...(object.properties ?? [])]) {
    const spec = registryPropertySpec(prop);
    if (String(spec?.type ?? '').toLowerCase() !== 'node') continue;
    if (targetTags(spec).includes(targetTag)) return true;
  }
  return false;
}

export function areaRelationshipPropertiesForObject(object: RegistryObject): string[] {
  const area = normalizeAreaRef(object.area);
  if (!String(object.area ?? '').trim()) return [];
  return (registry.entityTypes ?? [])
    .filter((target) => normalizeAreaRef(target.area) === area)
    .filter((target) => safeTag(target.tag) !== safeTag(object.tag))
    .filter((target) => !objectHasRelationshipToTarget(object, target))
    .map((target) => areaRelationshipPropertyNameForTarget(target));
}

function generatedAreaPropertySpecs(): Array<Record<string, unknown>> {
  const specs = new Map<string, Record<string, unknown>>();
  for (const target of registry.entityTypes ?? []) {
    const property = areaRelationshipPropertyNameForTarget(target);
    if (registryPropertySpec(property)) continue;
    specs.set(property, {
      name: property,
      type: 'node',
      cardinality: 'many',
      targets: [safeTag(target.tag || target.name)],
      bidirectional: true,
      inverseTitle: 'Related Objects',
      choices: [],
      default: null,
      aliases: [],
      sensitivity: 'normal',
      uiPosition: null,
      description: `Generated same-area relationship to ${target.name} pages.`,
    });
  }
  return [...specs.values()];
}

export function allPropertySpecs(): Array<Record<string, unknown>> {
  const byName = new Map<string, Record<string, unknown>>();
  for (const spec of (registry.propertyRegistry ?? []) as Array<Record<string, unknown>>) byName.set(registryPropertyName(spec), spec);
  for (const spec of generatedAreaPropertySpecs()) byName.set(registryPropertyName(spec), spec);
  return [...byName.values()].filter((spec) => registryPropertyName(spec));
}

export function allRelationships(): RegistryRelationship[] {
  const byProperty = new Map<string, RegistryRelationship & { optionalBy?: string[] }>();
  for (const rel of registry.relationshipRegistry ?? []) {
    const property = String(rel.property ?? '').trim();
    if (!property) continue;
    byProperty.set(property, { ...rel, optionalBy: Array.isArray(rel.optionalBy) ? [...rel.optionalBy] : rel.optionalBy ? [String(rel.optionalBy)] : [] });
  }
  const add = (property: string, target: RegistryObject, source: RegistryObject) => {
    const existing = byProperty.get(property);
    const optionalBy = new Set([...(existing?.optionalBy ?? []), source.name]);
    byProperty.set(property, {
      ...(existing ?? {
        property,
        type: 'node',
        targets: [safeTag(target.tag || target.name)],
        cardinality: 'many',
        bidirectional: true,
        inverseLabel: 'Related Objects',
      }),
      optionalBy: [...optionalBy],
    });
  };
  for (const source of allObjects()) {
    const area = normalizeAreaRef(source.area);
    if (!String(source.area ?? '').trim()) continue;
    for (const target of registry.entityTypes ?? []) {
      if (normalizeAreaRef(target.area) !== area || safeTag(target.tag) === safeTag(source.tag)) continue;
      if (objectHasRelationshipToTarget(source, target)) continue;
      add(areaRelationshipPropertyNameForTarget(target), target, source);
    }
  }
  return [...byProperty.values()];
}

export function allTags(): string[] {
  const set = new Set<string>();
  for (const tag of registry.baseTags ?? []) set.add(safeTag(tag.name ?? tag.tag ?? String(tag)));
  for (const area of registry.areas ?? []) if (area.tag) set.add(safeTag(area.tag));
  for (const o of allObjects()) if (o.tag) set.add(safeTag(o.tag));
  for (const extra of ['Area', 'EntityType', 'FormType', 'DashboardType', 'RelationshipType', 'Template', 'Task', 'Query']) {
    set.add(extra);
  }
  return [...set].filter(Boolean).sort((a, b) => a.localeCompare(b));
}

export function canCreateNativeDbTag(tag: string): boolean {
  const clean = safeTag(tag);
  return Boolean(clean) && !clean.includes('/') && !isLogseqBuiltinTag(clean);
}

/** LSS class tags that can be created/configured in DB setup (excludes Logseq built-ins). */
export function nativeDbClassTags(): string[] {
  return allTags().filter(canCreateNativeDbTag);
}

export function propertySpec(name: string) {
  return allPropertySpecs().find((p) => p.name === name || p.property === name || p.key === name);
}

export function relationshipsForTag(tag: string) {
  const properties = new Set<string>();
  for (const o of allObjects()) if (safeTag(o.tag) === tag) for (const p of [...(o.properties ?? []), ...areaRelationshipPropertiesForObject(o)]) properties.add(p);
  return allRelationships().filter((r) => properties.has(r.property));
}

export function objectsForArea(areaPage: string): RegistryObject[] {
  return allObjects().filter((o) => normalizeAreaRef(o.area) === areaPage);
}

export function objectByName(name: string): RegistryObject | undefined {
  return allObjects().find(
    (t) => t.name.toLowerCase() === name.toLowerCase() || safeTag(t.tag).toLowerCase() === name.toLowerCase(),
  );
}

export function templateNameFromRegistry(template: RegistryTemplate): string {
  const applies = (template.appliesTo ?? [])[0];
  if (applies) return String(applies);
  return String(template.name ?? '').replace(/^Template\//, '');
}

export function templateDefByObjectType(objectType: string): RegistryTemplate | undefined {
  const key = safeTag(objectType);
  return (registry.templates ?? []).find((t) => {
    const name = String(t.name ?? '').replace(/^Template\//, '');
    return name === key || (t.appliesTo ?? []).map(safeTag).includes(key);
  });
}

export function dashboardPageForObjectType(objectType: string): string | null {
  const map: Record<string, string> = {
    Venture: 'Dashboard/Venture',
    Function: 'Dashboard/Function',
    Project: 'Dashboard/Project',
    Person: 'Dashboard/Person',
    Condition: 'Dashboard/Condition',
    Subject: 'Dashboard/LearningSubject',
    LearningSubject: 'Dashboard/LearningSubject',
    Area: 'Dashboard/Area',
  };
  return map[objectType] ?? null;
}

export function rootPages(): string[] {
  const roots = new Set<string>(registry.rootPages ?? []);
  for (const p of ['LSS Reports', 'LSS Page Tree', 'LSS Area Model', 'LSS Native Templates', 'LSS Command List']) {
    roots.add(p);
  }
  return [...roots];
}

export function layerPages(): string[] {
  return [
    'LSS Layer/Schema Pages',
    'LSS Layer/DB Tags',
    'LSS Layer/Tag Properties',
    'LSS Layer/Templates',
    'LSS Layer/Word Extenders',
    'LSS Layer/Dashboards',
    'LSS Layer/Relationships',
    'LSS Layer/Areas',
    'LSS Layer/Install Result',
  ].map((n) => safePageName(n));
}

export function dashboardDefForKind(kind: string) {
  return (registry.dashboardDefinitions ?? []).find((x) => String(x.page ?? '').toLowerCase().includes(kind.toLowerCase()));
}
