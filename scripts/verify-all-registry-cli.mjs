#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import rawRegistry from '../src/registry/data.json' with { type: 'json' };

const graph = process.env.LSS_VERIFY_GRAPH || 'lsdb';
const runId = process.env.LSS_VERIFY_RUN_ID || new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
const prefix = process.env.LSS_VERIFY_PREFIX || `Codex Verify ${runId}`;
const mode = process.argv[2] || 'create';

const entityTypes = rawRegistry.entityTypes ?? [];
const formTypes = rawRegistry.formTypes ?? [];
const objects = [...entityTypes, ...formTypes];
const templates = rawRegistry.templates ?? [];
const queryHeadings = ['RELATED ENTITIES', 'GENERIC ENTITIES', 'FORMS', 'REVIEWS', 'DATES'];
const allHeadings = ['NATIVE SECTIONS', ...queryHeadings];

function runLogseq(args, options = {}) {
  const result = spawnSync('logseq', ['-g', graph, ...args], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 20,
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(
      `logseq ${args.join(' ')} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  return result.stdout.trim();
}

function pageName(object) {
  return `${prefix} - ${object.name}`;
}

function formBlockTitle(object) {
  return `${prefix} - form block - ${object.name}`;
}

function ednString(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function pageProperties(object, kind) {
  return [
    `:lss-object-type ${ednString(object.name)}`,
    `:lss-verify-run ${ednString(runId)}`,
    `:lss-verify-kind ${ednString(kind)}`,
    ':status "active"',
  ].join(', ');
}

function createPage(object, kind) {
  runLogseq([
    'upsert',
    'page',
    '--page',
    pageName(object),
    '--update-tags',
    JSON.stringify([object.tag || object.name]),
    '--update-properties',
    `{${pageProperties(object, kind)}}`,
    '--output',
    'edn',
  ]);
}

function createFormBlocks() {
  const page = `${prefix} - FORM BLOCKS`;
  runLogseq([
    'upsert',
    'page',
    '--page',
    page,
    '--update-properties',
    `{:lss-verify-run ${ednString(runId)}, :lss-verify-kind "form-block-container"}`,
    '--output',
    'edn',
  ]);
  for (const form of formTypes) {
    runLogseq([
      'upsert',
      'block',
      '--target-page',
      page,
      '--content',
      formBlockTitle(form),
      '--update-tags',
      JSON.stringify([form.tag || form.name]),
      '--update-properties',
      `{${pageProperties(form, 'form-block')}}`,
      '--output',
      'edn',
    ]);
  }
}

function parseEdnResult(output) {
  const match = output.match(/:result\s+(#?\{[\s\S]*\}|\[[\s\S]*\])/);
  return match?.[1] ?? output;
}

function countRows(output) {
  const data = parseEdnResult(output);
  if (data === '#{}' || data === '[]') return 0;
  const tupleCount = (data.match(/\[/g) ?? []).length;
  return tupleCount;
}

function firstId(output) {
  const match = output.match(/\[(\d+)\]/);
  return match ? Number(match[1]) : null;
}

function queryCreatedPages() {
  return runLogseq([
    'search',
    'page',
    '--content',
    prefix,
    '--output',
    'edn',
  ]);
}

function queryFormBlocks() {
  return runLogseq([
    'search',
    'block',
    '--content',
    `${prefix} - form block -`,
    '--output',
    'edn',
  ]);
}

function pageHasTag(page, tag) {
  const show = runLogseq(['show', '--page', page, '--level', '1', '--output', 'edn']);
  return show.includes(`:block/title "${tag}"`) || show.includes(`:block/name "${String(tag).toLowerCase()}"`);
}

function blockSearchHasTag(title, tag) {
  const output = runLogseq([
    'query',
    '--query',
    '[:find ?b :in $ ?title ?tagTitle :where [?b :block/title ?title] [?b :block/tags ?tag] [?tag :block/title ?tagTitle]]',
    '--inputs',
    `[${ednString(title)} ${ednString(tag)}]`,
    '--output',
    'edn',
  ]);
  return countRows(output) > 0;
}

function queryDirectChildId(parentId, title) {
  return firstId(runLogseq([
    'query',
    '--query',
    '[:find ?b :in $ ?parent ?title :where [?b :block/parent ?parent] [?b :block/title ?title]]',
    '--inputs',
    `[${parentId} ${ednString(title)}]`,
    '--output',
    'edn',
  ]));
}

function queryPageChildId(page, title) {
  return firstId(runLogseq([
    'query',
    '--query',
    '[:find ?b :in $ ?page ?title :where [?p :block/title ?page] [?b :block/parent ?p] [?b :block/title ?title]]',
    '--inputs',
    `[${ednString(page)} ${ednString(title)}]`,
    '--output',
    'edn',
  ]));
}

function ensurePageChild(page, title, options = {}) {
  const existing = queryPageChildId(page, title);
  if (existing) return existing;
  runLogseq([
    'upsert',
    'block',
    '--target-page',
    page,
    '--content',
    title,
    ...(options.updateTags ? ['--update-tags', JSON.stringify(options.updateTags)] : []),
    ...(options.updateProperties ? ['--update-properties', options.updateProperties] : []),
    '--output',
    'edn',
  ]);
  const created = queryPageChildId(page, title);
  if (!created) throw new Error(`could not create child block "${title}" under page "${page}"`);
  return created;
}

function ensureBlockChild(parentId, title, options = {}) {
  const existing = queryDirectChildId(parentId, title);
  if (existing) return existing;
  runLogseq([
    'upsert',
    'block',
    '--target-id',
    String(parentId),
    '--content',
    title,
    ...(options.updateTags ? ['--update-tags', JSON.stringify(options.updateTags)] : []),
    ...(options.updateProperties ? ['--update-properties', options.updateProperties] : []),
    '--output',
    'edn',
  ]);
  const created = queryDirectChildId(parentId, title);
  if (!created) throw new Error(`could not create child block "${title}" under block "${parentId}"`);
  return created;
}

function templateForObject(object) {
  return templates.find((template) => template.name === object.template || template.objectType === object.name);
}

function templateSections(object) {
  const template = templateForObject(object);
  const seen = new Set();
  const sections = [];
  for (const section of template?.requiredSections ?? []) {
    const title = String(section ?? '').trim();
    const key = title.toLowerCase();
    if (!title || seen.has(key) || allHeadings.includes(title)) continue;
    seen.add(key);
    sections.push(title);
  }
  return sections;
}

function queryForHeading(object, heading) {
  return `[:find ?b :where [?b :block/tags ?tag] [?tag :block/title "${object.tag || object.name}"]] ;; ${heading}`;
}

function ednBlock(title, children = []) {
  const childEdn = children.length
    ? ` :block/children [${children.map((child) => ednBlock(child.title, child.children ?? [])).join(' ')}]`
    : '';
  return `{:block/title ${ednString(title)}${childEdn}}`;
}

function pageShapeBlocks(object) {
  return [
    {
      title: 'NATIVE SECTIONS',
      children: templateSections(object).map((title) => ({ title })),
    },
    ...queryHeadings.map((heading) => ({
      title: heading,
      children: [{ title: `${heading} query` }],
    })),
  ];
}

function materializePageShape(object) {
  const page = pageName(object);
  const blocks = pageShapeBlocks(object);
  runLogseq([
    'upsert',
    'block',
    '--target-page',
    page,
    '--blocks',
    `[${blocks.map((block) => ednBlock(block.title, block.children)).join(' ')}]`,
    '--output',
    'edn',
  ]);
  for (const heading of queryHeadings) {
    const headingId = queryPageChildId(page, heading);
    if (!headingId) throw new Error(`missing materialized heading "${heading}" on "${page}"`);
    const title = `${heading} query`;
    const queryBlockId = queryDirectChildId(headingId, title);
    if (!queryBlockId) throw new Error(`missing materialized query block "${title}" on "${page}"`);
    runLogseq([
      'upsert',
      'block',
      '--id',
      String(queryBlockId),
      '--update-tags',
      JSON.stringify(['Query']),
      '--update-properties',
      `{:logseq.property/query ${ednString(queryForHeading(object, heading))}}`,
      '--output',
      'edn',
    ]);
  }
}

function materializeAllPageShapes() {
  for (const object of objects) materializePageShape(object);
}

function pageHasMaterialisedShape(object) {
  const page = pageName(object);
  const show = runLogseq(['show', '--page', page, '--level', '4', '--output', 'edn']);
  const headingPositions = allHeadings.map((heading) => show.indexOf(`:block/title "${heading}"`));
  const hasHeadings = headingPositions.every((pos) => pos >= 0);
  const headingsOrdered = headingPositions.every((pos, index) => index === 0 || pos > headingPositions[index - 1]);
  const queryOutput = runLogseq([
    'query',
    '--query',
    `[:find ?parentTitle ?title ?query :where [?p :block/title "${page}"] [?h :block/parent ?p] [?h :block/title ?parentTitle] [(contains? #{"${queryHeadings.join('" "')}" } ?parentTitle)] [?b :block/parent ?h] [?b :block/title ?title] [?b :block/tags ?tag] [?tag :block/title "Query"] [?b :logseq.property/query ?query]]`,
    '--output',
    'edn',
  ]);
  return {
    page,
    tag: object.tag || object.name,
    hasHeadings,
    headingsOrdered,
    queryCount: countRows(queryOutput),
    queryOutput,
  };
}

function writeManifest(created) {
  const manifest = {
    graph,
    runId,
    prefix,
    entityCount: entityTypes.length,
    formCount: formTypes.length,
    pages: objects.map((object) => ({
      name: pageName(object),
      objectType: object.name,
      tag: object.tag || object.name,
      kind: entityTypes.includes(object) ? 'entity-page' : 'form-page',
    })),
    formBlocksPage: `${prefix} - FORM BLOCKS`,
    formBlocks: formTypes.map((object) => ({
      title: formBlockTitle(object),
      objectType: object.name,
      tag: object.tag || object.name,
    })),
    created,
  };
  const path = `/tmp/lss-verify-${runId}.json`;
  fs.writeFileSync(path, JSON.stringify(manifest, null, 2));
  console.log(path);
}

if (mode === 'create') {
  for (const object of entityTypes) createPage(object, 'entity-page');
  for (const object of formTypes) createPage(object, 'form-page');
  createFormBlocks();
  const pages = queryCreatedPages();
  const blocks = queryFormBlocks();
  const pageChecks = objects.map((object) => ({
    page: pageName(object),
    tag: object.tag || object.name,
    ok: pageHasTag(pageName(object), object.tag || object.name),
  }));
  const blockChecks = formTypes.map((object) => ({
    title: formBlockTitle(object),
    tag: object.tag || object.name,
    ok: blockSearchHasTag(formBlockTitle(object), object.tag || object.name),
  }));
  writeManifest({
    pageRows: pageChecks.filter((item) => item.ok).length,
    formBlockRows: blockChecks.filter((item) => item.ok).length,
    pageChecks,
    blockChecks,
    pages,
    blocks,
  });
} else if (mode === 'materialize-cli') {
  materializeAllPageShapes();
  const results = objects.map(pageHasMaterialisedShape);
  const failures = results.filter((result) => !result.hasHeadings || !result.headingsOrdered || result.queryCount !== 5);
  console.log(JSON.stringify({ graph, runId, prefix, checked: results.length, failures, results }, null, 2));
  if (failures.length) process.exit(1);
} else if (mode === 'verify-materialised') {
  const results = objects.map(pageHasMaterialisedShape);
  const failures = results.filter((result) => !result.hasHeadings || !result.headingsOrdered || result.queryCount !== 5);
  console.log(JSON.stringify({ graph, runId, prefix, checked: results.length, failures, results }, null, 2));
  if (failures.length) process.exit(1);
} else {
  throw new Error(`unknown mode: ${mode}`);
}
