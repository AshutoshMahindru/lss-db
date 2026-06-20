import { MODE } from '../config';
import {
  appendManagedBlock,
  blockId,
  currentPageName,
  ensurePage,
  getBlocks,
  getPage,
  insertAtCursor,
  walkBlocks,
} from '../core/editor';
import { scheduleAutoRepair } from './auto-repair';
import { repairNamedPage } from './repair';
import { isDateProperty, pageHasClassTag, resolveUpsertPropertyValue, toJournalDay } from '../core/db-properties';
import { sleep } from '../core/runner';
import { normalizeAreaRef, objectByName } from '../registry';
import { safeTag, todayRef, tsKey } from '../core/names';
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

function pageHasVentureDashboardSections(blocks: any[]): boolean {
  const sections = new Set<string>();
  for (const block of walkBlocks(blocks)) {
    const text = String(block?.content ?? '').trim();
    if (/^(Functions|Projects|Workstreams)\b/i.test(text)) {
      sections.add(text.split(/\s+/)[0].toLowerCase());
    }
  }
  return sections.has('functions') && sections.has('projects') && sections.has('workstreams');
}

async function currentVentureRefForCreate(): Promise<string | null> {
  const current = await currentPageName();
  if (!current) return null;
  const page = await getPage(current);
  if (!page) return null;
  const visibleName = String(page.originalName ?? page.name ?? page.title ?? current).trim();
  const pageBlockId = blockId(page);
  const isTaggedVenture = pageBlockId ? await pageHasClassTag(pageBlockId, 'Venture') : false;
  const blocks = isTaggedVenture ? [] : await getBlocks(visibleName);
  if (!isTaggedVenture && !pageHasVentureDashboardSections(blocks)) return null;
  return visibleName ? `[[${visibleName}]]` : null;
}

async function defaultCreateOverrides(o: RegistryObject): Promise<Record<string, string>> {
  if (o.name === 'Venture' || !uniqueProps(o).includes('venture')) return {};
  const currentVenture = await currentVentureRefForCreate();
  return currentVenture ? { venture: currentVenture } : {};
}

function entityPageBody(o: RegistryObject, title: string, overrides: Record<string, string> = {}): string {
  const tag = safeTag(o.tag);
  const lines: string[] = [];
  lines.push(`${title} #${tag}`);
  lines.push('');
  for (const p of uniqueProps(o)) {
    const val = defaultPropertyValueForCreate(p, o, overrides);
    lines.push(`${p}:: ${val}`);
  }
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

async function createEntityByName(r: Result, objectName: string): Promise<void> {
  const o = objectByName(objectName);
  if (!o) {
    r.errors.push(`unknown object type: ${objectName}`);
    return;
  }
  const title = `New ${o.name} - ${tsKey()}`;
  const overrides = await defaultCreateOverrides(o);

  // Build props, resolving dates to proper journal-day for DB graphs to avoid errors.
  const pageProps: Record<string, any> = {
    'lss-object-type': o.name,
    'lss-object-tag': `#${safeTag(o.tag)}`,
    'lss-post-created': 'true',
  };
  for (const p of uniqueProps(o)) {
    const raw = defaultPropertyValueForCreate(p, o, overrides);
    let val = await resolveUpsertPropertyValue(p, raw);
    if (val == null && isDateProperty(p)) {
      val = toJournalDay(raw);
    }
    pageProps[p] = val;
  }
  await ensurePage(r, title, pageProps);

  await appendManagedBlock(r, title, `${MODE}-post-create-${o.name}-${tsKey()}`, entityPageBody(o, title, overrides));

  // Ensure properties using proper page block id (more reliable on DB graphs).
  // Resolve dates etc. to journal-day ints on DB so no "should be a journal date" errors.
  try {
    const page = await getPage(title);
    const pageBlockId = blockId(page) || title;
    if (logseq.Editor.upsertBlockProperty) {
      for (const p of uniqueProps(o)) {
        const raw = defaultPropertyValueForCreate(p, o, overrides);
        let val = await resolveUpsertPropertyValue(p, raw);
        if (val == null && isDateProperty(p)) {
          val = toJournalDay(raw);
        }
        if (val != null) {
          await logseq.Editor.upsertBlockProperty(pageBlockId, p, val).catch(() => {});
        }
      }
    }
  } catch {}

  scheduleAutoRepair(title);

  // Run repair pass on the new page so properties (and any structure) are ensured immediately via the robust path
  // (no need for user to run lss:50 right after creation).
  try {
    await repairNamedPage(r, title, o.name);
  } catch {}

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
  await insertAtCursor(r, formBlockBody(o), `${o.name} form block`);
  // Set properties via upsert on the inserted block (not as text in content) so they are proper block properties.
  // The #tag will also trigger auto-repair.
  try {
    await sleep(100);
    const current = await logseq.Editor.getCurrentBlock?.();
    const insertedBlockId = current ? blockId(current) : null;
    if (insertedBlockId && logseq.Editor.upsertBlockProperty) {
      for (const p of uniqueProps(o)) {
        const raw = defaultPropertyValueForCreate(p, o);
        let val = await resolveUpsertPropertyValue(p, raw);
        if (val == null && isDateProperty(p)) {
          val = toJournalDay(raw);
        }
        if (val != null) {
          await logseq.Editor.upsertBlockProperty(insertedBlockId, p, val).catch(() => {});
        }
      }
    }
  } catch {}
  r.notes.push(`Inserted ${o.name} block at the cursor. Fill relationship fields with page refs, not plain text.`);
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
