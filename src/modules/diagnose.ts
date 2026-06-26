import { MODE, VERSION } from '../config';
import {
  canonicalPropertyKey,
  entityIdentity,
  getCanonicalProp,
  isDbGraph,
  isDbPageRefValue,
  pageHasClassTag,
  readRelationshipPropertyValue,
  resolvePropertyQueryName,
} from '../core/db-properties';
import {
  appendManagedBlock,
  blockId,
  currentPageName,
  ensurePage,
  getBlocks,
  getPage,
  pageVisibleName,
  resolvePageFromIdentity,
  walkBlocks,
} from '../core/editor';
import { looksLikeUuid, safePageName, safeTag, tagObjectLabel, tsKey, visiblePageLabel } from '../core/names';
import type { Result } from '../core/types';
import { allObjects, objectByName, templateDefByObjectType } from '../registry';
import { diagnoseJournalMaterialization } from './diagnose-journal';
import { diagnoseNativeTagSchemaProperties } from './diagnose-native-tags';
import { runLiveQueryProbe, summarizeDatascriptEntity } from './diagnose-query-probes';
import {
  dashboardQueryBlockForViewAsync,
  datascriptInspectBlock,
  findAllQueryBlocksInSectionAsync,
  findQueryBlockInSection,
  hostQueryRepairScriptsReady,
  pickCanonicalQueryBlock,
  readDashboardQueryBlockContent,
  readQueryChildDisplayTypeRaw,
  sectionNameFromLine,
  dbAdvancedQueryBlockNeedsStructureRepair,
  inspectDbQueryBlockStructure,
  isAdvancedQueryBlockContent,
  queryBodyFromBlockContent,
  queryBlockNeedsRepair,
  queriesEquivalent,
  viewDefinitionsSafe,
} from './queries';

function formatValue(value: unknown): string {
  if (value == null) return '(empty)';
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

async function readAllPageProperties(pageName: string, pageBlockId: string): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const assignCanonical = (src: Record<string, unknown> | null | undefined) => {
    if (!src) return;
    for (const [key, value] of Object.entries(src)) {
      const shortKey = canonicalPropertyKey(key);
      if (shortKey === 'tags') continue;
      out[shortKey] = value;
    }
  };
  const names = new Set(
    [pageName, visiblePageLabel(pageName), pageName.toLowerCase(), safePageName(pageName)].filter(Boolean),
  );
  for (const name of names) {
    const page = await getPage(name);
    if (page?.properties) assignCanonical(page.properties as Record<string, unknown>);
  }
  if (logseq.Editor.getPageProperties) {
    for (const name of names) {
      assignCanonical((await logseq.Editor.getPageProperties(name).catch(() => null)) ?? undefined);
    }
  }
  if (logseq.Editor.getBlockProperties) {
    assignCanonical((await logseq.Editor.getBlockProperties(pageBlockId).catch(() => null)) ?? undefined);
  }
  if (logseq.Editor.getBlock) {
    const block = await logseq.Editor.getBlock(pageBlockId).catch(() => null);
    if (block?.properties) assignCanonical(block.properties as Record<string, unknown>);
  }
  return out;
}

function pickFirstPropertyField(...sources: Array<Record<string, unknown> | null | undefined>): unknown {
  const keys = [
    'type',
    'cardinality',
    ':logseq.property/type',
    'logseq.property/type',
    ':logseq.property/cardinality',
    'logseq.property/cardinality',
    ':logseq.property/node-tags',
    'logseq.property/node-tags',
    ':logseq.property/classes',
    'logseq.property/classes',
  ];
  const out: Record<string, unknown> = {};
  for (const src of sources) {
    if (!src) continue;
    for (const key of keys) {
      if (src[key] != null && out[key] == null) out[key] = src[key];
    }
  }
  return out;
}

async function nativePropertyDebugLines(name: string): Promise<string[]> {
  const lines: string[] = [];
  if (!logseq.Editor.getProperty) {
    lines.push(`${name}-native-property:: getProperty unavailable`);
    return lines;
  }
  const prop = (await logseq.Editor.getProperty(name).catch(() => null)) as Record<string, unknown> | null;
  if (!prop) {
    lines.push(`${name}-native-property:: missing`);
    return lines;
  }
  const identity = entityIdentity(prop);
  const blockProps =
    identity != null && logseq.Editor.getBlockProperties
      ? ((await logseq.Editor.getBlockProperties(identity as any).catch(() => null)) as Record<string, unknown> | null)
      : null;
  const propProps = (prop.properties as Record<string, unknown> | undefined) ?? null;
  lines.push(`${name}-native-property:: present`);
  lines.push(`${name}-native-id:: ${formatValue(prop.id)}`);
  lines.push(`${name}-native-uuid:: ${formatValue(prop.uuid)}`);
  lines.push(`${name}-native-ident:: ${formatValue(prop.ident)}`);
  lines.push(`${name}-native-summary:: ${formatValue(pickFirstPropertyField(prop, propProps, blockProps))}`);
  lines.push(`${name}-native-property-keys:: ${Object.keys(propProps ?? {}).sort().join(', ') || '(none)'}`);
  lines.push(`${name}-native-block-property-keys:: ${Object.keys(blockProps ?? {}).sort().join(', ') || '(none)'}`);
  return lines;
}

function isSetupFunctionTagNoise(name: string, props: Record<string, unknown>): boolean {
  const label = visiblePageLabel(name);
  if (getCanonicalProp(props, 'lss-kind') != null) return true;
  if (/^(Entity-Page|DB Tag|Tag Properties|Template|Word Extender|LSS Reports|Area)(?:\b| - |:)/i.test(safePageName(label))) return true;
  if (/Entity Schema Page|Naming Rule|Template Reference|Tag Properties:/i.test(label)) return true;
  return false;
}

async function detectClassTags(pageBlockId: string): Promise<string[]> {
  const hits: string[] = [];
  const identity = entityIdentity(pageBlockId);
  if (!identity) return hits;
  for (const obj of allObjects()) {
    const tag = safeTag(obj.tag);
    if (tag && (await pageHasClassTag(identity, tag))) hits.push(tag);
  }
  return hits;
}

function ventureNamesMatch(candidate: string, venturePageName: string): boolean {
  const raw = candidate.trim().toLowerCase();
  if (!raw) return false;
  const name = venturePageName.toLowerCase();
  const safe = safePageName(venturePageName).toLowerCase();
  if (raw === name || raw === safe) return true;
  const wiki = raw.match(/^\[\[([^\]]+)\]\]$/);
  if (wiki?.[1]) {
    const inner = wiki[1].trim().toLowerCase();
    return inner === name || inner === safe;
  }
  return false;
}

function ventureItemIsPageRef(item: unknown, venturePageName: string, venturePageId: unknown): boolean {
  if (item == null) return false;
  if (typeof item === 'number') {
    return venturePageId != null && item === venturePageId;
  }
  if (typeof item === 'object') {
    const record = item as Record<string, unknown>;
    const id = record.id;
    if (id != null && venturePageId != null && String(id) === String(venturePageId)) return true;
    const name = pageVisibleName(record);
    return name ? ventureNamesMatch(name, venturePageName) : false;
  }
  const raw = String(item).trim();
  if (!raw) return false;
  if (/^\d+$/.test(raw) && venturePageId != null) return String(raw) === String(venturePageId);
  if (ventureNamesMatch(raw, venturePageName)) return raw.startsWith('[[');
  return false;
}

function ventureValueIsPageRef(value: unknown, venturePageName: string, venturePageId: unknown): boolean {
  if (value == null) return false;
  if (Array.isArray(value)) {
    return value.some((item) => ventureItemIsPageRef(item, venturePageName, venturePageId));
  }
  return ventureItemIsPageRef(value, venturePageName, venturePageId);
}

async function resolveVenturePageFromValue(...values: unknown[]): Promise<Record<string, unknown> | null> {
  const tryName = async (name: string): Promise<Record<string, unknown> | null> => {
    const raw = name.trim();
    if (!raw) return null;
    const page =
      (await getPage(raw)) ||
      (await getPage(safePageName(raw))) ||
      (await getPage(raw.toLowerCase()));
    return (page as Record<string, unknown> | null) ?? null;
  };

  const resolveItem = async (item: unknown): Promise<Record<string, unknown> | null> => {
    if (item == null) return null;
    if (typeof item === 'object') {
      const record = item as Record<string, unknown>;
      const id = record.id;
      if (id != null) {
        const byId =
          (await resolvePageFromIdentity(id as string | number)) ||
          (await tryName(pageVisibleName(record)));
        if (byId) return byId as Record<string, unknown>;
      }
      const name = pageVisibleName(record);
      return name ? await tryName(name) : null;
    }
    const raw = String(item).trim();
    if (!raw) return null;
    if (/^\d+$/.test(raw)) return (await resolvePageFromIdentity(raw)) as Record<string, unknown> | null;
    const wiki = raw.match(/^\[\[([^\]]+)\]\]$/);
    if (wiki?.[1]) return await tryName(wiki[1]);
    return await tryName(raw);
  };

  for (const value of values) {
    if (Array.isArray(value)) {
      for (const item of value) {
        const page = await resolveItem(item);
        if (page) return page;
      }
      continue;
    }
    const page = await resolveItem(value);
    if (page) return page;
  }
  return null;
}

async function diagnoseFunctionCandidates(venturePageName: string): Promise<string[]> {
  const lines: string[] = [];
  if (!logseq.Editor.getTagObjects) {
    lines.push('- getTagObjects API unavailable');
    return lines;
  }

  const venturePage = await getPage(venturePageName);
  const venturePageId = (venturePage as Record<string, unknown> | null)?.id;
  const functions = await logseq.Editor.getTagObjects('Function').catch(() => null);
  if (!functions?.length) {
    lines.push('- No pages found with class tag #Function');
    return lines;
  }

  for (const fn of functions) {
    const record = fn as Record<string, unknown>;
    const fnBlockId = blockId(fn);
    if (!fnBlockId) {
      lines.push(`- ${String(record.uuid ?? 'unknown')}: could not read page block id`);
      continue;
    }
    const tagLabel = tagObjectLabel(record);
    const fnPage =
      (tagLabel && !looksLikeUuid(tagLabel) ? await getPage(tagLabel) : null) ||
      (record.id != null ? await resolvePageFromIdentity(record.id as string | number) : null) ||
      (await resolvePageFromIdentity(fnBlockId));
    const displayName =
      tagObjectLabel(fnPage as Record<string, unknown> | null) ||
      (tagLabel && !looksLikeUuid(tagLabel) ? tagLabel : '') ||
      String(record.uuid ?? 'unknown');
    const props = await readAllPageProperties(displayName, fnBlockId);
    if (isSetupFunctionTagNoise(displayName, props)) continue;
    const objectType = getCanonicalProp(props, 'lss-object-type');
    const venture =
      (await readRelationshipPropertyValue(fnBlockId, 'venture')) ?? getCanonicalProp(props, 'venture');
    const typeOk = String(objectType).includes('Function');
    const ventureIsRef = isDbPageRefValue(venture);
    const venturePointsToParent = ventureValueIsPageRef(venture, venturePageName, venturePageId);
    const ventureOk = ventureIsRef && venturePointsToParent;
    const match = typeOk && ventureOk;
    lines.push(
      `- ${displayName}: entity-id=${formatValue(record.id)} uuid=${formatValue(record.uuid)} class=#Function lss-object-type=${formatValue(objectType)} venture=${formatValue(venture)} => ${match ? 'SHOULD MATCH' : 'will NOT match'}`,
    );
    if (match && looksLikeUuid(String(record.uuid ?? ''))) {
      const pulled = await datascriptInspectBlock(String(record.uuid));
      const attrs = summarizeDatascriptEntity(pulled);
      lines.push(`  - datascript-attrs: ${attrs}`);
      if (!/lss-object-type/i.test(attrs)) {
        lines.push(
          '  - note: lss-object-type is not indexed on this page; DB dashboard queries use (tags Function) + (property venture)',
        );
      }
    }
    if (!typeOk) lines.push(`  - fix: set lss-object-type to Function (not just #Function tag)`);
    if (!ventureIsRef) {
      lines.push(
        `  - fix: pick venture [[${safePageName(venturePageName)}]] from the dropdown (stores page id, not typed text)`,
      );
    } else if (!venturePointsToParent) {
      lines.push(`  - fix: venture page ref does not point to [[${safePageName(venturePageName)}]]`);
    }
  }
  return lines;
}

async function pageHasIncomingFunctionReference(pageName: string, pageId: unknown): Promise<boolean> {
  if (!logseq.Editor.getTagObjects) return false;
  const functions = await logseq.Editor.getTagObjects('Function').catch(() => null);
  for (const fn of functions ?? []) {
    const fnBlockId = blockId(fn);
    if (!fnBlockId) continue;
    const props = await readAllPageProperties(String(tagObjectLabel(fn as Record<string, unknown>) || fnBlockId), fnBlockId);
    if (isSetupFunctionTagNoise(String(tagObjectLabel(fn as Record<string, unknown>) || ''), props)) continue;
    const relationshipValue = await readRelationshipPropertyValue(fnBlockId, 'venture');
    const visibleValue = getCanonicalProp(props, 'venture');
    if (
      ventureValueIsPageRef(relationshipValue, pageName, pageId) ||
      ventureValueIsPageRef(visibleValue, pageName, pageId)
    ) {
      return true;
    }
  }
  return false;
}

export async function diagnoseCurrentPage(r: Result): Promise<void> {
  const pageName = await currentPageName();
  if (!pageName) {
    r.errors.push('No current page detected. Open FTV or Marketing and rerun.');
    return;
  }

  const page = await getPage(pageName);
  if (!page) {
    r.errors.push(`Could not read page: ${pageName}`);
    return;
  }

  const visibleName = pageVisibleName(page, pageName) || pageName;
  const pageBlockId = blockId(page);
  if (!pageBlockId) {
    r.errors.push(`Page has no uuid/id: ${visibleName}`);
    return;
  }

  const blocks = await getBlocks(visibleName);
  const props = await readAllPageProperties(visibleName, pageBlockId);
  const classTags = await detectClassTags(pageBlockId);
  const objectType = String(getCanonicalProp(props, 'lss-object-type') ?? '(missing)');
  const rawVenture = getCanonicalProp(props, 'venture');
  const relationshipVenture = await readRelationshipPropertyValue(pageBlockId, 'venture');
  const venture = relationshipVenture ?? rawVenture;
  const dbGraph = await isDbGraph();

  const lines: string[] = [];
  lines.push(`# LSS Diagnose: ${visibleName}`);
  lines.push('');
  lines.push(`checked-at:: ${new Date().toISOString()}`);
  lines.push(`plugin-version:: ${VERSION}`);
  lines.push(`db-graph:: ${dbGraph ? 'yes' : 'no'}`);
  lines.push(`page:: ${visibleName}`);
  lines.push(`page-uuid:: ${pageBlockId}`);
  lines.push(`page-id:: ${formatValue((page as Record<string, unknown>).id)}`);
  lines.push('');
  lines.push('## Class tags (DB)');
  if (classTags.length) {
    for (const tag of classTags) lines.push(`- #${tag}`);
  } else {
    lines.push('- (none detected via getTagObjects)');
  }
  lines.push('');
  if (dbGraph) {
    lines.push(...(await diagnoseNativeTagSchemaProperties()));
    lines.push('');
  }
  lines.push('## Page properties (DB API)');
  if (Object.keys(props).length) {
    for (const [key, value] of Object.entries(props).sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`- ${key}:: ${formatValue(value)}`);
    }
  } else {
    lines.push('- (none returned by getPageProperties/getBlockProperties)');
  }
  lines.push('');
  const journalMaterializationLines = await diagnoseJournalMaterialization(visibleName, page, blocks);
  if (journalMaterializationLines.length) {
    lines.push(...journalMaterializationLines);
    lines.push('');
  }
  const taggedObject = classTags.map((tag) => objectByName(tag)).find(Boolean);
  const incomingFunctionReference = await pageHasIncomingFunctionReference(
    visibleName,
    (page as Record<string, unknown>).id,
  );
  const inferredType =
    taggedObject?.name ??
    (objectType.includes('Function')
      ? 'Function'
      : objectType.includes('Venture')
        ? 'Venture'
        : classTags.includes('Function')
          ? 'Function'
          : classTags.includes('Venture')
            ? 'Venture'
            : incomingFunctionReference
              ? 'Venture'
              : null);
  if (incomingFunctionReference && inferredType === 'Venture' && !classTags.includes('Venture')) {
    lines.push('- Inference: Function pages point their venture property at this page; run lss: materialise page to bootstrap #Venture and page properties.');
    lines.push('');
  }

  lines.push('## Query requirements');
  if (inferredType === 'Venture') {
    lines.push('- Functions list requires child pages with:');
    lines.push('  - class tag #Function (DB queries use (tags Function))');
    lines.push(`  - venture = numeric page id [${formatValue((page as Record<string, unknown>).id)}] (use venture dropdown; not typed text)`);
    lines.push('- lss-object-type property alone is NOT enough unless indexed; prefer #Function + venture.');
  } else if (inferredType === 'Function') {
    lines.push('- This Function must appear on a parent Venture Functions query when:');
    lines.push('  - lss-object-type = Function');
    lines.push('  - venture = page link to the parent Venture (e.g. [[ftv]]), not typed text like "FTV"');
    lines.push('- Run repair on this page to convert venture text into a page reference.');
  } else {
    lines.push('- Venture Functions queries require child Function pages with lss-object-type and venture page links.');
  }
  lines.push('');

  if (inferredType === 'Venture' || classTags.includes('Venture')) {
    lines.push('## Property query idents');
    lines.push(`venture-ident:: ${await resolvePropertyQueryName('venture')}`);
    lines.push(`lss-object-type-ident:: ${await resolvePropertyQueryName('lss-object-type')}`);
    lines.push('');
    lines.push('## Venture / Functions section');
    const hostScripts = await hostQueryRepairScriptsReady();
    lines.push(`host-scope:: ${hostScripts.hostScope ? 'yes' : 'no'}`);
    lines.push(`host-logseq-api:: ${hostScripts.hostLogseqApi ? 'yes' : 'no'}`);
    lines.push(`host-to-keyword:: ${hostScripts.hostToKeyword ? 'yes' : 'no'}`);
    lines.push(`host-function:: ${hostScripts.hostFunction ? 'yes' : 'no'}`);
    lines.push(`host-inline-runner-capable:: ${hostScripts.hostInlineRunnerCapable ? 'yes' : 'no'}`);
    lines.push(`host-keyword-script-ready:: ${hostScripts.keyword ? 'yes' : 'no'}`);
    lines.push(`host-query-setup-ready:: ${hostScripts.querySetup ? 'yes' : 'no'}`);
    let actual: string | null = null;
    for (const block of walkBlocks(blocks)) {
      if (sectionNameFromLine(String(block?.content ?? '')) !== 'Functions') continue;
      const sectionQueries = await findAllQueryBlocksInSectionAsync(block);
      const queryBlock =
        sectionQueries[0] ??
        findQueryBlockInSection(block);
      if (queryBlock) {
        const content = await readDashboardQueryBlockContent(queryBlock);
        if (content) actual = content;
      }
      break;
    }
    const template = templateDefByObjectType('Venture');
    const view = viewDefinitionsSafe(template ?? ({} as any)).find((v) => v.section === 'Functions');
    const expectedBlock = view ? await dashboardQueryBlockForViewAsync(view, visibleName, page) : null;
    const venturePageId = (page as Record<string, unknown>).id as string | number | undefined;
    const actualBody = actual ? queryBodyFromBlockContent(actual) : null;
    const expectedBody = expectedBlock ? queryBodyFromBlockContent(expectedBlock) : null;
    lines.push(`actual-query:: ${actualBody ?? actual ?? '(missing)'}`);
    lines.push(`expected-query:: ${expectedBody ?? '(could not derive)'}`);
    if (expectedBlock) {
      lines.push(
        `expected-query-format:: ${isAdvancedQueryBlockContent(expectedBlock) ? 'advanced' : 'simple'}`,
      );
    }
    for (const block of walkBlocks(blocks)) {
      if (sectionNameFromLine(String(block?.content ?? '')) !== 'Functions') continue;
      const sectionQueries = await findAllQueryBlocksInSectionAsync(block);
      if (sectionQueries.length > 1) {
        lines.push(
          `- NOTE: multiple query blocks under Functions (${sectionQueries.length}); run lss: materialise page to dedupe to one canonical block per section`,
        );
      }
      const queryBlock =
        expectedBlock && sectionQueries.length
          ? (await pickCanonicalQueryBlock(sectionQueries, expectedBlock)) ?? sectionQueries[0]
          : findQueryBlockInSection(block);
      if (queryBlock) {
        const struct = await inspectDbQueryBlockStructure(queryBlock);
        lines.push(`query-block-has-query-tag:: ${struct.hasQueryClassTag ? 'yes' : 'no'}`);
        lines.push(`query-block-has-query-property:: ${struct.hasQueryProperty ? 'yes' : 'no'}`);
        lines.push(`query-block-has-code-child:: ${struct.hasCodeChild ? 'yes' : 'no'}`);
        lines.push(`query-child-title-has-edn:: ${struct.childTitleHasEdn ? 'yes' : 'no'}`);
        lines.push(`query-child-created-from-query:: ${struct.childCreatedFromQueryProperty ? 'yes' : 'no'}`);
        lines.push(`query-child-display-type-code:: ${struct.childDisplayTypeIsCode ? 'yes' : 'no'}`);
        lines.push(`query-child-display-type-raw:: ${await readQueryChildDisplayTypeRaw(queryBlock)}`);

        // Ensure actual is populated for the report / live probe even if the early read missed it
        // (e.g. snapshot props vs fresh getBlockProperties differences)
        if (!actual) {
          try {
            const cc = await readDashboardQueryBlockContent(queryBlock);
            if (cc) actual = cc;
          } catch {}
          // last resort scan
          if (!actual && Array.isArray(queryBlock?.children)) {
            for (const ch of queryBlock.children) {
              const cc = String(ch?.content ?? ch?.title ?? '').trim();
              if (isAdvancedQueryBlockContent(cc)) {
                actual = cc;
                break;
              }
            }
          }
        }
        if (!hostScripts.keyword) {
          if (!hostScripts.hostInlineRunnerCapable) {
            lines.push(
              '- UI-BLOCKER: host inline keyword runner unavailable (need host scope + logseq.api.upsert_block_property + sdk.utils.to_keyword + host Function)',
            );
          } else {
            lines.push(
              '- UI-BLOCKER: host keyword helper not installed — reload plugin then run lss: materialise page (inline host install failed; Experiments.loadScripts is optional fallback)',
            );
          }
        }
        if (struct.parentCollapsed) {
          lines.push('query-parent-collapsed:: yes');
        }
        if (struct.rawEdnInParentContent) {
          lines.push('query-block-raw-edn-in-parent:: yes');
        }
        if (!struct.childTitleHasEdn) {
          lines.push(
            '- UI-BLOCKER: Logseq reads query EDN from the code child block/title; child title is empty so Functions UI stays blank even when datascript probes hit',
          );
        }
        if (!struct.childDisplayTypeIsCode) {
          lines.push(
            '- UI-BLOCKER: code child needs logseq.property.node/display-type = :code (cljs keyword); plugin IPC cannot set this — run lss: materialise page after reload (host inline upsert applies :code without manual /Advanced Query)',
          );
        }
        if (!struct.childCreatedFromQueryProperty) {
          lines.push(
            '- UI-BLOCKER: code child is visible because it is not marked as the query property child; reload plugin, then run lss: materialise page.',
          );
        }
        lines.push(
          `query-needs-structure-repair:: ${dbAdvancedQueryBlockNeedsStructureRepair(struct) ? 'yes' : 'no'}`,
        );
        if (dbAdvancedQueryBlockNeedsStructureRepair(struct)) {
          lines.push(
            '- FIX: run lss: materialise page to convert to Logseq DB /Advanced Query structure (#Query tag + logseq.property/query code child)',
          );
          lines.push(
            '- MANUAL (if lss: materialise page fails): under Functions delete extra query blocks, keep one → /Advanced Query → paste expected-query EDN into the code child',
          );
        }
      } else {
        lines.push('query-block-has-query-tag:: (no query block under Functions)');
      }
      break;
    }
    if (actual && expectedBlock) {
      lines.push(
        `query-match:: ${queriesEquivalent(actual, expectedBlock, venturePageId) ? 'yes' : 'no'}`,
      );
      lines.push(`query-needs-repair:: ${queryBlockNeedsRepair(actual, expectedBlock) ? 'yes' : 'no'}`);
      if (queryBlockNeedsRepair(actual, expectedBlock)) {
        const fmt = isAdvancedQueryBlockContent(expectedBlock) ? 'advanced EDN DSL payload' : 'simple #Query';
        lines.push(
          `- NOTE: run lss: materialise page (or let auto-repair) on ftv to rewrite dashboard queries (DB graphs use /Advanced Query ${fmt}; raw simple #Query blocks can return wrong blocks via customQuery)`,
        );
      }
    }
    lines.push('');
    lines.push('## Live query probe (Logseq engine)');
    lines.push(
      ...(await runLiveQueryProbe(
        actual ?? actualBody,
        visibleName,
        venturePageId != null ? Number(venturePageId) : undefined,
        expectedBody,
      )),
    );
    lines.push('');
    lines.push('## Function pages that should appear here');
    lines.push(...(await diagnoseFunctionCandidates(visibleName)));
  }

  if (inferredType === 'Function' || classTags.includes('Function')) {
    lines.push('## Function page checks');
    const typeOk = objectType.includes('Function');
    const venturePage = await resolveVenturePageFromValue(venture, rawVenture);
    const ventureIsRef = isDbPageRefValue(venture);
    lines.push(`lss-object-type-ok:: ${typeOk ? 'yes' : 'no'}`);
    lines.push(`venture-property:: ${formatValue(venture)}`);
    if (rawVenture !== venture) lines.push(`venture-visible-property:: ${formatValue(rawVenture)}`);
    lines.push(
      `venture-resolves-to-page:: ${venturePage ? pageVisibleName(venturePage, 'yes') || 'yes' : 'no'}`,
    );
    lines.push(`venture-is-page-ref:: ${ventureIsRef ? 'yes' : 'no'}`);
    if (!typeOk) lines.push('- FIX: add page property lss-object-type = Function');
    if (String(venture ?? '').trim() === '') {
      lines.push(
        '- FIX: venture is missing; run `lss: materialise page` on this Function to infer it from an explicit Venture link or the single Venture in the graph, otherwise select the parent Venture in the venture property',
      );
    } else if (!ventureIsRef) {
      lines.push(
        '- FIX: venture is plain text (e.g. "FTV"); run `lss: materialise page` on this page, or clear venture and re-pick ftv from the venture dropdown',
      );
      if (venturePage) {
        lines.push(
          `- NOTE: name "${formatValue(venture)}" matches page [[${pageVisibleName(venturePage, 'yes') || 'yes'}]] but queries require a numeric page id like area uses [465]`,
        );
      }
    }
    lines.push('');
    lines.push('## Native relationship property schema');
    lines.push(...(await nativePropertyDebugLines('venture')));
  }

  const report = lines.join('\n');
  const reportPage = `LSS Reports/diagnose-${visibleName.replace(/[^a-zA-Z0-9]+/g, '-')}-${tsKey()}`;
  await ensurePage(r, 'LSS Reports');
  await appendManagedBlock(r, reportPage, `${MODE}-diagnose-${tsKey()}`, report);
  r.notes.push(`Diagnose report written to ${reportPage}. Copy that block and share it.`);
  r.actions.push(`DIAGNOSE page: ${visibleName}`);
}
