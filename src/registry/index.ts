import { isLogseqBuiltinTag } from '../core/builtin-tags';
import rawRegistry from './data.json';
import { pageForCanonical, safePageName, safeTag } from '../core/names';
import type { LssRegistry, RegistryObject, RegistryTemplate } from './types';

export const registry = rawRegistry as LssRegistry;

export { pageForCanonical };

export function normalizeAreaRef(area: string | undefined): string {
  return String(area ?? 'Area/Cross-Cutting').replace('Cross-Area', 'Area/Cross-Cutting');
}

export function allObjects(): RegistryObject[] {
  return [...(registry.entityTypes ?? []), ...(registry.formTypes ?? []), ...(registry.wordExtenderTypes ?? [])];
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

/** LSS class tags that can be created/configured in DB setup (excludes Logseq built-ins). */
export function nativeDbClassTags(): string[] {
  return allTags().filter((tag) => !isLogseqBuiltinTag(tag));
}

export function propertySpec(name: string) {
  return (registry.propertyRegistry ?? []).find((p) => p.name === name || p.property === name || p.key === name);
}

export function relationshipsForTag(tag: string) {
  const properties = new Set<string>();
  for (const o of allObjects()) if (safeTag(o.tag) === tag) for (const p of o.properties ?? []) properties.add(p);
  return (registry.relationshipRegistry ?? []).filter((r) => properties.has(r.property));
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
  for (const p of ['LSS Reports', 'LSS Page Tree', 'LSS Native Templates', 'LSS Command List']) roots.add(p);
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