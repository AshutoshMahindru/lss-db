import { safeTag } from '../core/names';
import {
  allObjects,
  dashboardPageForObjectType,
  objectByName,
  registry,
  templateDefByObjectType,
  templateNameFromRegistry,
} from '../registry';
import type { RegistryTemplate, ViewDefinition } from '../registry/types';
import { sectionNameFromLine } from './dashboard-query-repair';
import { simpleQueryForView } from './query-builders';

export function queryLineForView(view: ViewDefinition, indent: string, inlineQueryTag = true): string[] {
  const query = simpleQueryForView(view);
  if (!query) return [];
  // Put #Query before the s-expression so a trailing ")" cannot create a phantom #Tag) tag.
  const line = inlineQueryTag ? `${indent}  - #Query ${query}` : `${indent}  - ${query}`;
  return [line];
}

export function templateSectionAliases(template: RegistryTemplate, section: string): string {
  const raw = String(section ?? '');
  const sections = [...templateBodySectionSet(template)];
  return sections.find((candidate) => sectionsMatch(candidate, raw)) ?? raw;
}

function normalizedSectionName(value: string): string {
  return String(value ?? '').trim().toLowerCase().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ');
}

function equivalentSectionKeys(value: string): Set<string> {
  const key = normalizedSectionName(value);
  const keys = new Set<string>([key]);
  if (['open actions', 'next actions', 'action items', 'action item'].includes(key)) keys.add('action items');
  if (key === 'documents/outputs' || key === 'documents outputs') {
    keys.add('documents');
    keys.add('outputs');
  }
  return keys;
}

function sectionsMatch(section: string, viewSection: string): boolean {
  const left = equivalentSectionKeys(section);
  const right = equivalentSectionKeys(viewSection);
  return [...left].some((key) => right.has(key));
}

export function templateBodySectionSet(template: RegistryTemplate): Set<string> {
  const set = new Set<string>();
  for (const line of String(template.body ?? '').split(/\r?\n/)) {
    const section = sectionNameFromLine(line);
    if (section) set.add(section);
  }
  return set;
}

export function viewKey(view: ViewDefinition): string {
  const tags = (view.sourceTags ?? []).join('|');
  const filters = (view.filters ?? [])
    .map(
      (f) =>
        `${f.property ?? (f.propertyAny ?? []).join('|')}:${f.operator ?? ''}:${
          Array.isArray(f.value) ? f.value.join('|') : f.value ?? ''
        }`,
    )
    .join(';');
  return `${view.section}::${tags}::${filters}`;
}

export function makeView(
  objectType: string,
  section: string,
  sourceTags: string | string[],
  filterProp: string | string[],
): ViewDefinition {
  const tags = Array.isArray(sourceTags) ? sourceTags : [sourceTags];
  const filters = Array.isArray(filterProp)
    ? [{ propertyAny: filterProp, operator: 'includesCurrentPage' }]
    : [{ property: filterProp, operator: 'includesCurrentPage' }];
  return {
    id: `LSS-TEMPLATE-${objectType}-${String(section).replace(/[^a-zA-Z0-9]+/g, '-').toUpperCase()}`,
    title: `${objectType} / ${section}`,
    dashboard: dashboardPageForObjectType(objectType) ?? undefined,
    section,
    sourceTags: tags,
    filters,
    viewType: 'table',
    nativeQueryStatus: 'template-query-block',
    exportPolicy: 'inherit',
  };
}

export function supplementalTemplateViews(template: RegistryTemplate): ViewDefinition[] {
  const objectType = templateNameFromRegistry(template);
  const views: ViewDefinition[] = [];
  if (objectType === 'Venture') {
    views.push(
      makeView(objectType, 'Organisations', 'Organisation', ['venture', 'related-venture']),
      makeView(objectType, 'People', 'Person', ['venture', 'related-venture']),
    );
  }
  if (objectType === 'Function') {
    views.push(
      makeView(objectType, 'People', 'Person', ['function', 'related-function']),
      makeView(objectType, 'Documents', ['Document', 'File'], ['function', 'related-function']),
    );
  }
  if (objectType === 'Person') {
    views.push(
      makeView(objectType, 'Organisations', 'Organisation', ['relationship-owner', 'related-person']),
      makeView(objectType, 'Notes', 'Note', ['related-person', 'attendees', 'owner']),
    );
  }
  return views;
}

export function autoRelationshipTemplateViews(template: RegistryTemplate): ViewDefinition[] {
  const objectType = templateNameFromRegistry(template);
  const sections = templateBodySectionSet(template);
  const views: ViewDefinition[] = [];

  for (const rel of registry.relationshipRegistry ?? []) {
    const targets = rel.targets ?? [];
    if (!targets.map(safeTag).includes(safeTag(objectType))) continue;
    const related = [
      ...(Array.isArray(rel.requiredBy) ? rel.requiredBy : []),
      ...(Array.isArray(rel.optionalBy)
        ? rel.optionalBy
        : String(rel.optionalBy ?? '')
            .split(/[.,\s]+/)
            .filter(Boolean)),
    ];
    for (const relatedName of related) {
      const obj = objectByName(relatedName);
      if (!obj) continue;
      const section = String(obj.dashboardSection ?? obj.name ?? relatedName).trim();
      if (!section || (sections.size && !sections.has(section))) continue;
      views.push(makeView(objectType, section, obj.name ?? relatedName, rel.property));
    }
  }
  return views;
}

export function viewDefinitionsSafe(template: RegistryTemplate): ViewDefinition[] {
  const objectType = templateNameFromRegistry(template);
  const dashboard = dashboardPageForObjectType(objectType);
  const bodySections = templateBodySectionSet(template);
  const views: ViewDefinition[] = [];

  const allowed = (section: string) => {
    const name = String(section ?? '').trim();
    return name && (!bodySections.size || bodySections.has(name));
  };

  if (dashboard) {
    for (const view of registry.viewDefinitions ?? []) {
      if (view.dashboard !== dashboard) continue;
      const mapped = { ...view, section: templateSectionAliases(template, view.section ?? '') };
      if (allowed(mapped.section ?? '')) views.push(mapped);
    }
  }

  views.push(...autoRelationshipTemplateViews(template));
  for (const extra of supplementalTemplateViews(template)) {
    const section = String(extra.section ?? '').trim();
    if (allowed(section)) views.push({ ...extra, section });
  }

  const deduped: ViewDefinition[] = [];
  const seenKeys = new Set<string>();
  for (const view of views) {
    const section = String(view.section ?? '').trim();
    if (!section) continue;
    const normalized = { ...view, section };
    const key = viewKey(normalized);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    deduped.push(normalized);
  }
  return deduped;
}

export function viewsForDashboardKind(kind: string): ViewDefinition[] {
  const template = templateDefByObjectType(kind);
  if (template) return viewDefinitionsSafe(template);
  const dashboardPage = `Dashboard/${kind}`;
  return (registry.viewDefinitions ?? []).filter((v) => v.dashboard === dashboardPage);
}

export function filterIntentText(filter: NonNullable<ViewDefinition['filters']>[number]): string {
  const prop =
    filter.property ?? (Array.isArray(filter.propertyAny) ? filter.propertyAny.join(' or ') : '-');
  const op = filter.operator ?? '-';
  const value = Array.isArray(filter.value) ? filter.value.join(', ') : filter.value ?? '';
  if (op === 'includesCurrentPage') return `${prop} includes current page`;
  if (op === 'notIn') return `${prop} not in ${value}`;
  if (op === 'in') return `${prop} in ${value}`;
  if (op === 'onOrBeforeToday') return `${prop} on or before today`;
  if (op === 'withinDays') return `${prop} within ${value} days`;
  return `${prop} ${op}${value ? ` ${value}` : ''}`.trim();
}

export function objectTypesUsingProperty(property: string): string[] {
  const names: string[] = [];
  for (const obj of allObjects()) {
    if ((obj.properties ?? []).includes(property)) names.push(obj.name);
  }
  return names;
}

export function relationshipPropertyNames(): string[] {
  const set = new Set<string>();
  for (const rel of registry.relationshipRegistry ?? []) {
    if (rel.property) set.add(String(rel.property));
  }
  return [...set];
}

export function tagsRequiringConfidentiality(): Set<string> {
  const set = new Set<string>();
  for (const obj of allObjects()) {
    if ((obj.properties ?? []).includes('confidentiality')) {
      set.add(safeTag(obj.tag));
      set.add(obj.name);
    }
  }
  return set;
}

export function sensitiveAreaTags(): string[] {
  return ['HealthObject', 'WealthObject'];
}
