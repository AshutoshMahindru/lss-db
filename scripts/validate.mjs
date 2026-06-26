import fs from 'fs';

const registry = JSON.parse(fs.readFileSync('src/registry/data.json', 'utf8'));
const navigationSource = fs.readFileSync('src/modules/navigation.ts', 'utf8');
const setupSource = fs.readFileSync('src/modules/setup.ts', 'utf8');
const createSource = fs.readFileSync('src/modules/create.ts', 'utf8');
const auditSource = fs.readFileSync('src/modules/audit.ts', 'utf8');
const repairSource = fs.readFileSync('src/modules/repair.ts', 'utf8');
const repairNativePropertiesSource = fs.readFileSync('src/modules/repair-native-properties.ts', 'utf8');
const repairUserPropertiesSource = fs.readFileSync('src/modules/repair-user-properties.ts', 'utf8');
const repairTemplateSource = fs.readFileSync('src/modules/repair-template.ts', 'utf8');
const templatesSource = fs.readFileSync('src/modules/templates.ts', 'utf8');
const contractsSource = fs.readFileSync('src/modules/contracts.ts', 'utf8');
const repairDashboardSource = fs.readFileSync('src/modules/repair-dashboard.ts', 'utf8');
const queriesSource = fs.readFileSync('src/modules/queries.ts', 'utf8');
const advancedQueryBlocksSource = fs.readFileSync('src/modules/advanced-query-blocks.ts', 'utf8');
const publicHostQuerySetupSource = fs.readFileSync('public/lss-host-query-setup.js', 'utf8');
const queryBuildersSource = fs.readFileSync('src/modules/query-builders.ts', 'utf8');
const queryEdnSource = fs.readFileSync('src/modules/query-edn.ts', 'utf8');
const queryProbesSource = fs.readFileSync('src/modules/query-probes.ts', 'utf8');
const dashboardQueryRepairSource = fs.readFileSync('src/modules/dashboard-query-repair.ts', 'utf8');
const dashboardQueryViewsSource = fs.readFileSync('src/modules/dashboard-query-views.ts', 'utf8');
const diagnoseSource = fs.readFileSync('src/modules/diagnose.ts', 'utf8');
const diagnoseJournalSource = fs.readFileSync('src/modules/diagnose-journal.ts', 'utf8');
const diagnoseNativeTagsSource = fs.readFileSync('src/modules/diagnose-native-tags.ts', 'utf8');
const diagnoseQueryProbesSource = fs.readFileSync('src/modules/diagnose-query-probes.ts', 'utf8');
const nativeTagCleanupSource = fs.readFileSync('src/modules/native-tag-cleanup.ts', 'utf8');
const autoRepairSource = fs.readFileSync('src/modules/auto-repair.ts', 'utf8');
const registerSource = fs.readFileSync('src/commands/register.ts', 'utf8');
const registryCreateSource = fs.readFileSync('src/commands/registry-create.ts', 'utf8');
const dbPropertiesSource = fs.readFileSync('src/core/db-properties.ts', 'utf8');
const registryIndexSource = fs.readFileSync('src/registry/index.ts', 'utf8');
const setupStep10Source = setupSource.slice(
  setupSource.indexOf('export async function step10db'),
  setupSource.indexOf('function propertyValueToRestoreString'),
);

function fail(message) {
  throw new Error(message);
}

function requireArray(name) {
  const value = registry[name];
  if (!Array.isArray(value) || value.length === 0) fail(`registry.${name} missing or empty`);
  return value;
}

function requireIncludes(label, actual, expected) {
  const set = new Set(actual);
  const missing = expected.filter((item) => !set.has(item));
  if (missing.length) fail(`${label} missing: ${missing.join(', ')}`);
}

const areas = requireArray('areas');
const entityTypes = requireArray('entityTypes');
const formTypes = requireArray('formTypes');
const wordExtenderTypes = requireArray('wordExtenderTypes');
requireArray('relationshipRegistry');
const propertyRegistry = requireArray('propertyRegistry');
requireArray('templates');
requireArray('viewDefinitions');

const functionTemplate = (registry.templates ?? []).find((template) => template.name === 'Template/Function');
if (
  !functionTemplate ||
  !String(functionTemplate.body ?? '').includes('Related venture') ||
  !(functionTemplate.requiredSections ?? []).includes('Related venture')
) {
  fail('Template/Function must include Related venture as a required materialized section');
}

requireIncludes('rootPages', registry.rootPages ?? [], [
  'Home',
  'Pages',
  'Templates',
  'Word Extenders',
  'Areas',
  'Entity-Pages',
  'Forms',
  'Relationships',
  'Dashboards',
  'LSS Schema',
  'LSS Audit',
  'LSS Migrations',
  'LSS Plugin',
]);

requireIncludes(
  'baseTags',
  (registry.baseTags ?? []).map((tag) => tag.tag ?? tag.name),
  [
    'EntityObject',
    'FormObject',
    'WorkObject',
    'HealthObject',
    'LearningObject',
    'WealthObject',
    'PursuitObject',
    'WordExtender',
    'RelationshipType',
    'DashboardType',
  ],
);

requireIncludes(
  'contextual baseTags',
  (registry.baseTags ?? []).map((tag) => tag.tag ?? tag.name),
  [
    'family-relation/parent',
    'family-relation/child',
    'family-relation/sibling',
    'family-relation/partner',
    'family-relation/extended-family',
    'family-relation/household',
    'closeness/inner-circle',
    'closeness/close',
    'closeness/regular',
    'closeness/acquaintance',
    'closeness/dormant',
    'org-role/founder',
    'org-role/owner',
    'org-role/employee',
    'org-role/contractor',
    'org-role/advisor',
    'org-role/investor',
    'org-role/customer',
    'org-role/vendor',
    'org-role/regulator',
    'org-role/partner',
    'confidential/public',
    'confidential/internal',
    'confidential/private',
    'confidential/financial',
    'confidential/legal',
    'confidential/medical',
  ],
);

const allObjects = [...entityTypes, ...formTypes, ...wordExtenderTypes];
const objectNames = new Set(allObjects.map((object) => object.name));
const objectTags = new Set(allObjects.map((object) => object.tag));
const systemTargets = new Set(['Area', 'Template', 'Query', 'Task']);
const propertyByName = new Map(propertyRegistry.map((property) => [property.name ?? property.property ?? property.key, property]));
requireIncludes(
  'white-paper canonical relationship properties',
  [...propertyByName.keys()],
  [
    'project',
    'participants',
    'topics',
    'decisions',
    'actions',
    'outputs',
    'assigned-to',
    'stakeholders',
    'blocks',
    'related-to',
  ],
);
requireIncludes(
  'white-paper scalar properties',
  [...propertyByName.keys()],
  ['due-date', 'asked-by', 'decided-by', 'answer', 'rationale', 'relationship-status'],
);
for (const object of allObjects) {
  for (const field of ['name', 'tag', 'schemaPage', 'nodeKind', 'requiredProperties', 'properties']) {
    if (object[field] == null || (Array.isArray(object[field]) && object[field].length === 0)) {
      fail(`${object.name ?? '<unnamed>'} missing ${field}`);
    }
  }
  if (!String(object.tag).trim()) fail(`${object.name} has blank tag`);
  for (const property of [...(object.requiredProperties ?? []), ...(object.properties ?? [])]) {
    if (!propertyByName.has(property)) fail(`${object.name} references unknown property ${property}`);
  }
}
const primaryBeforeRelatedToProperties = new Set(['status', 'Status', 'area', 'areas', 'date']);
function relationshipBeforeRelatedTo(property) {
  if (String(property).startsWith('related-')) return true;
  if (property === 'owner' || property === 'area' || property === 'areas') return false;
  const spec = propertyByName.get(property);
  return String(spec?.type ?? '').toLowerCase() === 'node';
}
function canonicalObjectPropertyOrder(object) {
  const seen = new Set();
  const primary = [];
  const related = [];
  const trailing = [];
  let deferredRelatedTo = '';
  const add = (property) => {
    if (!property || seen.has(property)) return;
    seen.add(property);
    if (property === 'related-to') {
      deferredRelatedTo = property;
    } else if (primaryBeforeRelatedToProperties.has(property)) {
      primary.push(property);
    } else if (relationshipBeforeRelatedTo(property)) {
      related.push(property);
    } else {
      trailing.push(property);
    }
  };
  for (const property of object.requiredProperties ?? []) add(property);
  for (const property of object.properties ?? []) add(property);
  if (deferredRelatedTo) related.push(deferredRelatedTo);
  return [...primary, ...related, ...trailing];
}
for (const object of allObjects) {
  const props = canonicalObjectPropertyOrder(object);
  const relatedToIndex = props.indexOf('related-to');
  if (relatedToIndex < 0) continue;
  for (const property of props.slice(0, relatedToIndex)) {
    if (!primaryBeforeRelatedToProperties.has(property) && !relationshipBeforeRelatedTo(property)) {
      fail(`${object.name} places ${property} before related-to`);
    }
  }
  for (const property of props.slice(relatedToIndex + 1)) {
    if (relationshipBeforeRelatedTo(property)) fail(`${object.name} places relationship field ${property} after related-to`);
  }
}
const interaction = allObjects.find((object) => object.name === 'Interaction');
requireIncludes('Interaction canonical properties', interaction?.properties ?? [], [
  'participants',
  'project',
  'related-to',
  'topics',
  'outputs',
  'actions',
  'decisions',
]);
const actionItem = allObjects.find((object) => object.name === 'ActionItem');
requireIncludes('ActionItem canonical properties', actionItem?.properties ?? [], [
  'project',
  'assigned-to',
  'due-date',
  'related-to',
]);
const relationshipNames = (registry.relationshipRegistry ?? []).map((relationship) => relationship.property);
requireIncludes('white-paper relationship registry', relationshipNames, [
  'project',
  'participants',
  'topics',
  'decisions',
  'actions',
  'outputs',
  'assigned-to',
  'stakeholders',
  'blocks',
  'related-to',
]);
for (const property of propertyRegistry) {
  const name = property.name ?? property.property ?? property.key;
  for (const target of property.targets ?? []) {
    if (!objectNames.has(target) && !systemTargets.has(target)) fail(`property ${name} has unknown target ${target}`);
  }
}
for (const relationship of registry.relationshipRegistry ?? []) {
  const property = relationship.property;
  if (!propertyByName.has(property)) fail(`relationship ${property} has no property registry spec`);
  for (const target of relationship.targets ?? []) {
    if (!objectNames.has(target) && !systemTargets.has(target)) {
      fail(`relationship ${property} has unknown target ${target}`);
    }
  }
}
if (
  !registryIndexSource.includes('export function areaRelationshipPropertiesForObject') ||
  !registryIndexSource.includes('export function allPropertySpecs') ||
  !registryIndexSource.includes('export function allRelationships') ||
  !registryIndexSource.includes('normalizeAreaRef(target.area)') ||
  !registryIndexSource.includes('objectHasRelationshipToTarget') ||
  !templatesSource.includes('areaRelationshipPropertiesForObject(o)') ||
  !setupSource.includes('allPropertySpecs()') ||
  !setupSource.includes('allRelationships()')
) {
  fail('registry must generate named same-area relationship fields for page materialisation and native setup');
}
if (
  !templatesSource.includes('const related: string[] = []') ||
  !templatesSource.includes('const trailing: string[] = []') ||
  !templatesSource.includes('const primaryBeforeRelatedTo = (p: string)') ||
  !templatesSource.includes('const beforeRelatedTo = (p: string)') ||
  !templatesSource.includes("if (p === 'related-to')") ||
  !templatesSource.includes('primaryBeforeRelatedTo(p)') ||
  !templatesSource.includes("p.startsWith('related-')") ||
  !templatesSource.includes("String(spec?.type ?? '').toLowerCase() === 'node'") ||
  !templatesSource.includes('if (deferredRelatedTo) related.push(deferredRelatedTo)') ||
  !templatesSource.includes('return [...primary, ...related, ...trailing]')
) {
  fail('generic related-to must be ordered after specific related fields and before trailing optional fields');
}
if (
  !contractsSource.includes("import { uniqueObjectProps } from './templates'") ||
  !contractsSource.includes('const props = uniqueObjectProps(o)') ||
  !contractsSource.includes('for (const o of objs) for (const p of uniqueObjectProps(o)) props.add(p)')
) {
  fail('schema/tag property documentation must use the same canonical property order as materialised pages');
}
if (
  !registryIndexSource.includes("if (name === 'related-to')") ||
  !registryIndexSource.includes('for (const generatedSpec of generated)') ||
  !registryIndexSource.includes("if (!byName.has('related-to'))")
) {
  fail('generated same-area properties must be created before generic related-to');
}
if (
  !setupSource.includes('resetRelatedToNativeProperty') ||
  !setupSource.includes("resetNativeNodeProperty(r, 'related-to')") ||
  !setupSource.includes('ensureRelatedToPropertyOrder') ||
  !setupSource.includes('await ensureRelatedToPropertyOrder(r);') ||
  !setupSource.includes('ensurePrimaryDisplayPropertyOrder') ||
  !setupSource.includes('PRIMARY_DISPLAY_PROPERTIES') ||
  !setupSource.includes('propertiesBeforePrimaryDisplayFields') ||
  !setupSource.includes('ensureRelatedToBeforeTrailingAdminProperties') ||
  !setupSource.includes('displayPropertyBeforeRelatedTo') ||
  !setupSource.includes('relatedToTrailingDisplayPropertySpecs') ||
  !setupSource.includes('afterPrimaryDisplayPropertySpecs') ||
  !setupSource.includes('const relatedToIndex = props.indexOf') ||
  !setupSource.includes("trailing.add('lss-object-type')") ||
  !setupSource.includes('const isDate = String(spec.type ??') ||
  !setupSource.includes('resolvePageFromIdentity(raw)') ||
  !setupSource.includes("^\\d+(?:\\s*,\\s*\\d+)*$") ||
  !setupSource.includes('nativePropertyOrder') ||
  !setupSource.includes('clearCapturedPropertyValues') ||
  !setupSource.includes('capturePropertyValuesForNativeProperty') ||
  !setupSource.includes('repairNativeNodePropertySchemaInPlace') ||
  !setupSource.includes('repairStaleNativeNodePropertySchemas') ||
  !setupSource.includes('waitForPropertyValuesCleared') ||
  !setupSource.includes('Logseq would reject the type change') ||
  !setupSource.includes('(not [?entity :db/ident ?entityIdent])') ||
  !setupSource.includes('schema repair changed property order') ||
  !setupSource.includes("clean.startsWith('related-')") ||
  !setupSource.includes("displayPropertyBeforeRelatedTo(name, spec)") ||
  !setupSource.includes('repairRelatedToDisplayOrder') ||
  !repairSource.includes('ensureRelatedToPropertyOrder(result)') ||
  !repairSource.includes('ensureRelatedToBeforeTrailingAdminProperties(result)') ||
  !registerSource.includes('lss: 55reset-related-to-property-order') ||
  !navigationSource.includes('lss: 55reset-related-to-property-order') ||
  !registerSource.includes('lss: 57repair-related-to-display-order') ||
  !navigationSource.includes('lss: 57repair-related-to-display-order')
) {
  fail('existing graphs need a plugin-side related-to property order reset command');
}
if (
  setupStep10Source.includes('resetRelatedToNativeProperty') ||
  setupStep10Source.includes('resetNativePropertyDefinition') ||
  repairSource.includes('resetRelatedToNativeProperty') ||
  repairSource.includes('resetNativePropertyDefinition') ||
  setupSource.includes("trailingBeforeRelatedTo.includes('owner')")
) {
  fail('setup/materialise must not reorder existing graph properties by resetting native property definitions');
}
for (const view of registry.viewDefinitions ?? []) {
  for (const tag of view.sourceTags ?? []) {
    if (!objectNames.has(tag) && !objectTags.has(tag)) fail(`view ${view.id} has unknown source tag ${tag}`);
  }
  for (const filter of view.filters ?? []) {
    for (const property of [...(filter.property ? [filter.property] : []), ...(filter.propertyAny ?? [])]) {
      if (!propertyByName.has(property)) fail(`view ${view.id} filters unknown property ${property}`);
    }
  }
}

if ((registry.decisions ?? {}).wealthAssetTag !== 'FinancialAsset') {
  fail('wealth asset decision must use FinancialAsset');
}
if ((registry.decisions ?? {}).nativeTaskMode !== true) {
  fail('native task mode decision must be explicit and true');
}
if (!registryIndexSource.includes('canCreateNativeDbTag') || !registryIndexSource.includes("!clean.includes('/')")) {
  fail('native DB tag setup must skip slash-context tags because Logseq createTag rejects forward slash titles');
}
if (
  !dbPropertiesSource.includes('shouldRefreshExistingPropertySchema') ||
  !dbPropertiesSource.includes("type === 'node'") ||
  !setupSource.includes('nativePropertyResetReasonForSpec') ||
  !setupSource.includes('await ensureNativeProperty(p, { refreshExistingSchema: false })') ||
  !setupSource.includes('staleNativeNodeProperties') ||
  setupSource.includes('await resetNativeNodeProperty(r, propertyName)') ||
  !setupSource.includes('setup left it unchanged') ||
  !setupSource.includes('resetNativeNodeProperty') ||
  !setupSource.includes('resetVentureNativeProperty')
) {
  fail('setup must detect stale native node property schemas but leave destructive resets to explicit commands');
}
if (
  !setupSource.includes('resetStaleNativeNodeProperties') ||
  !setupSource.includes('Resetting stale native node property schema(s)') ||
  !setupSource.includes('Repairing stale native node property schema(s) in place') ||
  !registerSource.includes('lss: 56reset-stale-node-properties') ||
  !navigationSource.includes('lss: 56reset-stale-node-properties')
) {
  fail('stale native node properties need an explicit reset command');
}
if (
  !dbPropertiesSource.includes('resolveJournalDatePropertyValue') ||
  !dbPropertiesSource.includes(':block/journal-day') ||
  !dbPropertiesSource.includes('journal page entity id') ||
  dbPropertiesSource.includes('YYYYMMDD integer')
) {
  fail('DB date properties must resolve to journal page entity ids, not raw YYYYMMDD numbers');
}
if (
  !autoRepairSource.includes('default: true') ||
  !autoRepairSource.includes("!== false") ||
  !autoRepairSource.includes('scheduleCurrentPageAutoRepair') ||
  !registerSource.includes('scheduleCurrentPageAutoRepair') ||
  !registerSource.includes('15000')
) {
  fail('auto-repair must be enabled by default and retry on the current page after plugin load');
}
if (
  !registerSource.includes("register('lss: materialise page', repairCurrentPage)") ||
  registerSource.includes("registerPalette('lss-materialise-page', 'LSS: Materialise Page', repairCurrentPage)")
) {
  fail('materialise page must have exactly one slash command and no duplicate command-palette registration');
}
for (const forbidden of [
  'lss: materialize page',
  'LSS: Materialize Page',
  'lss-materialize-page',
  'lss: 50repair-current-page',
  'LSS: Repair Current Page',
]) {
  if (registerSource.includes(forbidden)) fail(`duplicate/stale materialise command registration remains: ${forbidden}`);
}
if (
  !repairSource.includes('preserveEmpty') ||
  !repairSource.includes('Empty many-valued node property') ||
  !repairSource.includes('requiredProps.has')
) {
  fail('repair must handle empty required node properties without writing Logseq-invalid empty arrays');
}
if (
  !templatesSource.includes('placeholderNodePropertyValue') ||
  !templatesSource.includes('pageForCanonical(`LSS Placeholder/${target || prop}`)') ||
  !templatesSource.includes('pageForCanonical(area)') ||
  !repairSource.includes('ensurePlaceholderPagesForNodeValue') ||
  !repairUserPropertiesSource.includes('Template Placeholder')
) {
  fail('repair must materialize unresolved node properties with canonical controlled placeholder page refs');
}
if (
  !templatesSource.includes('return placeholderNodePropertyValue(p, spec as { targets?: unknown[] } | undefined);') ||
  !templatesSource.includes('ensurePlaceholderPagesForNodeValue(result, prop.key, prop.value)') ||
  !repairUserPropertiesSource.includes('export async function ensurePlaceholderPagesForNodeValue') ||
  !repairUserPropertiesSource.includes('ADD placeholder target tag') ||
  !repairUserPropertiesSource.includes('pageHasClassTag(pageIdentity, target)') ||
  !repairSource.includes('ensurePlaceholderPagesForNodeValue(result, shortKey, value)')
) {
  fail('node placeholders must remain visible selector values and target-tagged for typed fields');
}
if (
  repairUserPropertiesSource.includes('export async function cleanNodePropertyUpsertValue') ||
  repairSource.includes('nonPlaceholderNodeValues(currentValue)') ||
  repairSource.includes('REMOVE placeholder node value(s)') ||
  repairSource.includes('cleanedNodePlaceholder')
) {
  fail('materialise must leave placeholder removal to the selector UI');
}
if (
  !advancedQueryBlocksSource.includes('upsertBlockPropertyViaHost') ||
  !repairSource.includes('upsertBlockPropertyViaHost') ||
  !repairSource.includes('isDeferredPropertyUpsertError') ||
  !repairSource.includes('Used host API fallback for page property') ||
  !repairSource.includes('Used host API for DB node page property') ||
  !repairSource.includes('await upsertPagePropertyReliable(result, pageBlockId, shortKey, upsertValue, opts)')
) {
  fail('repair must retry DB node property writes through the host API when plugin iframe upsert times out');
}
if (
  !queryBuildersSource.includes('placeholderExclusionExpr') ||
  !queryBuildersSource.includes('Template Placeholder')
) {
  fail('dashboard queries must exclude controlled placeholder pages from class-tag results');
}
if (
  !queryBuildersSource.includes('queryTitleForView') ||
  !queryBuildersSource.includes(':title ${ednString(queryTitleForView(view))} :query') ||
  !templatesSource.includes('queryTitleForView(view)') ||
  !repairDashboardSource.includes('queryTitleForView(view)')
) {
  fail('dashboard/template advanced query EDN must carry titles from the shared query title helper');
}
if (
  !advancedQueryBlocksSource.includes('rawQueryParentContent(parent)') ||
  !publicHostQuerySetupSource.includes('rawQueryParentContent(parent)') ||
  /\n\s*await updateBlockTitle\(parentRef, ''\);/.test(advancedQueryBlocksSource) ||
  /\n\s*await updateBlockTitle\(parentRef, ''\);/.test(publicHostQuerySetupSource)
) {
  fail('DB advanced query adapter must not unconditionally clear visible query parent titles');
}
if (
  !repairSource.includes('ensureMaterialiseNativeProperties') ||
  !repairNativePropertiesSource.includes('nativeEnsureCache') ||
  repairNativePropertiesSource.includes('resetNativeNodeProperty') ||
  !repairNativePropertiesSource.includes('Materialise left native')
) {
  fail('materialise must cache native property setup checks without destructive stale-schema resets');
}
if (
  !repairDashboardSource.includes('isPlaceholderPageRef') ||
  !repairDashboardSource.includes('SKIP linked parent repair for placeholder')
) {
  fail('linked parent dashboard repair must skip controlled placeholder refs');
}
if (
  !repairSource.includes('const changed = await repairUpsertPageProperty') ||
  !repairSource.includes('if (changed && isDateProperty(prop))') ||
  !repairSource.includes('await sleep(20)') ||
  !repairSource.includes('await sleep(25)')
) {
  fail('materialise no-op runs must not pay full date/template stabilization waits');
}
if (allObjects.some((object) => object.tag === 'Asset' || object.name === 'Asset')) {
  fail('registry must not define LSS #Asset; use #FinancialAsset');
}

const financialAsset = entityTypes.find((object) => object.name === 'FinancialAsset');
if (financialAsset?.displayName !== 'Asset' || !(financialAsset.aliases ?? []).includes('Asset')) {
  fail('FinancialAsset must expose Asset as display alias without changing canonical name');
}
const workStreamUpdate = formTypes.find((object) => object.name === 'WorkStreamUpdate');
if (workStreamUpdate?.displayName !== 'Work-Stream' || !(workStreamUpdate.aliases ?? []).includes('Work-Stream')) {
  fail('WorkStreamUpdate must expose Form/Work-Stream display alias');
}
const familyRelation = (registry.propertyRegistry ?? []).find((prop) => prop.name === 'family-relation');
if (familyRelation?.type !== 'choice' || !(familyRelation.choices ?? []).includes('parent')) {
  fail('family-relation must be a choice property matching contextual tags');
}
const closeness = (registry.propertyRegistry ?? []).find((prop) => prop.name === 'closeness');
if (closeness?.type !== 'choice' || !(closeness.choices ?? []).includes('inner-circle')) {
  fail('closeness must be a choice property matching contextual tags');
}
for (const required of [
  'LSS Area Model',
  'Area/Health',
  'FinancialAsset',
  'WorkStreamUpdate',
  'family-relation/*',
  'closeness/*',
  'org-role/*',
  'confidential/*',
  'Word Extenders:',
]) {
  if (!navigationSource.includes(required)) fail(`navigation area model missing: ${required}`);
}
if (/\.addTagProperty\s*\(/.test(setupSource)) {
  fail('setup must not add LSS entity schema properties to native tags');
}
const commandLabels = [...navigationSource.matchAll(/label:\s*'([^']+)'/g)].map((match) => match[1]);
if (commandLabels.length < 52) fail(`expected at least 52 command help labels, found ${commandLabels.length}`);
for (const label of commandLabels) {
  if (!registerSource.includes(label)) fail(`command help label is not registered: ${label}`);
}
for (const required of [
  'registry.entityTypes',
  'registry.formTypes',
  'registry.wordExtenderTypes',
  'lss: new-${commandSlug(label)}',
  'lss: insert-${commandSlug(label)}',
]) {
  if (!registryCreateSource.includes(required)) fail(`registry creation command coverage missing: ${required}`);
}
for (const required of [
  'registerRegistryCreationCommands()',
  'registryCreationCommands()',
  'newRegistryPage(command.objectName)',
  'insertRegistryFormBlock(command.objectName)',
]) {
  if (!registerSource.includes(required)) fail(`registry creation command registration missing: ${required}`);
}
for (const required of [
  'registryCommandHelp',
  'allCommandHelp()',
  'registryCreationCommands()',
]) {
  if (!navigationSource.includes(required)) fail(`registry creation command help missing: ${required}`);
}
for (const required of ['newRegistryPage', 'insertRegistryFormBlock']) {
  if (!createSource.includes(required)) fail(`registry creation handler missing: ${required}`);
}
if (!createSource.includes('o.defaultValues') || !repairSource.includes('defaultPropertyValue(key, obj)')) {
  fail('creation/repair must source object defaults from RegistryObject.defaultValues');
}
if (/catch\s*\{\s*\}/.test(createSource) || /\.catch\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/.test(createSource)) {
  fail('create module must report creation failures instead of swallowing empty catches');
}
for (const forbidden of [
  'isPropertiesListBlock',
  'Added schema prop lines',
  'REFRESHED schema prop list',
  'visibility list',
]) {
  if (repairSource.includes(forbidden)) fail(`repair must not maintain visible schema property mirrors: ${forbidden}`);
}
if (!repairSource.includes('not as visible schema property mirror blocks')) {
  fail('repair must document page-property-only schema materialization');
}
if (repairSource.trim().split(/\r?\n/).length > 1500) {
  fail('repair.ts must stay below the monolith threshold; move focused workflows into repair-* modules');
}
for (const forbidden of [
  'const views = viewDefinitionsSafe(template)',
  'Dashboard query dedupe:',
  'REBUILT advanced query from scratch',
]) {
  if (repairSource.includes(forbidden)) fail(`repair.ts must delegate dashboard repair workflow: ${forbidden}`);
}
for (const required of [
  'repairDashboardQueries',
  'repairLinkedParentDashboards',
  'forceCreateQueryChild',
  'Dashboard query dedupe:',
  'REBUILT advanced query from scratch',
]) {
  if (!repairDashboardSource.includes(required)) fail(`repair-dashboard module missing responsibility: ${required}`);
}
for (const required of [
  'materializeTemplateSections',
  'templateSectionNames',
  'appendBlockInPage',
  'pageRootBlockId',
  'insertBlock(pageRootBlockId',
]) {
  if (!repairTemplateSource.includes(required)) fail(`repair-template module missing responsibility: ${required}`);
}
if (!repairSource.includes('materializeTemplateSections')) {
  fail('materialise page must insert missing registry template sections before dashboard query repair');
}
const currentReadMatch = repairSource.match(/async function readCurrentBlockProperty[\s\S]*?async function dbPropertyValueToRepairString/);
if (!currentReadMatch || currentReadMatch[0].includes('isPluginOwnedRegistryPropertyKey(key) continue')) {
  fail('current page property reads must include plugin-owned registry properties so existing DB page properties are recognized');
}
const pagePropertyMapMatch = repairSource.match(/async function readDbPagePropertyMap[\s\S]*?async function readDbPageTags/);
if (!pagePropertyMapMatch || pagePropertyMapMatch[0].includes('isPluginOwnedRegistryPropertyKey(key)')) {
  fail('materialise page property collection must include plugin-owned registry properties so auto-sync preserves DB picker selections');
}
if (!repairUserPropertiesSource.includes('isForeignPluginRegistryPropertyKey') || !repairSource.includes('isForeignPluginRegistryPropertyKey(key)')) {
  fail('repair must ignore stale foreign plugin.property namespaces such as _test_plugin when reading LSS page properties');
}
if (!repairSource.includes('cleanForeignPluginPropertyCopies') || !repairUserPropertiesSource.includes('REMOVED ${keys.size} stale foreign plugin page')) {
  fail('materialise page must clean stale foreign plugin.property namespaces for managed LSS properties');
}
if (
  !repairUserPropertiesSource.includes('readDatascriptForeignPluginPropertyKeys') ||
  !repairUserPropertiesSource.includes('[:find ?attr') ||
  repairUserPropertiesSource.includes('[?a :db/ident ?ident]')
) {
  fail('foreign plugin page property cleanup must inspect direct Datascript attrs, not only Logseq short-key property maps');
}
if (
  !repairSource.includes('await readDatascriptUserPropertyValue(pageBlockId, shortKey)') ||
  !repairSource.includes('const nextJournalDay = toJournalDay(value)') ||
  !repairSource.includes('isValidDatePropertyValue(ownedCurrentValue) && nextJournalDay != null')
) {
  fail('date property upsert skip must compare owned canonical date values against the requested journal day');
}
if (repairSource.includes('upsertPagePropertyReliable(result, pageBlockId, shortKey, [],')) {
  fail('repair must not write empty arrays for many-valued node properties; Logseq rejects empty array writes');
}
if (!repairUserPropertiesSource.includes('safePluginPropertyAttr') || !repairUserPropertiesSource.includes(':plugin.property.${PLUGIN_ID}/${key}')) {
  fail('Datascript property reads must check plugin-owned LSS property idents as well as user.property idents');
}
if (diagnoseSource.trim().split(/\r?\n/).length > 750) {
  fail('diagnose.ts must stay focused on report assembly; move probe engines into diagnose-* modules');
}
for (const forbidden of [
  'function flattenQueryHits',
  'function findHitIdentity',
  'function runQueryEngineCandidates',
  'async function runLiveQueryProbe',
]) {
  if (diagnoseSource.includes(forbidden)) fail(`diagnose.ts must delegate live query probes: ${forbidden}`);
}
for (const required of [
  'runLiveQueryProbe',
  'summarizeDatascriptEntity',
  'flattenQueryHits',
  'runQueryEngineCandidates',
  'datascriptVentureProbeReport',
]) {
  if (!diagnoseQueryProbesSource.includes(required)) fail(`diagnose-query-probes module missing responsibility: ${required}`);
}
for (const required of [
  'diagnoseJournalMaterialization',
  'lss-managed:journal-materialized-',
  'pending materialization',
  'journal-page:: yes',
]) {
  if (!diagnoseJournalSource.includes(required)) fail(`diagnose-journal module missing materialization diagnostic: ${required}`);
}
if (!diagnoseSource.includes('diagnoseJournalMaterialization')) {
  fail('diagnose current-page report must include journal materialization diagnostics');
}
for (const required of [
  'diagnoseNativeTagSchemaProperties',
  'native-tag-schema-pollution',
  'lss: 11setup-db-native-config',
  'collectSchemaContainersFromRecord',
]) {
  if (!diagnoseNativeTagsSource.includes(required)) fail(`diagnose-native-tags module missing schema diagnostic: ${required}`);
}
if (!diagnoseSource.includes('diagnoseNativeTagSchemaProperties')) {
  fail('diagnose current-page report must include native tag schema diagnostics');
}
for (const required of [
  'cleanNativeTagSchemaProperties',
  'readNativeTagSchemaFindings',
  'removeTagProperty',
  'CLEAN native tag schema properties',
  'VERIFY native tag schema cleanup',
]) {
  if (!nativeTagCleanupSource.includes(required)) fail(`native tag cleanup command missing responsibility: ${required}`);
}
for (const required of [
  'cleanNativeTagSchemaProperties',
  'lss: 54clean-native-tag-schema-properties',
  'LSS: Clean Native Tag Schema Properties',
]) {
  if (!registerSource.includes(required)) fail(`native tag cleanup command registration missing: ${required}`);
}
if (!navigationSource.includes('lss: 54clean-native-tag-schema-properties')) {
  fail('native tag cleanup command missing from command help');
}
for (const forbidden of [
  'ensureHostScope',
  '__lssConfigureDbAdvancedQuery',
  'INLINE_HOST_QUERY_SETUP',
  'INLINE_HOST_KEYWORD_HELPER',
  'upsertKeywordBlockPropertyHost',
  'window.top',
  'HostFunction',
]) {
  for (const [name, source] of [
    ['queries.ts', queriesSource],
    ['query-builders.ts', queryBuildersSource],
    ['query-edn.ts', queryEdnSource],
    ['query-probes.ts', queryProbesSource],
    ['dashboard-query-repair.ts', dashboardQueryRepairSource],
    ['dashboard-query-views.ts', dashboardQueryViewsSource],
    ['repair-dashboard.ts', repairDashboardSource],
    ['diagnose-journal.ts', diagnoseJournalSource],
    ['diagnose-native-tags.ts', diagnoseNativeTagsSource],
    ['diagnose-query-probes.ts', diagnoseQueryProbesSource],
    ['native-tag-cleanup.ts', nativeTagCleanupSource],
  ]) {
    if (source.includes(forbidden)) {
      fail(`${name} must use advanced-query-blocks adapter instead of host internals: ${forbidden}`);
    }
  }
}
for (const required of [
  'HostQueryRepairCapability',
  'hostQueryRepairScriptsReady',
  'configureDbAdvancedQueryBlock',
  'inspectDbQueryBlockStructure',
  'dbAdvancedQueryBlockNeedsStructureRepair',
  'window.__lssConfigureDbAdvancedQuery',
  'upsertKeywordBlockPropertyHost',
  'readAnyProperty(props, \'query\', QUERY_PROPERTY_KEY)',
  'readBlockDatascriptProperty(parentId, QUERY_PROPERTY_KEY)',
]) {
  if (!advancedQueryBlocksSource.includes(required)) {
    fail(`advanced query adapter missing expected responsibility: ${required}`);
  }
}
for (const required of [
  "from './advanced-query-blocks'",
  'configureDbAdvancedQueryBlock',
  'dbAdvancedQueryBlockNeedsStructureRepair',
  'inspectDbQueryBlockStructure',
  'QUERY_PROPERTY_KEY',
]) {
  if (!queriesSource.includes(required)) fail(`queries.ts missing advanced query adapter boundary: ${required}`);
}
if (queriesSource.trim().split(/\r?\n/).length > 80) {
  fail('queries.ts must remain a small facade over split query modules');
}
for (const forbidden of [
  'export function simpleQueryForView',
  'type DatascriptProbeAttempt',
  'function canonicalizePropertyTokenInQuery',
  'function blockSnapshotHasQueryClassTag',
  'export function templateSectionAliases',
]) {
  if (queriesSource.includes(forbidden)) fail(`queries.ts facade contains implementation detail: ${forbidden}`);
}
for (const [label, source, required] of [
  [
    'query builder module',
    queryBuildersSource,
    [
      'simpleQueryForView',
      'dashboardQueryBlockForViewAsync',
      'advancedDashboardQueryEdnForViewAsync',
      'queryBlockContent',
    ],
  ],
  [
    'query EDN module',
    queryEdnSource,
    ['normalizeQueryBlockContent', 'queryBlockNeedsRepair', 'extractAdvancedQueryVector', 'venturePagePropertyClause'],
  ],
  [
    'query probes module',
    queryProbesSource,
    ['datascriptVentureProbeReport', 'ventureDatascriptAttempts', 'datascriptInspectBlock'],
  ],
  [
    'dashboard query repair module',
    dashboardQueryRepairSource,
    ['findAllQueryBlocksInSectionAsync', 'readDashboardQueryBlockContent', 'scoreQueryBlockCandidate'],
  ],
  [
    'dashboard query views module',
    dashboardQueryViewsSource,
    ['viewDefinitionsSafe', 'autoRelationshipTemplateViews', 'relationshipPropertyNames'],
  ],
]) {
  for (const text of required) {
    if (!source.includes(text)) fail(`${label} missing split responsibility: ${text}`);
  }
}
for (const [label, source, required] of [
  [
    'create context inheritance',
    createSource,
    ['defaultCreateOverrides', 'dashboardContextProps', 'insertFormByName', '`related-${compact}`', 'Set ${prop} from current context'],
  ],
  [
    'generic linked parent repair',
    repairSource + repairDashboardSource,
    ['dashboardPageForObjectType', 'filterProps(filter).includes(prop)', 'select or link the ${targetHint} page', 'Linked parent repair:'],
  ],
  [
    'dashboard current-page text fallback',
    queryBuildersSource,
    ['currentPageTextFallbackValues', 'queryDbCurrentPagePropertyExpr', 'safePageName(raw).toUpperCase()'],
  ],
  [
    'db-aware audit',
    auditSource,
    [
      'readPagePropertyText',
      'auditRelationshipReferences',
      'KEY_RELATIONSHIP_VALIDATION_PROPS',
      "'participants'",
      "'related-project'",
      'resolvePageFromIdentity',
      'findAllQueryBlocksInSectionAsync',
      'readNativeTagSchemaFindings',
      'Native tag schema pollution:',
      'lss: 54clean-native-tag-schema-properties',
    ],
  ],
  [
    'auto repair safe-name handling',
    autoRepairSource,
    ['Entity-Page(?:', '| - )', 'hooks registered but idle until enabled', 'canonicalPropertyKey(rawKey)', 'includeReferences'],
  ],
  [
    'setup candidate noise filtering',
    repairSource + diagnoseSource,
    ['| - |:)', 'isSetupTargetTagNoise', 'isSetupFunctionTagNoise'],
  ],
  [
    'db identity matching',
    dbPropertiesSource,
    ['entityIdentityCandidates', 'expandPageIdentityCandidates', 'for (const identity of identities)', 'targets.has(String(candidate))'],
  ],
]) {
  for (const text of required) {
    if (!source.includes(text)) fail(`${label} missing safeguard: ${text}`);
  }
}

console.log(
  'registry ok',
  `areas=${areas.length}`,
  `entities=${entityTypes.length}`,
  `forms=${formTypes.length}`,
  `word-extenders=${wordExtenderTypes.length}`,
);
