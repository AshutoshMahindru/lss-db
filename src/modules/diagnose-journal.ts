import { blockId, getBlocks, getPage, pageVisibleName, walkBlocks } from '../core/editor';
import { safePageName, safeTag, visiblePageLabel } from '../core/names';
import { allObjects } from '../registry';

type MaterializedRef = {
  pageName: string;
  markerFound: boolean;
};

function pageRecordIsJournal(page: any, pageName: string): boolean {
  if (!page) return false;
  const type = String(page.type ?? page[':block/type'] ?? '').toLowerCase();
  if (type === 'journal') return true;
  if (page.journal === true || page['journal?'] === true || page[':block/journal?'] === true) return true;
  if (page.journalDay != null || page['journal-day'] != null || page[':block/journal-day'] != null) return true;
  const name = pageVisibleName(page, pageName);
  return /^\d{4}[-_/]\d{2}[-_/]\d{2}$/.test(name) || /^\d{8}$/.test(name);
}

function blockTagName(tag: unknown): string | null {
  if (typeof tag === 'string') return safeTag(tag);
  if (tag && typeof tag === 'object') {
    const record = tag as Record<string, unknown>;
    const name = record.name ?? record.originalName ?? record.title ?? record.ident;
    if (name) return safeTag(String(name));
  }
  return null;
}

function pageRefsInText(text: string): string[] {
  const refs = new Set<string>();
  const whole = visiblePageLabel(String(text ?? '').trim());
  if (whole && whole !== String(text ?? '').trim() && !whole.includes('[[') && !whole.includes(']]')) {
    refs.add(whole);
  }
  const re = /\[\[([^\]]+)\]\]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(String(text ?? '')))) {
    if (match[1]) refs.add(visiblePageLabel(match[1]));
  }
  return [...refs].filter(Boolean);
}

function lssEntityTagLookup(): Map<string, string> {
  const byTag = new Map<string, string>();
  for (const obj of allObjects()) {
    if (obj.nodeKind !== 'page') continue;
    for (const token of [obj.tag, obj.name, ...(obj.aliases ?? [])]) {
      const key = safeTag(token).toLowerCase();
      if (key) byTag.set(key, obj.name);
    }
  }
  return byTag;
}

function lssObjectsFromBlock(block: any, lookup: Map<string, string>): string[] {
  const names = new Set<string>();
  const collect = (raw: unknown) => {
    const tag = safeTag(String(raw ?? '')).toLowerCase();
    const found = lookup.get(tag);
    if (found) names.add(found);
  };

  const tags = block?.tags ?? block?.properties?.tags;
  if (Array.isArray(tags)) {
    for (const tag of tags) {
      const name = blockTagName(tag);
      if (name) collect(name);
    }
  } else if (tags) {
    const name = blockTagName(tags);
    if (name) collect(name);
  }

  const text = String(block?.content ?? block?.title ?? '');
  const re = /#(?:\[\[([^\]]+?)\]\]|([A-Za-z0-9_ -]+))/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) collect(match[1] || match[2]);

  return [...names].sort();
}

function shortBlockText(block: any): string {
  const text = String(block?.content ?? block?.title ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '(empty)';
  return text.length > 140 ? `${text.slice(0, 140)}...` : text;
}

async function linkedMaterializedRefs(sourceBlockId: string, refs: string[]): Promise<MaterializedRef[]> {
  const out: MaterializedRef[] = [];
  const marker = `lss-managed:journal-materialized-${sourceBlockId}`;
  for (const ref of refs) {
    const page =
      (await getPage(ref)) ||
      (await getPage(safePageName(ref))) ||
      (await getPage(ref.toLowerCase()));
    const visible = pageVisibleName(page as Record<string, unknown> | null, ref) || ref;
    const blocks = (await getBlocks(visible)) || (safePageName(visible) !== visible ? await getBlocks(safePageName(visible)) : []);
    const markerFound = walkBlocks(blocks).some((block) => String(block?.content ?? block?.title ?? '').includes(marker));
    out.push({ pageName: visible, markerFound });
  }
  return out;
}

export async function diagnoseJournalMaterialization(
  pageName: string,
  page: any,
  blocks: any[],
): Promise<string[]> {
  if (!pageRecordIsJournal(page, pageName)) return [];

  const lines: string[] = ['## Journal materialization', 'journal-page:: yes'];
  const lookup = lssEntityTagLookup();
  const findings: string[] = [];

  for (const block of walkBlocks(blocks)) {
    const id = blockId(block);
    const content = String(block?.content ?? block?.title ?? '');
    const objects = lssObjectsFromBlock(block, lookup);
    const refs = pageRefsInText(content);
    const materializedRefs = id ? await linkedMaterializedRefs(String(id), refs) : [];
    const markerRefs = materializedRefs.filter((ref) => ref.markerFound);
    if (!objects.length && !markerRefs.length) continue;

    const identity = id ? String(id) : '(no block id)';
    const objectLabel = objects.length ? `#${objects.join(', #')}` : '(tag cleaned)';
    const source = shortBlockText(block);

    if (markerRefs.length) {
      const refsText = markerRefs.map((ref) => `[[${safePageName(ref.pageName)}]]`).join(', ');
      const suffix = objects.length ? '; source block still has LSS tag(s), run lss: materialise page to clean it' : '';
      findings.push(`- block ${identity}: materialized as ${refsText} ${objectLabel}${suffix}`);
      findings.push(`  - source:: ${source}`);
      continue;
    }

    if (objects.length) {
      const refNote = materializedRefs.length
        ? ` linked page(s) without materialization marker: ${materializedRefs.map((ref) => `[[${safePageName(ref.pageName)}]]`).join(', ')}`
        : ' no materialized page link found';
      findings.push(`- block ${identity}: pending materialization ${objectLabel};${refNote}`);
      findings.push(`  - source:: ${source}`);
    }
  }

  if (!findings.length) {
    lines.push('- No LSS entity-tagged journal blocks or materialization markers found.');
  } else {
    lines.push(`journal-materialization-findings:: ${findings.filter((line) => line.startsWith('- block ')).length}`);
    lines.push(...findings);
  }

  const needsAction = findings.some(
    (line) => line.includes('pending materialization') || line.includes('source block still has LSS tag'),
  );
  if (needsAction) {
    lines.push('- action: run lss: materialise page on this journal to materialize pending entity blocks and clean stale source tags.');
  }
  return lines;
}
