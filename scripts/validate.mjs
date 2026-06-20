import fs from 'fs';

const registry = JSON.parse(fs.readFileSync('src/registry/data.json', 'utf8'));
const navigationSource = fs.readFileSync('src/modules/navigation.ts', 'utf8');
const setupSource = fs.readFileSync('src/modules/setup.ts', 'utf8');
const createSource = fs.readFileSync('src/modules/create.ts', 'utf8');
const repairSource = fs.readFileSync('src/modules/repair.ts', 'utf8');
const queriesSource = fs.readFileSync('src/modules/queries.ts', 'utf8');
const autoRepairSource = fs.readFileSync('src/modules/auto-repair.ts', 'utf8');
const registerSource = fs.readFileSync('src/commands/register.ts', 'utf8');
const dbPropertiesSource = fs.readFileSync('src/core/db-properties.ts', 'utf8');

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
for (const [label, source, required] of [
  [
    'create context inheritance',
    createSource,
    ['defaultCreateOverrides', 'dashboardContextProps', 'insertFormByName', '`related-${compact}`', 'Set ${prop} from current context'],
  ],
  [
    'generic linked parent repair',
    repairSource,
    ['dashboardPageForObjectType', 'filterProps(filter).includes(prop)', 'select or link the ${targetHint} page', 'Linked parent repair:'],
  ],
  [
    'dashboard current-page text fallback',
    queriesSource,
    ['currentPageTextFallbackValues', 'queryDbCurrentPagePropertyExpr', 'safePageName(raw).toUpperCase()'],
  ],
  [
    'db-aware audit',
    fs.readFileSync('src/modules/audit.ts', 'utf8'),
    ['readPagePropertyText', 'findAllQueryBlocksInSectionAsync', '!/^\\d+$/.test(value.trim())'],
  ],
  [
    'auto repair safe-name handling',
    autoRepairSource,
    ['Entity-Page(?:', '| - )', 'hooks registered but idle until enabled', 'canonicalPropertyKey(rawKey)'],
  ],
  [
    'setup candidate noise filtering',
    repairSource + fs.readFileSync('src/modules/diagnose.ts', 'utf8'),
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
