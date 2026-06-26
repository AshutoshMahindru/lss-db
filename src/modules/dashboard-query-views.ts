import { safeTag } from '../core/names';
import {
  areaRelationshipPropertiesForObject,
  allRelationships,
  allObjects,
  dashboardPageForObjectType,
  normalizeAreaRef,
  objectByName,
  propertySpec,
  registry,
  templateDefByObjectType,
  templateNameFromRegistry,
} from '../registry';
import type { RegistryObject, RegistryTemplate, ViewDefinition } from '../registry/types';
import { sectionNameFromLine } from './dashboard-query-repair';
import { queryTitleForView, simpleQueryForView } from './query-builders';

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

function viewSectionSourceKey(view: ViewDefinition): string {
  const section = normalizedSectionName(String(view.section ?? ''));
  const tags = (view.sourceTags ?? []).map(safeTag).sort((a, b) => a.localeCompare(b)).join('|');
  return `${section}::${tags}`;
}

function viewTitleKey(view: ViewDefinition): string {
  return normalizedSectionName(queryTitleForView(view));
}

function sameSourceTags(left: ViewDefinition, right: ViewDefinition): boolean {
  return (
    (left.sourceTags ?? []).map(safeTag).sort((a, b) => a.localeCompare(b)).join('|') ===
    (right.sourceTags ?? []).map(safeTag).sort((a, b) => a.localeCompare(b)).join('|')
  );
}

export function sourceTagsForView(view: ViewDefinition): string[] {
  return (view.sourceTags ?? []).map((tag) => safeTag(String(tag))).filter(Boolean);
}

export function sourceTagsFromQueryContent(content: string): string[] {
  const tags = [...String(content ?? '').matchAll(/\(tags\s+#?([^\s)]+)\)/gi)]
    .map((match) => safeTag(String(match[1] ?? '').replace(/^"|"$/g, '')))
    .filter(Boolean);
  return [...new Set(tags)];
}

function includesCurrentPageFilterProps(view: ViewDefinition): string[] {
  const props: string[] = [];
  for (const filter of view.filters ?? []) {
    if (String(filter.operator ?? '') !== 'includesCurrentPage') continue;
    if (filter.property) props.push(String(filter.property));
    for (const prop of filter.propertyAny ?? []) props.push(String(prop));
  }
  return props;
}

function mergeViewFilters(existing: ViewDefinition, incoming: ViewDefinition): ViewDefinition {
  const mergedProps = [...new Set([...includesCurrentPageFilterProps(existing), ...includesCurrentPageFilterProps(incoming)])];
  if (!mergedProps.length) return existing;
  const otherFilters = (existing.filters ?? []).filter((filter) => String(filter.operator ?? '') !== 'includesCurrentPage');
  return {
    ...existing,
    filters: [
      ...otherFilters,
      mergedProps.length === 1
        ? { property: mergedProps[0], operator: 'includesCurrentPage' }
        : { propertyAny: mergedProps, operator: 'includesCurrentPage' },
    ],
  };
}

function splitSourceTagView(view: ViewDefinition): ViewDefinition[] {
  const tags = (view.sourceTags ?? []).map(String).filter(Boolean);
  if (tags.length <= 1) return [view];
  return tags.map((tag) => ({
    ...view,
    sourceTags: [tag],
  }));
}

function pushViews(out: ViewDefinition[], views: ViewDefinition[]): void {
  for (const view of views) out.push(...splitSourceTagView(view));
}

function registryDashboardViews(template: RegistryTemplate): ViewDefinition[] {
  const objectType = templateNameFromRegistry(template);
  const dashboard = dashboardPageForObjectType(objectType);
  const views: ViewDefinition[] = [];
  if (!dashboard) return views;
  for (const view of registry.viewDefinitions ?? []) {
    if (view.dashboard !== dashboard) continue;
    views.push({ ...view, section: templateSectionAliases(template, view.section ?? '') });
  }
  return views;
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

function objectTag(object: RegistryObject): string {
  return safeTag(object.tag || object.name);
}

function objectPropertyNames(object: RegistryObject): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (name: string) => {
    const clean = String(name ?? '').trim();
    if (!clean || seen.has(clean)) return;
    seen.add(clean);
    out.push(clean);
  };
  for (const name of object.requiredProperties ?? []) add(name);
  for (const name of object.properties ?? []) add(name);
  for (const name of areaRelationshipPropertiesForObject(object)) add(name);
  return out;
}

function propertyTargetsObject(property: string, object: RegistryObject): boolean {
  const spec = propertySpec(property) as Record<string, unknown> | undefined;
  if (String(spec?.type ?? '').toLowerCase() !== 'node') return false;
  const targets = ((spec?.targets as unknown[] | undefined) ?? [])
    .map((target) => safeTag(String(target)))
    .filter(Boolean);
  return targets.includes(objectTag(object));
}

function relatedFilterPropertiesForSourceObject(
  current: RegistryObject,
  source: RegistryObject,
  includeRelatedToFallback: boolean,
): string[] {
  const direct: string[] = [];
  let hasRelatedTo = false;
  for (const property of objectPropertyNames(source)) {
    if (property === 'related-to') {
      hasRelatedTo = true;
      continue;
    }
    if (propertyTargetsObject(property, current)) direct.push(property);
  }
  if (includeRelatedToFallback || hasRelatedTo) direct.push('related-to');
  return [...new Set(direct)];
}

function objectCanSelfRelate(object: RegistryObject): boolean {
  return objectPropertyNames(object).some((property) => property === 'related-to' || propertyTargetsObject(property, object));
}

function isRegistryEntity(object: RegistryObject | undefined): object is RegistryObject {
  if (!object) return false;
  return (registry.entityTypes ?? []).some((candidate) => safeTag(candidate.tag) === safeTag(object.tag));
}

function genericEntityObjects(): RegistryObject[] {
  return (registry.entityTypes ?? []).filter(
    (object) => normalizeAreaRef(object.area) === 'Area/Cross-Cutting',
  );
}

function contextualEntityTemplateViews(template: RegistryTemplate): ViewDefinition[] {
  const current = objectByName(templateNameFromRegistry(template));
  if (!isRegistryEntity(current)) return [];

  const views: ViewDefinition[] = [];
  const seenSources = new Set<string>();
  const addSource = (source: RegistryObject, relationRole: 'parent-child-sibling' | 'generic' | 'form') => {
    if (safeTag(source.tag) === safeTag(current.tag) && !objectCanSelfRelate(source)) return;
    const sourceKey = safeTag(source.tag || source.name);
    if (!sourceKey || seenSources.has(sourceKey)) return;
    seenSources.add(sourceKey);
    const section = String(source.dashboardSection ?? source.name ?? sourceKey).trim();
    const filters = relatedFilterPropertiesForSourceObject(current, source, true);
    if (!section || !filters.length) return;
    views.push({
      ...makeView(current.name, section, source.name || sourceKey, filters),
      queryIntent: `${relationRole} ${source.name || sourceKey} pages related to current ${current.name}`,
    });
  };

  const area = normalizeAreaRef(current.area);
  for (const source of registry.entityTypes ?? []) {
    if (normalizeAreaRef(source.area) !== area) continue;
    addSource(source, 'parent-child-sibling');
  }
  for (const source of genericEntityObjects()) addSource(source, 'generic');
  for (const source of registry.formTypes ?? []) addSource(source, 'form');
  return views;
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

  for (const rel of allRelationships()) {
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
  const views: ViewDefinition[] = [];

  pushViews(views, contextualEntityTemplateViews(template));
  pushViews(views, registryDashboardViews(template));
  pushViews(views, autoRelationshipTemplateViews(template));
  for (const extra of supplementalTemplateViews(template)) {
    const section = String(extra.section ?? '').trim();
    if (section) pushViews(views, [{ ...extra, section }]);
  }

  const deduped: ViewDefinition[] = [];
  const seenKeys = new Set<string>();
  const seenSectionSources = new Map<string, number>();
  const seenTitles = new Map<string, number>();
  for (const view of views) {
    const section = String(view.section ?? '').trim();
    if (!section) continue;
    const normalized = { ...view, section };
    const key = viewKey(normalized);
    const sectionSourceKey = viewSectionSourceKey(normalized);
    const titleKey = viewTitleKey(normalized);
    const semanticDuplicateIndex = deduped.findIndex((existing) => sameSourceTags(existing, normalized));
    const duplicateIndex = seenTitles.get(titleKey) ?? seenSectionSources.get(sectionSourceKey) ?? semanticDuplicateIndex;
    if (duplicateIndex >= 0) {
      deduped[duplicateIndex] = mergeViewFilters(deduped[duplicateIndex], normalized);
      seenKeys.add(key);
      continue;
    }
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    seenSectionSources.set(sectionSourceKey, deduped.length);
    seenTitles.set(titleKey, deduped.length);
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
  for (const rel of allRelationships()) {
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
