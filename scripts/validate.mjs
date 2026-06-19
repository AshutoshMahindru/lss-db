import fs from 'fs';

const registry = JSON.parse(fs.readFileSync('src/registry/data.json', 'utf8'));

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

console.log(
  'registry ok',
  `areas=${areas.length}`,
  `entities=${entityTypes.length}`,
  `forms=${formTypes.length}`,
  `word-extenders=${wordExtenderTypes.length}`,
);
