import { MODE, VERSION } from '../config';
import { appendManagedBlock, ensurePage } from '../core/editor';
import { safePageName, safeRef } from '../core/names';
import type { Result } from '../core/types';
import {
  allTags,
  layerPages,
  registry,
  rootPages,
} from '../registry';
import { pageTreeText, starterWordEntries } from './contracts';

export type CommandHelpLine = { id: string; label: string; description: string };

export const COMMAND_HELP: CommandHelpLine[] = [
  { id: '1', label: 'lss: 1setup-all', description: 'Run all setup layers in sequence. Safer alternative remains running commands 2-13 step by step.' },
  { id: '2', label: 'lss: 2setup-bootstrap', description: 'Create root/index pages and LSS control pages.' },
  { id: '3', label: 'lss: 3setup-areas', description: 'Create Area pages.' },
  { id: '4', label: 'lss: 4setup-schema-pages', description: 'Create Entity/Form/Word schema-control pages.' },
  { id: '5', label: 'lss: 5setup-db-tags', description: 'Create DB tag contract pages.' },
  { id: '6', label: 'lss: 6setup-tag-properties', description: 'Create tag-property contract pages without binding schema properties to native tags.' },
  { id: '7', label: 'lss: 7setup-relationships', description: 'Create relationship contract pages.' },
  { id: '8', label: 'lss: 8setup-templates', description: 'Install native templates on LSS Native Templates for entity-page materialization.' },
  { id: '9', label: 'lss: 9setup-dashboards', description: 'Create dashboard contract pages.' },
  { id: '10', label: 'lss: 10setup-word-extenders', description: 'Create Word Extender entries.' },
  { id: '11', label: 'lss: 11setup-db-native-config', description: 'Create native tags/properties and remove entity schema properties from native tags.' },
  { id: '12', label: 'lss: 12setup-page-tree', description: 'Create the simple LSS page tree.' },
  { id: '13', label: 'lss: 13verify-schema', description: 'Verify expected scaffold pages and write a report.' },
  { id: '14', label: 'lss: 14new-venture', description: 'Create a placeholder Venture page.' },
  { id: '15', label: 'lss: 15new-project', description: 'Create a placeholder Project page.' },
  { id: '16', label: 'lss: 16new-workstream', description: 'Create a placeholder WorkStream page.' },
  { id: '17', label: 'lss: 17new-person', description: 'Create a placeholder Person page.' },
  { id: '18', label: 'lss: 18new-organisation', description: 'Create a placeholder Organisation page.' },
  { id: '19', label: 'lss: 19new-document', description: 'Create a placeholder Document page.' },
  { id: '20', label: 'lss: 20new-condition', description: 'Create a placeholder Condition page.' },
  { id: '21', label: 'lss: 21new-subject', description: 'Create a placeholder Subject page.' },
  { id: '22', label: 'lss: 22new-pursuit', description: 'Create a placeholder Pursuit page.' },
  { id: '23', label: 'lss: 23insert-action-item', description: 'Insert an ActionItem block at cursor.' },
  { id: '24', label: 'lss: 24insert-decision', description: 'Insert a Decision block at cursor.' },
  { id: '25', label: 'lss: 25insert-interaction', description: 'Insert an Interaction block at cursor.' },
  { id: '26', label: 'lss: 26insert-question', description: 'Insert a Question block at cursor.' },
  { id: '27', label: 'lss: 27insert-insight', description: 'Insert an Insight block at cursor.' },
  { id: '28', label: 'lss: 28insert-idea', description: 'Insert an Idea block at cursor.' },
  { id: '29', label: 'lss: 29insert-note', description: 'Insert a Note block at cursor.' },
  { id: '30', label: 'lss: 30insert-review', description: 'Insert a Review block at cursor.' },
  { id: '31', label: 'lss: 31insert-word-extender', description: 'Insert a Word Extender starter block at cursor.' },
  { id: '32', label: 'lss: 32insert-dashboard-section', description: 'Insert generic dashboard sections at cursor.' },
  { id: '33', label: 'lss: 33audit-current-page', description: 'Audit the current page.' },
  { id: '34', label: 'lss: 34audit-graph', description: 'Run graph-level verification and registry-count report.' },
  { id: '35', label: 'lss: 35insert-venture-dashboard', description: 'Insert Venture dashboard with working queries at cursor.' },
  { id: '36', label: 'lss: 36insert-project-dashboard', description: 'Insert Project dashboard with working queries at cursor.' },
  { id: '37', label: 'lss: 37insert-area-dashboard', description: 'Insert Area dashboard with working queries at cursor.' },
  { id: '38', label: 'lss: 38normalize-properties', description: 'Dry-run property alias normalization candidates on the current page.' },
  { id: '39', label: 'lss: 39convert-text-relationships', description: 'Dry-run text relationship conversion candidates on the current page.' },
  { id: '40', label: 'lss: 40migrate-namespaced-objects', description: 'Dry-run a namespaced object page migration plan.' },
  { id: '41', label: 'lss: 41snapshot-dashboard', description: 'Create a snapshot page from the current page.' },
  { id: '42', label: 'lss: 42export-current-page-report', description: 'Create a Markdown export page from the current page.' },
  { id: '43', label: 'lss: 43generate-weekly-review', description: 'Create a Weekly Review page.' },
  { id: '44', label: 'lss: 44expand-abbreviation', description: 'Insert common LSS property expansion at cursor.' },
  { id: '45', label: 'lss: 45help', description: 'Create/open the command guide.' },
  { id: '46', label: 'lss: 46create-simple-page-tree-page', description: 'Create/update LSS Page Tree - Simple with plain current page names.' },
  { id: '47', label: 'lss: 47create-command-list-page', description: 'Create/update LSS Command List with the active command surface.' },
  { id: '48', label: 'lss: 48create-layer-home-pages', description: 'Create/update one home page per LSS layer with backlinks to all pages in that layer.' },
  { id: '49', label: 'lss: 49add-layer-links-to-home', description: 'Add backlinks to all LSS layer home pages on [[Home]].' },
  { id: '50', label: 'lss: 50repair-current-page', description: 'Recovery tool: materialize journal entity blocks, promote page tags/properties, and fix dashboard queries.' },
  { id: '51', label: 'lss: 51diagnose-current-page', description: 'Diagnose current-page DB tag, property, and query state.' },
  { id: '52', label: 'lss: 52new-function', description: 'Create a placeholder Function page.' },
];

export function commandListBody(): string {
  return [
    'LSS command list',
    `mode:: ${MODE}`,
    `plugin-version:: ${VERSION}`,
    '',
    ...COMMAND_HELP.map((c) => `- ${c.label} — ${c.description}`),
  ].join('\n');
}

function uniqueSortedPages(pages: string[]): string[] {
  const set = new Set<string>();
  const out: string[] = [];
  for (const page of pages ?? []) {
    const name = safePageName(page);
    if (!name || set.has(name)) continue;
    set.add(name);
    out.push(name);
  }
  return out.sort((a, b) => a.localeCompare(b));
}

export type LayerHome = { id: string; home: string; title: string; pages: string[] };

export function layerHomeDefinitions(): LayerHome[] {
  const groups: LayerHome[] = [];
  groups.push({ id: 'roots', home: 'LSS Layer Home - Roots and Indexes', title: 'Roots and indexes', pages: rootPages() });
  groups.push({ id: 'layers', home: 'LSS Layer Home - Layer Indexes', title: 'LSS layer indexes', pages: layerPages() });
  groups.push({ id: 'areas', home: 'LSS Layer Home - Areas', title: 'Areas', pages: (registry.areas ?? []).map((a) => a.page) });
  groups.push({
    id: 'entity-schema-pages',
    home: 'LSS Layer Home - Entity Schema Pages',
    title: 'Entity schema pages',
    pages: (registry.entityTypes ?? []).map((o) => o.schemaPage),
  });
  groups.push({
    id: 'form-schema-pages',
    home: 'LSS Layer Home - Form Schema Pages',
    title: 'Form schema pages',
    pages: (registry.formTypes ?? []).map((o) => o.schemaPage),
  });
  groups.push({
    id: 'word-schema-pages',
    home: 'LSS Layer Home - Word Schema Pages',
    title: 'Word Extender schema pages',
    pages: (registry.wordExtenderTypes ?? []).map((o) => o.schemaPage),
  });
  groups.push({
    id: 'relationships',
    home: 'LSS Layer Home - Relationships',
    title: 'Relationships',
    pages: (registry.relationshipRegistry ?? []).map((r) => `Relationship/${r.property}`),
  });
  groups.push({
    id: 'templates',
    home: 'LSS Layer Home - Templates',
    title: 'Templates',
    pages: [...(registry.templates ?? []).map((t) => t.name), 'LSS Native Templates', 'LSS Legacy Templates'],
  });
  groups.push({
    id: 'dashboards',
    home: 'LSS Layer Home - Dashboards',
    title: 'Dashboards',
    pages: (registry.dashboardDefinitions ?? []).map((d) => d.page),
  });
  groups.push({
    id: 'word-extenders',
    home: 'LSS Layer Home - Word Extenders',
    title: 'Word Extenders',
    pages: [...(registry.wordExtenderTypes ?? []).map((o) => o.schemaPage), ...starterWordEntries().map((e) => e.page)],
  });
  groups.push({
    id: 'db-tags',
    home: 'LSS Layer Home - DB Tags',
    title: 'DB tags',
    pages: allTags().map((t) => `DB Tag/${t}`),
  });
  groups.push({
    id: 'tag-properties',
    home: 'LSS Layer Home - Tag Properties',
    title: 'Tag properties',
    pages: allTags().map((t) => `Tag Properties/${t}`),
  });
  groups.push({
    id: 'native-db',
    home: 'LSS Layer Home - DB Native Configuration',
    title: 'DB native configuration',
    pages: ['LSS Schema', 'LSS Audit', 'LSS Migrations', 'LSS Exports'],
  });
  groups.push({
    id: 'reports-and-guides',
    home: 'LSS Layer Home - Reports and Guides',
    title: 'Reports and guides',
    pages: ['LSS Reports', 'LSS Page Tree', 'LSS Page Tree - Simple', 'LSS Command List', 'LSS Help - Commands'],
  });
  return groups.map((g) => ({ ...g, pages: uniqueSortedPages(g.pages) }));
}

function layerHomeBody(group: LayerHome): string {
  return [
    `LSS layer home: ${group.title}`,
    `lss-layer-home:: ${group.home}`,
    `lss-page-count:: ${group.pages.length}`,
    `lss-generated-by:: lss: 48create-layer-home-pages`,
    `lss-plugin-mode:: ${MODE}`,
    `lss-plugin-version:: ${VERSION}`,
    '',
    'Pages:',
    ...(group.pages.length ? group.pages.map((p) => `- ${safeRef(p)}`) : ['- None']),
  ].join('\n');
}

function layerHomeLinksBody(): string {
  const groups = layerHomeDefinitions();
  return [
    'LSS layer home pages',
    'lss-generated-by:: lss: 49add-layer-links-to-home',
    `lss-plugin-mode:: ${MODE}`,
    `lss-plugin-version:: ${VERSION}`,
    '',
    ...groups.map((g) => `- ${safeRef(g.home)}`),
  ].join('\n');
}

export function simplePageTreeText(): string {
  const lines: string[] = [];
  const seen = new Set<string>();
  const node = (name: string, depth = 0) => {
    const visible = safePageName(name);
    if (!visible) return;
    const key = `${depth}:${visible}`;
    if (seen.has(key)) return;
    seen.add(key);
    lines.push(`${'  '.repeat(depth)}- ${visible}`);
  };
  const sorted = <T,>(items: T[], pick: (item: T) => string) =>
    [...items].sort((a, b) => safePageName(pick(a)).localeCompare(safePageName(pick(b))));

  node('Home');
  node('Pages', 1);
  node('Areas', 2);
  for (const a of sorted(registry.areas ?? [], (x) => x.page)) node(a.page, 3);
  node('Entity-Pages', 2);
  for (const o of sorted(registry.entityTypes ?? [], (x) => x.schemaPage)) {
    node(o.schemaPage, 3);
  }
  node('Forms', 2);
  for (const o of sorted(registry.formTypes ?? [], (x) => x.schemaPage)) node(o.schemaPage, 3);
  node('Relationships', 2);
  for (const r of sorted(registry.relationshipRegistry ?? [], (x) => `Relationship/${x.property}`)) {
    node(`Relationship/${r.property}`, 3);
  }
  node('Dashboards', 2);
  for (const d of sorted(registry.dashboardDefinitions ?? [], (x) => x.page)) node(d.page, 3);
  node('Templates', 1);
  for (const t of sorted(registry.templates ?? [], (x) => x.name)) node(t.name, 2);
  node('Word Extenders', 1);
  for (const o of sorted(registry.wordExtenderTypes ?? [], (x) => x.schemaPage)) node(o.schemaPage, 2);
  node('LSS Schema', 1);
  for (const p of ['LSS Audit', 'LSS Migrations', 'LSS Exports', 'LSS Reports']) node(p, 2);
  node('LSS Layer', 1);
  for (const p of layerPages()) node(p, 2);
  node('DB Tags', 1);
  for (const tag of allTags()) node(`DB Tag/${tag}`, 2);
  node('Tag Properties', 1);
  for (const tag of allTags()) node(`Tag Properties/${tag}`, 2);
  node('LSS Native Templates', 1);
  node('LSS Command List', 1);
  node('LSS Page Tree - Simple', 1);
  return lines.join('\n');
}

export async function createSimplePageTreePage(r: Result): Promise<void> {
  await ensurePage(r, 'LSS Page Tree - Simple');
  await appendManagedBlock(r, 'LSS Page Tree - Simple', `${MODE}-simple-page-tree-v${VERSION}`, simplePageTreeText());
}

export async function createCommandListPage(r: Result): Promise<void> {
  await ensurePage(r, 'LSS Command List');
  await appendManagedBlock(r, 'LSS Command List', `${MODE}-command-list-v${VERSION}`, commandListBody());
}

export async function createLayerHomePages(r: Result): Promise<void> {
  for (const group of layerHomeDefinitions()) {
    await ensurePage(r, group.home, {
      'lss-layer-home': group.title,
      'lss-page-count': String(group.pages.length),
    });
    await appendManagedBlock(r, group.home, `${MODE}-layer-home-${group.id}-v1`, layerHomeBody(group));
  }
}

export async function addLayerLinksToHome(r: Result): Promise<void> {
  await ensurePage(r, 'Home');
  await appendManagedBlock(r, 'Home', `${MODE}-layer-home-links-v1`, layerHomeLinksBody());
}

export async function createHelpPage(r: Result): Promise<void> {
  const helpPage = 'LSS Help - Commands';
  const body = [
    'LSS command guide',
    '',
    'Use the commands in order. For setup, either run `lss: 1setup-all` or run `lss: 2setup-bootstrap` through `lss: 13verify-schema` step by step.',
    '',
    '## Commands',
    ...COMMAND_HELP.map((c) => `- ${c.label} — ${c.description}`),
    '',
    '## Notes',
    '- Commands 14-22 create placeholder pages. Rename them after review.',
    '- Commands 23-32 insert blocks at the active cursor. Run them from an empty block.',
    '- Commands 33-44 update, audit, export, or snapshot existing pages.',
    '- Commands 46-49 create navigation, command-list, and layer-home pages.',
    '- Command 50 repairs the current page (promote properties/tags, fix dashboard queries).',
    '- Commands intentionally use flat-safe scaffold page names to avoid namespace parent errors.',
    '- Spec aliases such as `LSS: Initialize Schema` map to the same handlers as numbered commands.',
  ].join('\n');
  await ensurePage(r, helpPage);
  await appendManagedBlock(r, helpPage, `${MODE}-command-help-v${VERSION}`, body);
}

// Re-export page tree from contracts for step12 compatibility
export { pageTreeText };
