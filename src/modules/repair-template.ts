import { THROTTLE_MS } from '../config';
import { blockId, getBlocks, walkBlocks } from '../core/editor';
import { formatError, sleep } from '../core/runner';
import type { Result } from '../core/types';
import { templateDefByObjectType } from '../registry';
import type { RegistryObject } from '../registry/types';
import { parseTemplateOutline } from './templates';
import {
  isManagedPageSectionHeading,
  isObsoletePageSectionHeading,
  moveBlockAfterViaHost,
  PAGE_SECTION_HEADING_ORDER,
  PAGE_SECTION_HEADINGS,
  sectionNameFromLine,
  viewDefinitionsSafe,
} from './queries';

function normalizedSection(value: string): string {
  return String(value ?? '')
    .replace(/#Template\b/gi, '')
    .replace(/^#+\s*/, '')
    .trim()
    .toLowerCase()
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ');
}

function existingSections(blocks: any[]): Set<string> {
  const out = new Set<string>();
  for (const block of walkBlocks(blocks)) {
    const content = String(block?.content ?? '').trim();
    const section = sectionNameFromLine(content) || content;
    const key = normalizedSection(section);
    if (key) out.add(key);
  }
  return out;
}

function templateSectionNames(obj: RegistryObject): string[] {
  const template = templateDefByObjectType(obj.name);
  const seen = new Set<string>();
  const out: string[] = [];
  const querySections = new Set(
    template ? viewDefinitionsSafe(template).map((view) => normalizedSection(String(view.section ?? ''))) : [],
  );
  const add = (section: string) => {
    const clean = String(section ?? '').replace(/#Template\b/gi, '').trim();
    const key = normalizedSection(clean);
    if (!clean || !key || seen.has(key) || querySections.has(key)) return;
    seen.add(key);
    out.push(clean);
  };

  for (const section of template?.requiredSections ?? []) add(String(section));
  const outline = parseTemplateOutline(template?.body ?? '');
  for (const line of outline) {
    if (line.level !== 1) continue;
    add(line.content);
  }
  return out;
}

function findRootHeading(blocks: any[], heading: string): any | null {
  const key = normalizedSection(heading);
  return (blocks ?? []).find((block) => normalizedSection(String(block?.content ?? block?.title ?? '')) === key) ?? null;
}

function hasMeaningfulChildren(block: any): boolean {
  for (const child of block?.children ?? []) {
    const content = String(child?.content ?? child?.title ?? '').trim();
    if (content && content !== '-') return true;
    if (hasMeaningfulChildren(child)) return true;
  }
  return false;
}

async function refreshTargetPageBlocks(pageName: string, fallback: any[]): Promise<any[]> {
  const blocks = await getBlocks(pageName);
  return blocks.length ? blocks : fallback;
}

async function removeObsoleteRootHeadings(result: Result, blocks: any[], obj: RegistryObject): Promise<number> {
  if (!logseq.Editor.removeBlock) return 0;
  let removed = 0;
  for (const block of blocks ?? []) {
    const title = String(block?.content ?? block?.title ?? '');
    if (!isObsoletePageSectionHeading(title)) continue;
    if (hasMeaningfulChildren(block)) {
      result.notes.push(`Kept obsolete page heading ${title.trim()} on ${obj.name} because it contains content.`);
      continue;
    }
    const id = blockId(block);
    if (!id) continue;
    try {
      await logseq.Editor.removeBlock(id);
      result.actions.push(`REMOVE obsolete page section heading: ${obj.name} / ${title.trim()}`);
      removed++;
      await sleep(THROTTLE_MS);
    } catch (error) {
      result.errors.push(`remove obsolete page heading ${obj.name}/${title.trim()}: ${formatError(error)}`);
    }
  }
  return removed;
}

async function ensureRootHeading(
  result: Result,
  pageName: string,
  pageRootBlockId: string | null | undefined,
  blocks: any[],
  heading: string,
  obj: RegistryObject,
): Promise<{ id: string | null; inserted: number }> {
  const existing = findRootHeading(blocks, heading);
  const existingId = blockId(existing);
  if (existingId) return { id: existingId, inserted: 0 };

  let block = pageRootBlockId && logseq.Editor.insertBlock
    ? await logseq.Editor.insertBlock(pageRootBlockId, heading, {
      sibling: false,
      before: false,
      end: true,
    })
    : null;
  if (!block && logseq.Editor.appendBlockInPage) {
    block = await logseq.Editor.appendBlockInPage(pageName, heading);
  }
  const id = blockId(block);
  if (!id) {
    result.errors.push(`insert page section heading ${obj.name}/${heading}: no block returned by Logseq`);
    return { id: null, inserted: 0 };
  }
  result.actions.push(`INSERT page section heading: ${obj.name} / ${heading}`);
  await sleep(THROTTLE_MS);
  return { id, inserted: 1 };
}

function rootManagedHeadingIds(blocks: any[]): string[] {
  return (blocks ?? [])
    .filter((block) => isManagedPageSectionHeading(String(block?.content ?? block?.title ?? '')))
    .map((block) => blockId(block))
    .filter((id): id is string => Boolean(id));
}

async function ensureManagedHeadingOrder(
  result: Result,
  pageName: string,
  obj: RegistryObject,
  blocks: any[],
): Promise<number> {
  let changed = 0;
  let fresh = blocks;
  let previousId: string | null = null;
  for (const heading of PAGE_SECTION_HEADING_ORDER) {
    const current = findRootHeading(fresh, heading);
    const currentId = blockId(current);
    if (!currentId) continue;
    if (previousId) {
      const ids = rootManagedHeadingIds(fresh);
      const previousIndex = ids.indexOf(previousId);
      const currentIndex = ids.indexOf(currentId);
      if (previousIndex >= 0 && currentIndex !== previousIndex + 1) {
        const moved = await moveBlockAfterViaHost(currentId, previousId);
        if (moved.ok) {
          changed++;
          result.actions.push(`ORDER page section heading: ${obj.name} / ${heading}`);
          fresh = await refreshTargetPageBlocks(pageName, fresh);
        } else {
          result.notes.push(`Could not reorder page section heading ${obj.name}/${heading}: ${moved.error ?? 'unknown error'}.`);
        }
      }
    }
    previousId = currentId;
  }
  return changed;
}

export async function materializeTemplateSections(
  result: Result,
  pageName: string,
  obj: RegistryObject,
  blocks: any[],
  pageRootBlockId?: string | null,
): Promise<number> {
  const sections = templateSectionNames(obj);
  if (!logseq.Editor.appendBlockInPage && !logseq.Editor.insertBlock) {
    result.errors.push(`template sections ${obj.name}: no page block insert API available`);
    return 0;
  }

  const existing = existingSections(blocks);
  let inserted = 0;
  inserted += await removeObsoleteRootHeadings(result, blocks, obj);
  if (inserted) blocks = await refreshTargetPageBlocks(pageName, blocks);
  let nativeSectionsHeadingId: string | null = null;
  for (const heading of PAGE_SECTION_HEADING_ORDER) {
    const ensured = await ensureRootHeading(result, pageName, pageRootBlockId, blocks, heading, obj);
    inserted += ensured.inserted;
    if (heading === PAGE_SECTION_HEADINGS.nativeSections) nativeSectionsHeadingId = ensured.id;
    if (ensured.inserted) {
      blocks = await refreshTargetPageBlocks(pageName, blocks);
    }
  }
  const reordered = await ensureManagedHeadingOrder(result, pageName, obj, blocks);
  if (reordered) blocks = await refreshTargetPageBlocks(pageName, blocks);
  nativeSectionsHeadingId = blockId(findRootHeading(blocks, PAGE_SECTION_HEADINGS.nativeSections)) ?? nativeSectionsHeadingId;

  for (const section of sections) {
    const key = normalizedSection(section);
    if (isManagedPageSectionHeading(section)) continue;
    if (existing.has(key)) continue;
    try {
      let block = nativeSectionsHeadingId && logseq.Editor.insertBlock
        ? await logseq.Editor.insertBlock(nativeSectionsHeadingId, section, {
          sibling: false,
          before: false,
          end: true,
        })
        : null;
      if (!block && logseq.Editor.appendBlockInPage) {
        block = await logseq.Editor.appendBlockInPage(pageName, section);
      }
      if (!block) {
        await sleep(THROTTLE_MS);
        const fresh = await refreshTargetPageBlocks(pageName, blocks);
        const freshExisting = existingSections(fresh);
        if (freshExisting.has(key)) {
          existing.add(key);
          inserted++;
          result.actions.push(`INSERT template section: ${obj.name} / ${section}`);
          continue;
        }
      }
      if (!block) {
        result.errors.push(`insert template section ${obj.name}/${section}: no block returned by Logseq`);
        continue;
      }
      inserted++;
      existing.add(key);
      result.actions.push(`INSERT template section: ${obj.name} / ${section}`);
      await sleep(THROTTLE_MS);
      const sectionId = blockId(block);
      if (sectionId && logseq.Editor.insertBlock) {
        await logseq.Editor.insertBlock(sectionId, '', {
          sibling: false,
          before: false,
          end: true,
        }).catch(() => null);
      }
    } catch (error) {
      result.errors.push(`insert template section ${obj.name}/${section}: ${formatError(error)}`);
    }
  }
  if (inserted) result.notes.push(`Materialized ${inserted} template section(s) for #${obj.tag}.`);
  return inserted;
}
