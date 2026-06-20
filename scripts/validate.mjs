import fs from 'fs';

const registry = JSON.parse(fs.readFileSync('src/registry/data.json', 'utf8'));
const navigationSource = fs.readFileSync('src/modules/navigation.ts', 'utf8');
const setupSource = fs.readFileSync('src/modules/setup.ts', 'utf8');
const createSource = fs.readFileSync('src/modules/create.ts', 'utf8');
const repairSource = fs.readFileSync('src/modules/repair.ts', 'utf8');
const queriesSource = fs.readFileSync('src/modules/queries.ts', 'utf8');

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
requireArray('propertyRegistry');
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
for (const object of allObjects) {
  for (const field of ['name', 'tag', 'schemaPage', 'nodeKind', 'requiredProperties', 'properties']) {
    if (object[field] == null || (Array.isArray(object[field]) && object[field].length === 0)) {
      fail(`${object.name ?? '<unnamed>'} missing ${field}`);
    }
  }
  if (!String(object.tag).trim()) fail(`${object.name} has blank tag`);
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
for (const [label, source, required] of [
  [
    'create context inheritance',
    createSource,
    ['defaultCreateOverrides', 'dashboardContextProps', 'insertFormByName', 'Set ${prop} from current context'],
  ],
  [
    'generic linked parent repair',
    repairSource,
    ['dashboardPageForObjectType', 'filterProps(filter).includes(prop)', 'Linked parent repair:'],
  ],
  [
    'dashboard current-page text fallback',
    queriesSource,
    ['currentPageTextFallbackValues', 'queryDbCurrentPagePropertyExpr', 'safePageName(raw).toUpperCase()'],
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
