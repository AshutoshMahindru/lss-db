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
  resolvePageFromIdentity,
  walkBlocks,
} from '../core/editor';
import { looksLikeUuid, safePageName, safeTag, tagObjectLabel, tsKey, visiblePageLabel } from '../core/names';
import type { Result } from '../core/types';
import { allObjects, objectByName, templateDefByObjectType } from '../registry';
import {
  advancedDashboardQueryEdnForViewAsync,
  dashboardQueryBlockForViewAsync,
  datascriptInspectBlock,
  datascriptInspectEntityId,
  datascriptVentureProbeReport,
  findAllQueryBlocksInSectionAsync,
  findQueryBlockInSection,
  hostQueryRepairScriptsReady,
  pickCanonicalQueryBlock,
  readDashboardQueryBlockContent,
  readQueryChildDisplayTypeRaw,
  sectionNameFromLine,
  dbAdvancedQueryBlockNeedsStructureRepair,
  dbDashboardQueryForViewAsync,
  extractAdvancedQueryDsl,
  extractAdvancedQueryVector,
  inspectDbQueryBlockStructure,
  isAdvancedQueryBlockContent,
  runAdvancedQueryDatascriptProbe,
  queryDbPageClassTagExpr,
  queryBodyFromBlockContent,
  queryBlockNeedsRepair,
  queriesEquivalent,
  venturePropertyClauseFromQuery,
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

function isSetupFunctionTagNoise(name: string, props: Record<string, unknown>): boolean {
  const label = visiblePageLabel(name);
  if (getCanonicalProp(props, 'lss-kind') != null) return true;
  if (/^(Entity-Page|DB Tag|Tag Properties|Template|Word Extender|LSS Reports|Area:)/i.test(label)) return true;
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
    const name = String(record.name ?? record.originalName ?? record.title ?? '').trim();
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
          (await tryName(String(record.name ?? record.originalName ?? record.title ?? '')));
        if (byId) return byId as Record<string, unknown>;
      }
      const name = String(record.name ?? record.originalName ?? record.title ?? '').trim();
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

function looksLikePageEntityId(raw: string): boolean {
  return /^\d+$/.test(raw) && Number(raw) < 1e9;
}

function looksLikeQueryEntityId(raw: string): boolean {
  return /^\d+$/.test(raw) && Number(raw) > 0;
}

function looksLikeBlockUuid(raw: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(raw);
}

function readHitField(record: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    const value = record[key];
    if (value != null) return value;
  }
  return null;
}

function flattenQueryHits(results: unknown): unknown[] {
  if (!Array.isArray(results)) return results == null ? [] : [results];
  const out: unknown[] = [];
  const stack = [...results];
  while (stack.length) {
    const item = stack.shift();
    if (item == null) continue;
    if (Array.isArray(item)) {
      if (item.length === 1) stack.unshift(item[0]);
      else stack.push(...item);
      continue;
    }
    out.push(item);
  }
  return out;
}

function findHitIdentity(item: unknown): { kind: 'uuid' | 'id' | 'name'; value: string } | null {
  const queue: unknown[] = [item];
  const seen = new Set<unknown>();
  while (queue.length) {
    const current = queue.shift();
    if (current == null) continue;
    if (typeof current === 'object') {
      if (seen.has(current)) continue;
      seen.add(current);
    }

    if (typeof current === 'number' && looksLikeQueryEntityId(String(current))) {
      return { kind: 'id', value: String(current) };
    }
    if (typeof current === 'string') {
      const text = current.trim();
      if (!text) continue;
      if (looksLikeQueryEntityId(text)) return { kind: 'id', value: text };
      if (looksLikeBlockUuid(text)) return { kind: 'uuid', value: text };
      const wiki = text.match(/^\[\[([^\]]+)\]\]$/);
      if (wiki?.[1]) return { kind: 'name', value: wiki[1] };
      if (text.length > 0 && text.length < 120 && !text.startsWith('(')) return { kind: 'name', value: text };
      continue;
    }
    if (Array.isArray(current)) {
      queue.push(...current);
      continue;
    }
    if (typeof current === 'object') {
      const record = current as Record<string, unknown>;
      const uuid = readHitField(
        record,
        'uuid',
        'blockUuid',
        ':block/uuid',
        'block/uuid',
      );
      if (typeof uuid === 'string' && uuid.trim()) return { kind: 'uuid', value: uuid.trim() };
      const label = readHitField(
        record,
        'originalName',
        'name',
        'title',
        'fullTitle',
        'blockTitle',
        'blockFullTitle',
        'blockName',
        'blockOriginalName',
        ':block/title',
        'block/title',
        ':block/name',
        'block/name',
        ':block/original-name',
        'block/original-name',
        'blockContent',
        'block/content',
      );
      if (typeof label === 'string' && label.trim()) return { kind: 'name', value: label.trim() };
      const id = readHitField(record, 'id', 'dbId', ':db/id', 'db/id');
      if (id != null && looksLikeQueryEntityId(String(id))) return { kind: 'id', value: String(id) };
      const page = record.page;
      if (page && typeof page === 'object') {
        const pageRecord = page as Record<string, unknown>;
        const pageLabel = readHitField(
          pageRecord,
          'originalName',
          'name',
          'title',
          'fullTitle',
          'blockTitle',
          'blockName',
        );
        if (typeof pageLabel === 'string' && pageLabel.trim()) {
          return { kind: 'name', value: pageLabel.trim() };
        }
        const pageId = readHitField(pageRecord, 'id', 'dbId', ':db/id', 'db/id');
        if (pageId != null && looksLikeQueryEntityId(String(pageId))) {
          return { kind: 'id', value: String(pageId) };
        }
      }
      for (const value of Object.values(record)) queue.push(value);
    }
  }
  return null;
}

function queryHitRawSnippet(item: unknown): string {
  try {
    const text = JSON.stringify(item);
    return text.length > 280 ? `${text.slice(0, 280)}…` : text;
  } catch {
    return String(item);
  }
}

function liveQueryHitLabel(item: unknown): string {
  const identity = findHitIdentity(item);
  if (!identity) return 'unknown';
  if (identity.kind === 'name') return identity.value;
  if (identity.kind === 'uuid') return identity.value;
  return `entity-id:${identity.value}`;
}

async function formatQueryHitLine(item: unknown): Promise<string> {
  const label = await resolveQueryHitLabel(item);
  if (label !== 'unknown') return label;
  return `unknown raw=${queryHitRawSnippet(item)}`;
}

async function resolveQueryHitLabel(item: unknown): Promise<string> {
  const identity = findHitIdentity(item);
  if (!identity) return 'unknown';
  if (identity.kind === 'name') {
    const page = await getPage(identity.value) || (await getPage(identity.value.toLowerCase()));
    if (page) return String(page.originalName ?? page.name ?? page.title ?? identity.value);
    return identity.value;
  }
  if (identity.kind === 'uuid') {
    if (logseq.Editor.getBlock) {
      const block = await logseq.Editor.getBlock(identity.value).catch(() => null);
      if (block) {
        return String(
          (block as Record<string, unknown>).title ??
            (block as Record<string, unknown>).fullTitle ??
            identity.value,
        );
      }
    }
    const pulled = await datascriptInspectBlock(identity.value);
    if (pulled) {
      const title = pulled[':block/title'] ?? pulled['block/title'];
      if (title != null) return String(title);
    }
    return identity.value;
  }
  const page = await resolvePageFromIdentity(identity.value);
  if (page) return String(page.originalName ?? page.name ?? page.title ?? `entity-id:${identity.value}`);
  if (logseq.Editor.getBlock) {
    const block = await logseq.Editor.getBlock(identity.value).catch(() => null);
    if (block) {
      return String(
        (block as Record<string, unknown>).title ??
          (block as Record<string, unknown>).fullTitle ??
          `entity-id:${identity.value}`,
      );
    }
  }
  const pulled = await datascriptInspectEntityId(identity.value);
  const title = entityTitleFromPull(pulled);
  if (title) return title;
  return `entity-id:${identity.value}`;
}

async function runQueryEngineCandidates(
  queryBody: string,
  venturePageId?: number,
): Promise<Array<{ channel: string; count: number; hits: unknown[] }>> {
  const text = String(queryBody ?? '').trim();
  if (!text) return [];
  const candidates: Array<{ channel: string; payload: string }> = [];
  if (isAdvancedQueryBlockContent(text)) {
    candidates.push({ channel: 'custom-advanced', payload: text });
    const queryDsl = extractAdvancedQueryDsl(text);
    if (queryDsl) {
      candidates.push(
        { channel: 'advanced-dsl', payload: queryDsl },
        { channel: 'custom-advanced-dsl', payload: queryDsl },
      );
    }
    const queryVector = extractAdvancedQueryVector(text);
    if (queryVector) {
      candidates.push({ channel: 'custom-advanced-wrapped', payload: `{:query ${queryVector}}` });
    }
  } else {
    const simpleBody = text.replace(/^#Query\s+/, '').trim();
    candidates.push(
      { channel: 'dsl', payload: simpleBody },
      { channel: 'dsl-hash-query', payload: `#Query ${simpleBody}` },
      { channel: 'custom', payload: simpleBody },
      { channel: 'custom-hash-query', payload: `#Query ${simpleBody}` },
    );
  }

  const out: Array<{ channel: string; count: number; hits: unknown[] }> = [];
  for (const candidate of candidates) {
    let hits: unknown[] = [];
    try {
      if (candidate.channel.startsWith('custom')) {
        if (!logseq.DB?.customQuery) continue;
        const results = await logseq.DB.customQuery(candidate.payload);
        hits = flattenQueryHits(results);
      } else if (logseq.DB?.q) {
        const results = await logseq.DB.q(candidate.payload);
        hits = flattenQueryHits(results);
      }
    } catch {
      hits = [];
    }
    out.push({ channel: candidate.channel, count: hits.length, hits });
  }
  if (isAdvancedQueryBlockContent(text) && venturePageId != null) {
    const dsHits = await runAdvancedQueryDatascriptProbe(text, venturePageId);
    out.push({ channel: 'datascript-current-page', count: dsHits.length, hits: dsHits });
  }
  return out;
}

function venturePageRefSubstitutions(
  body: string,
  pageName: string,
  venturePageId?: number,
): Array<{ label: string; body: string }> {
  const out: Array<{ label: string; body: string }> = [];
  if (!body.includes('<% current page %>')) return out;
  const pageRef = `[[${pageName.toLowerCase()}]]`;
  const wiki = body.replace(/<% current page %>/gi, pageRef);
  out.push({ label: 'wiki-page-ref', body: wiki });
  const quotedName = body.replace(/<% current page %>/gi, `"${pageName.toLowerCase()}"`);
  if (quotedName !== body) out.push({ label: 'quoted-page-name', body: quotedName });
  if (venturePageId != null) {
    out.push({ label: 'numeric-page-id', body: body.replace(/<% current page %>/gi, String(venturePageId)) });
  }
  return out;
}

function summarizeDatascriptEntity(entity: Record<string, unknown> | null): string {
  if (!entity) return '(pull failed)';
  const keys = Object.keys(entity)
    .filter((k) => /venture|object.type|lss-object-type|plugin\.property.*\/(venture|lss-object-type)/i.test(k))
    .sort();
  if (!keys.length) return '(no venture/lss-object-type attrs on entity)';
  const parts = keys.map((k) => `${k}=${JSON.stringify(entity[k])}`);
  return parts.join('; ');
}

function entityTitleFromPull(entity: Record<string, unknown> | null): string | null {
  if (!entity) return null;
  const title = entity[':block/title'] ?? entity['block/title'] ?? entity[':block/name'] ?? entity['block/name'];
  return title != null ? String(title) : null;
}

function entityUuidFromPull(entity: Record<string, unknown> | null): string | null {
  if (!entity) return null;
  const uuid = entity[':block/uuid'] ?? entity['block/uuid'] ?? entity.uuid;
  return uuid != null ? String(uuid) : null;
}

async function probeEntitySummary(entityId: string): Promise<string> {
  const pulled = await datascriptInspectEntityId(entityId);
  if (!pulled) return `entity-id:${entityId} (datascript pull failed)`;
  const uuid = entityUuidFromPull(pulled) ?? '?';
  const title = entityTitleFromPull(pulled) ?? '(no title)';
  const venture = summarizeDatascriptEntity(pulled);
  return `entity-id:${entityId} uuid=${uuid} title=${title} ${venture}`;
}

function queryAttemptScore(attempt: { channel: string; count: number }): number {
  let score = attempt.count;
  if (attempt.channel.startsWith('custom')) score += 0.25;
  if (attempt.channel === 'datascript-current-page') score += 0.5;
  return score;
}

function pickBestQueryAttempt(
  attempts: Array<{ channel: string; count: number; hits: unknown[] }>,
): { channel: string; count: number; hits: unknown[] } {
  if (!attempts.length) return { channel: 'none', count: 0, hits: [] };
  return attempts.reduce(
    (top, attempt) => (queryAttemptScore(attempt) > queryAttemptScore(top) ? attempt : top),
    attempts[0],
  );
}

async function runLiveQueryProbe(
  queryBody: string | null,
  pageName: string,
  venturePageId?: number,
  engineQueryBody?: string | null,
): Promise<string[]> {
  const lines: string[] = [];
  if (!queryBody) return lines;
  if (!logseq.DB?.q && !logseq.DB?.customQuery) {
    lines.push('- live-query:: unavailable (logseq.DB.q and logseq.DB.customQuery APIs missing)');
    return lines;
  }
  try {
    const variants: Array<{ label: string; body: string }> = [
      { label: 'stored', body: queryBody },
    ];
    if (engineQueryBody && engineQueryBody !== queryBody) {
      variants.push({ label: 'engine-ident', body: engineQueryBody });
    }
    for (const sub of venturePageRefSubstitutions(queryBody, pageName, venturePageId)) {
      variants.push(sub);
    }
    if (engineQueryBody) {
      for (const sub of venturePageRefSubstitutions(engineQueryBody, pageName, venturePageId)) {
        variants.push({ label: `engine-ident-${sub.label}`, body: sub.body });
      }
    }
    const ventureOnly = venturePropertyClauseFromQuery(queryBody);
    if (ventureOnly) {
      variants.push({ label: 'venture-only', body: `(and ${ventureOnly})` });
      for (const sub of venturePageRefSubstitutions(`(and ${ventureOnly})`, pageName, venturePageId)) {
        variants.push({ label: `venture-only-${sub.label}`, body: sub.body });
      }
    }
    const template = templateDefByObjectType('Venture');
    const fnView = viewDefinitionsSafe(template ?? ({} as any)).find((v) => v.section === 'Functions');
    if (fnView) {
      const dbCanonicalBody = await dbDashboardQueryForViewAsync(fnView);
      if (dbCanonicalBody) {
        variants.push({ label: 'tags-property', body: dbCanonicalBody });
        for (const sub of venturePageRefSubstitutions(dbCanonicalBody, pageName, venturePageId)) {
          variants.push({ label: `tags-property-${sub.label}`, body: sub.body });
        }
      }
      const tagExpr = queryDbPageClassTagExpr(fnView);
      if (tagExpr) {
        variants.push({ label: 'tags-only', body: `(and ${tagExpr})` });
      }
      const legacyPageTagsBody = dbCanonicalBody
        ?.replace(/\(tags\s+/gi, '(page-tags ')
        .replace(/\(property\s+[^\s)]+\s+/gi, '(page-property venture ');
      if (legacyPageTagsBody && legacyPageTagsBody !== dbCanonicalBody) {
        variants.push({ label: 'legacy-page-tags-page-property', body: legacyPageTagsBody });
      }
    }

    if (fnView) {
      const canonicalBlock = await dashboardQueryBlockForViewAsync(fnView);
      if (canonicalBlock) variants.push({ label: 'canonical-dashboard', body: canonicalBlock });
      const advancedBody = await advancedDashboardQueryEdnForViewAsync(fnView);
      if (advancedBody && advancedBody !== canonicalBlock) {
        variants.push({ label: 'advanced-dashboard', body: advancedBody });
      }
    }

    let anyHits = false;
    for (const variant of variants) {
      const attempts = await runQueryEngineCandidates(variant.body, venturePageId);
      const best = pickBestQueryAttempt(attempts);
      lines.push(`live-query-${variant.label}:: ${best.count}`);
      if (best.channel !== 'none' && attempts.length > 1) {
        lines.push(`live-query-channel/${variant.label}:: ${best.channel}`);
      }
      for (const hit of best.hits.slice(0, 6)) {
        lines.push(`- live-query-hit/${variant.label}: ${await formatQueryHitLine(hit)}`);
      }
      if (best.count > 0) anyHits = true;
    }

    if (venturePageId != null && logseq.DB.datascriptQuery) {
      const dsReport = await datascriptVentureProbeReport(venturePageId, 'Function', pageName);
      lines.push(`datascript-probe:: ${dsReport.hits.length}`);
      if (dsReport.matchedLabel) lines.push(`datascript-matched-pattern:: ${dsReport.matchedLabel}`);
      for (const hit of dsReport.hits.slice(0, 6)) {
        lines.push(`- datascript-hit: ${liveQueryHitLabel(hit)}`);
      }
      const topAttempts = dsReport.attempts.filter((a) => a.count > 0).slice(0, 8);
      if (topAttempts.length) {
        lines.push('- datascript-nonzero-patterns:');
        for (const attempt of topAttempts) lines.push(`  - ${attempt.label}: ${attempt.count}`);
      } else {
        const tagOnly = dsReport.attempts.find((a) => a.label === 'tag-function-only');
        lines.push(`datascript-tag-function-count:: ${tagOnly?.count ?? 0}`);
      }
      if (dsReport.hits.length > 0) anyHits = true;
    }

    const storedProbe = variants.find((v) => v.label === 'stored');
    let storedDsHit: { channel: string; count: number; hits: unknown[] } | undefined;
    if (storedProbe) {
      const storedAttempts = await runQueryEngineCandidates(storedProbe.body, venturePageId);
      storedDsHit = storedAttempts.find((a) => a.channel === 'datascript-current-page' && a.count > 0);
      const storedBest = pickBestQueryAttempt(storedAttempts);
      const dslHit = storedAttempts.find((a) => a.channel === 'dsl' && a.count > 0);
      const customHit = storedAttempts.find((a) => a.channel === 'custom' && a.count > 0);
      if (dslHit && customHit) {
        const dslId = findHitIdentity(dslHit.hits[0]);
        const customId = findHitIdentity(customHit.hits[0]);
        if (dslId?.value && customId?.value && dslId.value !== customId.value) {
          lines.push(
            `- live-query-note/dsl-vs-custom: DB.q => ${dslId.value}; customQuery => ${customId.value} (in-page /Query uses customQuery — simple queries can disagree; run lss:50 or let auto-repair upgrade to advanced query)`,
          );
        }
      }
      if (storedBest.count > 0) {
        lines.push(`live-query-stored-resolved:: ${storedBest.count}`);
        const pageLabels: string[] = [];
        const storedEntityIds: string[] = [];
        for (const hit of storedBest.hits.slice(0, 8)) {
          const line = await formatQueryHitLine(hit);
          lines.push(`- live-query-stored-page: ${line}`);
          const identity = findHitIdentity(hit);
          if (identity) {
            if (identity.kind === 'id') storedEntityIds.push(identity.value);
            const resolved =
              identity.kind === 'name'
                ? identity.value
                : String((await resolvePageFromIdentity(identity.value))?.originalName
                    ?? (await resolvePageFromIdentity(identity.value))?.name
                    ?? (await resolveQueryHitLabel(hit)));
            if (resolved) pageLabels.push(resolved);
          }
        }
        for (const entityId of storedEntityIds.slice(0, 4)) {
          lines.push(`- live-query-stored-entity: ${await probeEntitySummary(entityId)}`);
        }
        const uniquePages = [...new Set(pageLabels.map((x) => x.trim()).filter(Boolean))];
        if (uniquePages.length) {
          lines.push(`live-query-stored-unique-pages:: ${uniquePages.join(', ')}`);
        }
        if (storedBest.count > uniquePages.length && uniquePages.length > 0) {
          lines.push(
            `- live-query-note/stored: engine returned ${storedBest.count} block(s) for ${uniquePages.length} page(s); UI may list duplicate blocks on the same Function page`,
          );
        }
      }
      const storedChannels = storedAttempts
        .filter((attempt) => attempt.count > 0)
        .map((attempt) => `${attempt.channel}:${attempt.count}`);
      if (storedChannels.length > 1) {
        lines.push(`live-query-stored-channels:: ${storedChannels.join(', ')}`);
      }
    }

    if (storedProbe && isAdvancedQueryBlockContent(storedProbe.body) && storedDsHit) {
      lines.push(
        `- live-query-note/stored-advanced: datascript with venture id ${venturePageId ?? '?'} => ${storedDsHit.count} hit(s); lss:50 should keep DB /Advanced Query structure with a Logseq DSL :query payload`,
      );
    }
    if (!anyHits) {
      lines.push(
        '- live-query-note: DB.q/customQuery returned 0 for plugin probes (expected for advanced EDN); datascript proves data exists — if UI is empty, run lss:50 or wait for auto-repair to add #Query tag on the query block',
      );
    } else {
      lines.push(
        '- live-query-note: customQuery is the engine path that matches in-page /Query blocks; DB.q alone may return 0 from plugins',
      );
    }
  } catch (error) {
    lines.push(`live-query-error:: ${String(error)}`);
  }
  return lines;
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

  const visibleName = String(page.originalName ?? page.name ?? page.title ?? pageName);
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

  const lines: string[] = [];
  lines.push(`# LSS Diagnose: ${visibleName}`);
  lines.push('');
  lines.push(`checked-at:: ${new Date().toISOString()}`);
  lines.push(`plugin-version:: ${VERSION}`);
  lines.push(`db-graph:: ${(await isDbGraph()) ? 'yes' : 'no'}`);
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
  lines.push('## Page properties (DB API)');
  if (Object.keys(props).length) {
    for (const [key, value] of Object.entries(props).sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`- ${key}:: ${formatValue(value)}`);
    }
  } else {
    lines.push('- (none returned by getPageProperties/getBlockProperties)');
  }
  lines.push('');
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
    lines.push('- Inference: Function pages point their venture property at this page; run lss:50 to bootstrap #Venture and page properties.');
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
          `- NOTE: multiple query blocks under Functions (${sectionQueries.length}); run lss:50 to dedupe to one canonical block per section`,
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
              '- UI-BLOCKER: host keyword helper not installed — reload plugin then run lss:50 (inline host install failed; Experiments.loadScripts is optional fallback)',
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
            '- UI-BLOCKER: code child needs logseq.property.node/display-type = :code (cljs keyword); plugin IPC cannot set this — run lss:50 after reload (host inline upsert applies :code without manual /Advanced Query)',
          );
        }
        lines.push(
          `query-needs-structure-repair:: ${dbAdvancedQueryBlockNeedsStructureRepair(struct) ? 'yes' : 'no'}`,
        );
        if (dbAdvancedQueryBlockNeedsStructureRepair(struct)) {
          lines.push(
            '- FIX: run lss:50 to convert to Logseq DB /Advanced Query structure (#Query tag + logseq.property/query code child)',
          );
          lines.push(
            '- MANUAL (if lss:50 fails): under Functions delete extra query blocks, keep one → /Advanced Query → paste expected-query EDN into the code child',
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
          `- NOTE: run lss:50 (or let auto-repair) on ftv to rewrite dashboard queries (DB graphs use /Advanced Query ${fmt}; raw simple #Query blocks can return wrong blocks via customQuery)`,
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
      `venture-resolves-to-page:: ${venturePage ? String(venturePage.originalName ?? venturePage.name ?? 'yes') : 'no'}`,
    );
    lines.push(`venture-is-page-ref:: ${ventureIsRef ? 'yes' : 'no'}`);
    if (!typeOk) lines.push('- FIX: add page property lss-object-type = Function');
    if (!ventureIsRef) {
      lines.push(
        '- FIX: venture is plain text (e.g. "FTV"); run `lss:50` on this page, or clear venture and re-pick ftv from the venture dropdown',
      );
      if (venturePage) {
        lines.push(
          `- NOTE: name "${formatValue(venture)}" matches page [[${venturePage.originalName ?? venturePage.name}]] but queries require a numeric page id like area uses [465]`,
        );
      }
    }
  }

  const report = lines.join('\n');
  const reportPage = `LSS Reports/diagnose-${visibleName.replace(/[^a-zA-Z0-9]+/g, '-')}-${tsKey()}`;
  await ensurePage(r, 'LSS Reports');
  await appendManagedBlock(r, reportPage, `${MODE}-diagnose-${tsKey()}`, report);
  r.notes.push(`Diagnose report written to ${reportPage}. Copy that block and share it.`);
  r.actions.push(`DIAGNOSE page: ${visibleName}`);
}
