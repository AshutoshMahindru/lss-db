import { MODE } from '../config';
import {
  appendManagedBlock,
  blockId,
  currentPageName,
  ensurePage,
  getBlocks,
  getPage,
  insertAtCursor,
  pageVisibleName,
  resolvePageFromIdentity,
  walkBlocks,
} from '../core/editor';
import { scheduleAutoRepair } from './auto-repair';
import { repairNamedPage } from './repair';
import {
  canonicalPropertyKey,
  pageHasClassTag,
  resolveUpsertPropertyValue,
} from '../core/db-properties';
import { formatError, sleep } from '../core/runner';
import {
  allObjects,
  dashboardPageForObjectType,
  normalizeAreaRef,
  objectByName,
  propertySpec,
  registry,
} from '../registry';
import { safePageName, safeTag, todayRef, tsKey, visiblePageLabel } from '../core/names';
import type { Result } from '../core/types';
import type { RegistryObject } from '../registry/types';

function uniqueProps(o: RegistryObject): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of [...(o.requiredProperties ?? []), ...(o.properties ?? [])]) {
    if (!p || seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

function defaultPropertyValueForCreate(
  prop: string,
  o: RegistryObject,
  overrides: Record<string, string> = {},
): string {
  const p = String(prop);
  if (Object.prototype.hasOwnProperty.call(overrides, p)) return overrides[p] ?? '';
  if (Object.prototype.hasOwnProperty.call(o.defaultValues ?? {}, p)) {
    const value = o.defaultValues?.[p];
    return value == null ? '' : String(value);
  }
  const area = normalizeAreaRef(o.area);
  if (p === 'area' || p === 'areas') return `[[${area}]]`;
  if (p === 'status') return safeTag(o.tag) === 'ActionItem' ? 'Todo' : 'active';
  if (p === 'priority' || p === 'Priority') return safeTag(o.tag) === 'ActionItem' ? 'Medium' : 'medium';
  if (['date', 'captured-on', 'asked-on', 'decided-on', 'start-date', 'review-date', 'created-on'].includes(p)) {
    return todayRef().replace(/^\[\[|\]\]$/g, '');
  }
  return '';
}

function propLine(prop: string, o: RegistryObject): string {
  const p = String(prop);
  const area = normalizeAreaRef(o.area);
  if (p === 'area') return `area:: [[${area}]]`;
  if (p === 'areas') return `areas:: [[${area}]]`;
  if (p === 'status') return safeTag(o.tag) === 'ActionItem' ? 'Status:: Todo' : 'status:: active';
  if (p === 'priority') return safeTag(o.tag) === 'ActionItem' ? 'Priority:: Medium' : 'priority:: medium';
  if (['date', 'captured-on', 'asked-on', 'decided-on', 'start-date', 'review-date', 'created-on'].includes(p)) {
    // Use plain date (no [[ ]]) so it renders visibly; repair will set the native journal-day value
    const d = todayRef().replace(/^\[\[|\]\]$/g, '');
    return `${p}:: ${d}`;
  }
  if (p === 'Deadline' || p === 'deadline') return `${p}:: `;
  if (p === 'confidentiality') return `confidentiality:: internal`;
  if (p === 'owner') return `owner:: `;
  return `${p}:: `;
}

function sectionNames(blocks: any[]): Set<string> {
  const sections = new Set<string>();
  for (const block of walkBlocks(blocks)) {
    const text = String(block?.content ?? '').trim();
    if (text && !text.includes('::')) sections.add(text.split(/\s+/)[0].toLowerCase());
  }
  return sections;
}

function inferObjectTypeFromSections(blocks: any[]): string | null {
  const sections = sectionNames(blocks);
  if (sections.has('functions') && sections.has('projects') && sections.has('workstreams')) return 'Venture';
  if (sections.has('outcome') && sections.has('scope')) return 'Project';
  if (sections.has('responsibilities') && sections.has('related')) return 'Function';
  if (sections.has('interactions') && sections.has('commitments')) return 'Person';
  if (sections.has('treatments') && sections.has('symptoms')) return 'Condition';
  if (sections.has('courses') && sections.has('lessons') && sections.has('concepts')) return 'Subject';
  return null;
}

async function propertyValueToCreateRef(value: unknown): Promise<string> {
  if (value == null) return '';
  if (Array.isArray(value)) {
    const values = await Promise.all(value.map((item) => propertyValueToCreateRef(item)));
    return values.filter(Boolean).join(', ');
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const name = pageVisibleName(record);
    if (name) return `[[${safePageName(name)}]]`;
    const id = record.id ?? record.uuid;
    if (id != null) {
      const page = await resolvePageFromIdentity(id as string | number).catch(() => null);
      const label = pageVisibleName(page);
      return label ? `[[${safePageName(label)}]]` : String(id);
    }
    return '';
  }
  const input = String(value).trim();
  const raw = visiblePageLabel(input);
  if (!raw) return '';
  if (input.startsWith('[[') || raw !== input) return `[[${safePageName(raw)}]]`;
  if (/^\d+$/.test(raw) && Number(raw) < 1e9) return raw;
  return raw;
}

async function readCurrentContextProps(pageName: string, pageBlockId: string | null): Promise<Map<string, string>> {
  const props = new Map<string, string>();
  const sources: Array<Record<string, unknown> | null | undefined> = [];
  const page = await getPage(pageName);
  sources.push(page?.properties as Record<string, unknown> | undefined);
  if (logseq.Editor.getPageProperties) {
    sources.push(await logseq.Editor.getPageProperties(pageName).catch(() => null));
  }
  if (pageBlockId && logseq.Editor.getBlockProperties) {
    sources.push(await logseq.Editor.getBlockProperties(pageBlockId).catch(() => null));
  }
  for (const source of sources) {
    if (!source) continue;
    for (const [rawKey, rawValue] of Object.entries(source)) {
      const key = canonicalPropertyKey(rawKey);
      if (key === 'tags' || key.startsWith('block/')) continue;
      const value = await propertyValueToCreateRef(rawValue);
      if (value) props.set(key, value);
    }
  }
  return props;
}

function dashboardContextProps(objectType: string): Set<string> {
  const dashboard = dashboardPageForObjectType(objectType);
  const props = new Set<string>();
  if (!dashboard) return props;
  for (const view of registry.viewDefinitions ?? []) {
    if (view.dashboard !== dashboard) continue;
    for (const filter of view.filters ?? []) {
      if (filter.property) props.add(String(filter.property));
      for (const prop of filter.propertyAny ?? []) props.add(String(prop));
    }
  }
  return props;
}

function currentTypeNameCandidates(objectType: string): Set<string> {
  const kebab = objectType.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
  const compact = objectType.toLowerCase();
  return new Set([compact, kebab, `related-${compact}`, `related-${kebab}`]);
}

async function currentPageContextForCreate(): Promise<{
  objectType: string | null;
  pageRef: string;
  props: Map<string, string>;
} | null> {
  const current = await currentPageName();
  if (!current) return null;
  const page = await getPage(current);
  if (!page) return null;
  const visibleName = pageVisibleName(page, current);
  if (!visibleName) return null;
  const pageBlockId = blockId(page);
  const props = await readCurrentContextProps(visibleName, pageBlockId);
  let objectType = String(props.get('lss-object-type') ?? '').trim() || null;
  if (!objectType && pageBlockId) {
    for (const obj of allObjects()) {
      if (await pageHasClassTag(pageBlockId, safeTag(obj.tag))) {
        objectType = obj.name;
        break;
      }
    }
  }
  if (!objectType) objectType = inferObjectTypeFromSections(await getBlocks(visibleName));
  return { objectType, pageRef: `[[${safePageName(visibleName)}]]`, props };
}

async function defaultCreateOverrides(o: RegistryObject): Promise<Record<string, string>> {
  const context = await currentPageContextForCreate();
  if (!context?.objectType || context.objectType === o.name) return {};
  const objectProps = new Set(uniqueProps(o));
  const overrides: Record<string, string> = {};
  const dashboardProps = dashboardContextProps(context.objectType);
  const directProps = currentTypeNameCandidates(context.objectType);

  for (const prop of objectProps) {
    const spec = propertySpec(prop);
    const type = String(spec?.type ?? '').toLowerCase();
    if (type !== 'node') continue;
    const targets = (((spec as { targets?: unknown[] } | undefined)?.targets ?? [])).map(String);
    const targetsCurrent = targets.includes(context.objectType);
    if ((dashboardProps.has(prop) || directProps.has(prop)) && targetsCurrent) {
      overrides[prop] = context.pageRef;
    }
  }

  for (const prop of objectProps) {
    if (overrides[prop] || !context.props.has(prop)) continue;
    const spec = propertySpec(prop);
    if (String(spec?.type ?? '').toLowerCase() === 'node') {
      overrides[prop] = context.props.get(prop) ?? '';
    }
  }

  return overrides;
}

function entityPageBody(o: RegistryObject, title: string): string {
  const tag = safeTag(o.tag);
  const lines: string[] = [];
  lines.push(`${title} #${tag}`);
  lines.push('');
  lines.push('Purpose:');
  lines.push('- ');
  lines.push('Current status:');
  lines.push('- ');
  lines.push('Links / related objects:');
  lines.push('- ');
  lines.push('Notes:');
  lines.push('- ');
  return lines.join('\n');
}

function formBlockBody(o: RegistryObject): string {
  const tag = safeTag(o.tag);
  const title = `New ${o.name} - ${todayRef()}`;
  const lines: string[] = [];
  lines.push(`- ${title} #${tag}`);
  lines.push('  - Content');
  lines.push('    - ');
  lines.push('  - Links / follow-up');
  lines.push('    - ');
  return lines.join('\n');
}

async function createPropertyValue(
  prop: string,
  o: RegistryObject,
  overrides: Record<string, string>,
): Promise<unknown> {
  const raw = defaultPropertyValueForCreate(prop, o, overrides);
  return await resolveUpsertPropertyValue(prop, raw);
}

async function upsertCreationProperties(
  r: Result,
  targetBlockId: string,
  o: RegistryObject,
  overrides: Record<string, string>,
  targetLabel: string,
): Promise<void> {
  if (!targetBlockId) {
    r.errors.push(`creation property upsert ${targetLabel}: missing target block id`);
    return;
  }
  if (!logseq.Editor.upsertBlockProperty) {
    r.notes.push(`SKIP creation property upsert on ${targetLabel}: upsertBlockProperty API unavailable.`);
    return;
  }

  const props = uniqueProps(o);
  let written = 0;
  for (const p of props) {
    try {
      const val = await createPropertyValue(p, o, overrides);
      if (val == null) {
        r.notes.push(`SKIP creation property ${targetLabel}.${p}: no DB-compatible value resolved.`);
        continue;
      }
      await logseq.Editor.upsertBlockProperty(targetBlockId, p, val);
      written++;
    } catch (error) {
      r.errors.push(`creation property ${targetLabel}.${p}: ${formatError(error)}`);
    }
  }

  if (written) {
    r.actions.push(`UPSERT creation properties: ${targetLabel} (${written}/${props.length})`);
  }
}

async function createEntityByName(r: Result, objectName: string): Promise<void> {
  const o = objectByName(objectName);
  if (!o) {
    r.errors.push(`unknown object type: ${objectName}`);
    return;
  }
  const title = `New ${o.name} - ${tsKey()}`;
  const overrides = await defaultCreateOverrides(o);

  // Build props, resolving dates to journal page ids for DB graphs to avoid date validation errors.
  const pageProps: Record<string, any> = {
    'lss-object-type': o.name,
    'lss-object-tag': `#${safeTag(o.tag)}`,
    'lss-post-created': 'true',
  };
  for (const p of uniqueProps(o)) {
    try {
      const value = await createPropertyValue(p, o, overrides);
      if (value != null) pageProps[p] = value;
    } catch (error) {
      r.errors.push(`create page property ${title}.${p}: ${formatError(error)}`);
    }
  }
  await ensurePage(r, title, pageProps);

  await appendManagedBlock(r, title, `${MODE}-post-create-${o.name}-${tsKey()}`, entityPageBody(o, title));

  // Ensure properties using proper page block id (more reliable on DB graphs).
  // Resolve dates etc. to journal page ids on DB so no "should be a journal date" errors.
  const page = await getPage(title);
  const pageBlockId = blockId(page) || title;
  await upsertCreationProperties(r, pageBlockId, o, overrides, title);

  scheduleAutoRepair(title);

  // Run repair pass on the new page so properties (and any structure) are ensured immediately via the robust path
  // (no need for user to run lss: materialise page right after creation).
  try {
    await repairNamedPage(r, title, o.name);
  } catch (error) {
    r.errors.push(`post-create repair ${title}: ${formatError(error)}`);
  }

  r.notes.push(`Created placeholder page ${title}. Rename it to the real object name after review. (Schema ensured from #${o.tag})`);
  if (overrides.venture) {
    r.notes.push(`Set venture from current Venture page: ${overrides.venture}`);
  }
}

async function insertFormByName(r: Result, objectName: string): Promise<void> {
  const o = objectByName(objectName);
  if (!o) {
    r.errors.push(`unknown form type: ${objectName}`);
    return;
  }
  const overrides = await defaultCreateOverrides(o);
  await insertAtCursor(r, formBlockBody(o), `${o.name} form block`);
  // Set properties via upsert on the inserted block (not as text in content) so they are proper block properties.
  // The #tag will also trigger auto-repair.
  try {
    await sleep(100);
    const current = await logseq.Editor.getCurrentBlock?.();
    const insertedBlockId = current ? blockId(current) : null;
    if (!insertedBlockId) {
      r.errors.push(`form property upsert ${o.name}: could not resolve inserted block id`);
    } else {
      await upsertCreationProperties(r, insertedBlockId, o, overrides, `${o.name} form block`);
    }
  } catch (error) {
    r.errors.push(`form property upsert ${o.name}: ${formatError(error)}`);
  }
  r.notes.push(`Inserted ${o.name} block at the cursor. Fill relationship fields with page refs, not plain text.`);
  for (const [prop, value] of Object.entries(overrides)) {
    r.notes.push(`Set ${prop} from current context: ${value}`);
  }
}

export function newRegistryPage(objectName: string): (r: Result) => Promise<void> {
  return async (r: Result) => {
    await createEntityByName(r, objectName);
  };
}

export function insertRegistryFormBlock(objectName: string): (r: Result) => Promise<void> {
  return async (r: Result) => {
    await insertFormByName(r, objectName);
  };
}

export async function newVenture(r: Result): Promise<void> {
  await createEntityByName(r, 'Venture');
}
export async function newFunction(r: Result): Promise<void> {
  await createEntityByName(r, 'Function');
}
export async function newProject(r: Result): Promise<void> {
  await createEntityByName(r, 'Project');
}
export async function newWorkStream(r: Result): Promise<void> {
  await createEntityByName(r, 'WorkStream');
}
export async function newPerson(r: Result): Promise<void> {
  await createEntityByName(r, 'Person');
}
export async function newOrganisation(r: Result): Promise<void> {
  await createEntityByName(r, 'Organisation');
}
export async function newDocument(r: Result): Promise<void> {
  await createEntityByName(r, 'Document');
}
export async function newCondition(r: Result): Promise<void> {
  await createEntityByName(r, 'Condition');
}
export async function newSubject(r: Result): Promise<void> {
  await createEntityByName(r, 'Subject');
}
export async function newPursuit(r: Result): Promise<void> {
  await createEntityByName(r, 'Pursuit');
}
export async function insertActionItem(r: Result): Promise<void> {
  await insertFormByName(r, 'ActionItem');
}
export async function insertDecision(r: Result): Promise<void> {
  await insertFormByName(r, 'Decision');
}
export async function insertInteraction(r: Result): Promise<void> {
  await insertFormByName(r, 'Interaction');
}
export async function insertQuestion(r: Result): Promise<void> {
  await insertFormByName(r, 'Question');
}
export async function insertInsight(r: Result): Promise<void> {
  await insertFormByName(r, 'Insight');
}
export async function insertIdea(r: Result): Promise<void> {
  await insertFormByName(r, 'Idea');
}
export async function insertNote(r: Result): Promise<void> {
  await insertFormByName(r, 'Note');
}
export async function insertReview(r: Result): Promise<void> {
  await insertFormByName(r, 'Review');
}
export async function insertWordExtender(r: Result): Promise<void> {
  const body = [
    '- New Word Extender #Term',
    '  status:: active',
    '  domain:: ',
    '  use-case:: ',
    '  trigger:: ',
    '  replacement-text:: ',
    '  - Meaning',
    '    - ',
    '  - Use when',
    '    - ',
  ].join('\n');
  await insertAtCursor(r, body, 'word extender starter');
}
export async function insertDashboardSection(r: Result): Promise<void> {
  const body = [
    '- LSS Dashboard Sections',
    '  - Projects',
    '    - #Query (and (property lss-object-type "Project") (property venture <% current page %>) )',
    '  - Action Items',
    '    - #Query (and (property lss-object-type "ActionItem") (property venture <% current page %>) )',
    '  - Decisions',
    '    - #Query (and (property lss-object-type "Decision") (property venture <% current page %>) )',
    '  - Interactions',
    '    - #Query (and (property lss-object-type "Interaction") (property venture <% current page %>) )',
    '  - Documents / Files',
    '    - #Query (or (and (property lss-object-type "Document") (property venture <% current page %>) ) (and (property lss-object-type "File") (property venture <% current page %>) ) )',
  ].join('\n');
  await insertAtCursor(r, body, 'dashboard section starter');
  // Auto-repair will pick up the inserted #Query content on graph change for DB upgrade if needed.
}
