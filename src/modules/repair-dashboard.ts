import { THROTTLE_MS } from '../config';
import { isDbGraph } from '../core/db-properties';
import { blockId, getBlocks, getPage, updateBlockContent, walkBlocks } from '../core/editor';
import { safePageName } from '../core/names';
import { formatError, sleep } from '../core/runner';
import type { Result } from '../core/types';
import { dashboardPageForObjectType, propertySpec, templateDefByObjectType } from '../registry';
import { markRepairCooldown, scheduleAutoRepair } from './auto-repair';
import {
  configureDbAdvancedQueryBlock,
  dashboardQueryBlockForViewAsync,
  dbAdvancedQueryBlockNeedsStructureRepair,
  filterProps,
  findAllQueryBlocksInSectionAsync,
  inspectDbQueryBlockStructure,
  pickCanonicalQueryBlock,
  queryBlockNeedsRepair,
  readDashboardQueryBlockContent,
  repairDbQueryBlockUiKeywords,
  resolveQueryClassTagId,
  sectionNameFromLine,
  viewDefinitionsSafe,
} from './queries';
import { forceCreateQueryChild } from './advanced-query-blocks';

type InferObjectType = (pageName: string, blocks: any[]) => string | null;
type RepairParentRefs = (value: string) => string[];
type ResolveVisibleNodeToken = (result: Result, token: string) => Promise<string>;

function findSectionBlocks(blocks: any[]): Map<string, any> {
  const map = new Map<string, any>();
  for (const block of walkBlocks(blocks)) {
    const section = sectionNameFromLine(block?.content);
    if (section && !map.has(section)) map.set(section, block);
  }
  return map;
}

function isPlaceholderPageRef(name: string): boolean {
  const raw = String(name ?? '').trim();
  const safe = safePageName(raw);
  return /^LSS Placeholder(?:\/| - )/i.test(raw) || /^LSS Placeholder(?:\/| - )/i.test(safe);
}

async function removeDashboardQueryBlock(
  result: Result,
  block: any,
  label: string,
): Promise<boolean> {
  const id = blockId(block);
  if (!id || !logseq.Editor.removeBlock) return false;
  try {
    await logseq.Editor.removeBlock(id);
    result.actions.push(`REMOVE duplicate dashboard query block (${label})`);
    await sleep(50);
    return true;
  } catch (error) {
    result.errors.push(`remove duplicate query block: ${formatError(error)}`);
    return false;
  }
}

export async function repairDashboardQueries(
  result: Result,
  pageName: string,
  blocks: any[],
  typeHint: string | null = null,
  sectionsFilter: Set<string> | null = null,
  inferObjectType: InferObjectType,
): Promise<number> {
  const objectType = typeHint || inferObjectType(pageName, blocks);
  if (!objectType) {
    result.notes.push(`Dashboard query repair: could not infer object type from page sections or promoted tags/properties.`);
    return 0;
  }
  const template = templateDefByObjectType(objectType);
  if (!template) {
    result.notes.push(`Dashboard query repair: no template definition found for inferred type ${objectType}.`);
    return 0;
  }
  const views = viewDefinitionsSafe(template);
  let freshBlocks = await getBlocks(pageName);
  if (!freshBlocks?.length && safePageName(pageName) !== pageName) {
    freshBlocks = await getBlocks(safePageName(pageName));
  }
  if (!freshBlocks?.length) freshBlocks = blocks;
  const sectionBlocks = findSectionBlocks(freshBlocks);
  let changed = 0;
  let checked = 0;

  const pageEntity = await getPage(pageName);

  for (const view of views) {
    const section = String(view.section ?? '').trim();
    if (!section) continue;
    if (sectionsFilter && !sectionsFilter.has(section)) continue;
    let sectionBlock = sectionBlocks.get(section);
    if (!sectionBlock) {
      if (!logseq.Editor.appendBlockInPage && !logseq.Editor.insertBlock) {
        result.errors.push(`dashboard-section ${section}: no page block insert API available`);
        continue;
      }
      try {
        if (blockId(pageEntity) && logseq.Editor.insertBlock) {
          sectionBlock = await logseq.Editor.insertBlock(blockId(pageEntity), section, {
            sibling: false,
            before: false,
            end: true,
          });
        }
        if (!sectionBlock && logseq.Editor.appendBlockInPage) {
          sectionBlock = await logseq.Editor.appendBlockInPage(pageName, section);
        }
        if (!sectionBlock) {
          result.errors.push(`insert dashboard section ${section}: no block returned by Logseq`);
          continue;
        }
        sectionBlocks.set(section, sectionBlock);
        result.actions.push(`INSERT dashboard section: ${objectType} / ${section}`);
        await sleep(THROTTLE_MS);
      } catch (error) {
        result.errors.push(`insert dashboard section ${section}: ${formatError(error)}`);
        continue;
      }
    }
    const queryContent = await dashboardQueryBlockForViewAsync(view, pageName, pageEntity);
    if (!queryContent) continue;
    const queryTitle = (view && view.sourceTags && view.sourceTags.length ? view.sourceTags[0] : section) || section;
    const existingQueries = await findAllQueryBlocksInSectionAsync(sectionBlock);
    if (existingQueries.length) {
      const canonical =
        (await pickCanonicalQueryBlock(existingQueries, queryContent)) ?? existingQueries[0];
      const canonicalId = blockId(canonical);
      const duplicateCount = existingQueries.length - 1;

      for (const existing of existingQueries) {
        if (blockId(existing) === canonicalId) continue;
        if (await removeDashboardQueryBlock(result, existing, `${objectType} / ${section}`)) {
          changed++;
        }
      }
      if (duplicateCount > 0) {
        result.notes.push(
          `Dashboard query dedupe: removed ${duplicateCount} extra query block(s) under ${section}; kept one canonical block.`,
        );
      }

      const before = await readDashboardQueryBlockContent(canonical);
      const needsContent = queryBlockNeedsRepair(before, queryContent);
      const struct = await inspectDbQueryBlockStructure(canonical);
      const needsStructure = dbAdvancedQueryBlockNeedsStructureRepair(struct);
      if (needsContent || needsStructure) {
        const hasTagButNoChild = struct.hasQueryClassTag && !struct.hasQueryProperty;
        const hasEdnButNoDisplay = struct.hasQueryClassTag && struct.hasQueryProperty && struct.childTitleHasEdn && !struct.childDisplayTypeIsCode;
        if ((hasTagButNoChild || hasEdnButNoDisplay) && (await forceCreateQueryChild(result, canonical, queryContent))) {
          result.actions.push(`FORCED/REPAIRED query child for ${objectType} / ${section}`);
          await updateBlockContent(result, canonical, queryTitle, `Set query title to ${queryTitle}`);
          changed++;
        } else {
          for (const existing of existingQueries) {
            if (await removeDashboardQueryBlock(result, existing, `${objectType} / ${section}`)) {
              changed++;
            }
          }
          if (!logseq.Editor.insertBlock) {
            result.errors.push(`dashboard-query: insertBlock unavailable for ${section}`);
          } else {
            const fresh = await logseq.Editor.insertBlock(
              blockId(sectionBlock),
              queryTitle,
              { sibling: false, before: false, end: true },
            );
            if (fresh) {
              const freshId = blockId(fresh);
              const queryTagId = await resolveQueryClassTagId();
              if (queryTagId) {
                await logseq.Editor.addBlockTag(freshId, queryTagId).catch(() => {});
              }
              await sleep(20);
              const configured = await configureDbAdvancedQueryBlock(result, fresh, queryContent);
              if (configured) {
                result.actions.push(`REBUILT advanced query from scratch for ${objectType} / ${section}`);
                await updateBlockContent(result, fresh, queryTitle, `Set query title to ${queryTitle}`);
                changed++;
              } else {
                await sleep(120);
                const configured2 = await configureDbAdvancedQueryBlock(result, fresh, queryContent);
                if (configured2) {
                  result.actions.push(`REBUILT + retry configured for ${objectType} / ${section}`);
                  await updateBlockContent(result, fresh, queryTitle, `Set query title to ${queryTitle}`);
                  changed++;
                } else {
                  await repairDbQueryBlockUiKeywords(result, fresh);
                  const recheck = await inspectDbQueryBlockStructure(fresh);
                  if (recheck.childDisplayTypeIsCode) {
                    result.actions.push(`SET :code via post-rebuild keywords repair for ${objectType} / ${section}`);
                    changed++;
                  } else {
                    result.notes.push(
                      `Fresh shell created for ${objectType} / ${section} (auto-repair will finalize :code)`,
                    );
                    try {
                      scheduleAutoRepair(pageName);
                    } catch {
                      /* non-critical background scheduling */
                    }
                  }
                }
              }
            }
          }
        }
      } else {
        checked++;
      }
    } else if (logseq.Editor.insertBlock) {
      try {
        const isDb = await isDbGraph();
        const shellContent = isDb ? queryTitle : queryContent;
        const inserted = await logseq.Editor.insertBlock(
          blockId(sectionBlock),
          shellContent,
          {
            sibling: false,
            before: false,
            end: true,
          },
        );
        result.actions.push(`INSERT dashboard query shell: ${objectType} / ${section}`);
        changed++;
        if (isDb && inserted && queryContent) {
          let ok = await configureDbAdvancedQueryBlock(result, inserted, queryContent);
          if (!ok) {
            await sleep(150);
            ok = await configureDbAdvancedQueryBlock(result, inserted, queryContent);
          }
          if (ok) {
            result.actions.push(`CONFIGURED advanced query after insert for ${objectType} / ${section}`);
            await updateBlockContent(result, inserted, queryTitle, `Set query title to ${queryTitle}`);
          } else {
            await repairDbQueryBlockUiKeywords(result, inserted);
            await sleep(100);
            const recheck = await inspectDbQueryBlockStructure(inserted);
            if (!dbAdvancedQueryBlockNeedsStructureRepair(recheck)) {
              result.actions.push(`RECOVERED query structure via keywords + recheck for ${objectType} / ${section}`);
              await updateBlockContent(result, inserted, queryTitle, `Set query title to ${queryTitle}`);
            } else {
              result.notes.push(`configure after first insert needed extra pass for ${objectType} / ${section} (auto-repair will help)`);
              try {
                scheduleAutoRepair(pageName);
              } catch {
                /* non-critical background scheduling */
              }
            }
          }
        } else if (inserted && !isDb) {
          await updateBlockContent(result, inserted, queryTitle, `Set query title to ${queryTitle}`);
        }
      } catch (error) {
        result.errors.push(`insert dashboard query ${section}: ${formatError(error)}`);
      }
    } else {
      result.errors.push(`dashboard-query ${section}: logseq.Editor.insertBlock API unavailable`);
    }
  }

  result.notes.push(
    `Dashboard query repair: inferred ${objectType}; changed/inserted ${changed} query block(s), checked ${checked} existing query block(s).`,
  );
  return changed;
}

export async function repairLinkedParentDashboards(
  result: Result,
  props: Map<string, string>,
  objectType: string | null,
  currentPage: string,
  repairPageRefsFromValue: RepairParentRefs,
  resolveVisibleNodeToken: ResolveVisibleNodeToken,
  inferObjectType: InferObjectType,
): Promise<number> {
  let total = 0;
  const repairedKeys = new Set<string>();
  const skippedPlaceholders = new Set<string>();

  for (const [prop, rawValue] of props.entries()) {
    const spec = propertySpec(prop);
    if (String(spec?.type ?? '').toLowerCase() !== 'node') continue;
    const refs = repairPageRefsFromValue(rawValue);
    if (!refs.length) continue;

    const targets = ((spec as { targets?: unknown[] } | undefined)?.targets ?? []).map(String).filter(Boolean);
    for (const targetType of targets) {
      const dashboard = dashboardPageForObjectType(targetType);
      const template = templateDefByObjectType(targetType);
      if (!dashboard || !template) continue;
      const sections = new Set<string>();
      for (const view of viewDefinitionsSafe(template)) {
        if (view.dashboard !== dashboard) continue;
        if ((view.filters ?? []).some((filter) => filterProps(filter).includes(prop))) {
          sections.add(String(view.section ?? '').trim());
        }
      }
      if (!sections.size) continue;

      for (const ref of refs) {
        const parentName = await resolveVisibleNodeToken(result, ref);
        if (isPlaceholderPageRef(parentName)) {
          if (!skippedPlaceholders.has(parentName)) {
            result.notes.push(`SKIP linked parent repair for placeholder [[${parentName}]].`);
            skippedPlaceholders.add(parentName);
          }
          continue;
        }
        const key = `${targetType}:${parentName}:${[...sections].sort().join('|')}`;
        if (repairedKeys.has(key)) continue;
        repairedKeys.add(key);
        result.notes.push(
          `Linked parent repair: ${objectType ?? 'object'} ${currentPage} points to ${targetType} [[${parentName}]] via ${prop}; refreshing ${[...sections].join(', ')}.`,
        );
        const parentBlocks = await getBlocks(parentName);
        total += await repairDashboardQueries(result, parentName, parentBlocks, targetType, sections, inferObjectType);
        markRepairCooldown(parentName);
      }
    }
  }
  return total;
}
