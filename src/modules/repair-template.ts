import { THROTTLE_MS } from '../config';
import { blockId, getBlocks, walkBlocks } from '../core/editor';
import { formatError, sleep } from '../core/runner';
import type { Result } from '../core/types';
import { templateDefByObjectType } from '../registry';
import type { RegistryObject } from '../registry/types';
import { parseTemplateOutline } from './templates';
import { sectionNameFromLine, viewDefinitionsSafe } from './queries';

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

export async function materializeTemplateSections(
  result: Result,
  pageName: string,
  obj: RegistryObject,
  blocks: any[],
  pageRootBlockId?: string | null,
): Promise<number> {
  const sections = templateSectionNames(obj);
  if (!sections.length) return 0;
  if (!logseq.Editor.appendBlockInPage && !logseq.Editor.insertBlock) {
    result.errors.push(`template sections ${obj.name}: no page block insert API available`);
    return 0;
  }

  const existing = existingSections(blocks);
  let inserted = 0;
  for (const section of sections) {
    const key = normalizedSection(section);
    if (existing.has(key)) continue;
    try {
      let block = pageRootBlockId && logseq.Editor.insertBlock
        ? await logseq.Editor.insertBlock(pageRootBlockId, section, {
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
        const fresh = await getBlocks(pageName);
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
