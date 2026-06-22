import { getPage, pageVisibleName, resolvePageFromIdentity } from '../core/editor';
import { templateDefByObjectType } from '../registry';
import {
  advancedDashboardQueryEdnForViewAsync,
  dashboardQueryBlockForViewAsync,
  datascriptInspectBlock,
  datascriptInspectEntityId,
  datascriptVentureProbeReport,
  dbDashboardQueryForViewAsync,
  extractAdvancedQueryDsl,
  extractAdvancedQueryVector,
  isAdvancedQueryBlockContent,
  queryDbPageClassTagExpr,
  runAdvancedQueryDatascriptProbe,
  venturePropertyClauseFromQuery,
  viewDefinitionsSafe,
} from './queries';

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
    if (page) return pageVisibleName(page, identity.value) || identity.value;
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
  if (page) return pageVisibleName(page, `entity-id:${identity.value}`) || `entity-id:${identity.value}`;
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

export function summarizeDatascriptEntity(entity: Record<string, unknown> | null): string {
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

export async function runLiveQueryProbe(
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
    let storedBestForNote: { channel: string; count: number; hits: unknown[] } | undefined;
    if (storedProbe) {
      const storedAttempts = await runQueryEngineCandidates(storedProbe.body, venturePageId);
      storedDsHit = storedAttempts.find((a) => a.channel === 'datascript-current-page' && a.count > 0);
      const storedBest = pickBestQueryAttempt(storedAttempts);
      storedBestForNote = storedBest;
      const dslHit = storedAttempts.find((a) => a.channel === 'dsl' && a.count > 0);
      const customHit = storedAttempts.find((a) => a.channel === 'custom' && a.count > 0);
      if (dslHit && customHit) {
        const dslId = findHitIdentity(dslHit.hits[0]);
        const customId = findHitIdentity(customHit.hits[0]);
        if (dslId?.value && customId?.value && dslId.value !== customId.value) {
          lines.push(
            `- live-query-note/dsl-vs-custom: DB.q => ${dslId.value}; customQuery => ${customId.value} (in-page /Query uses customQuery — simple queries can disagree; run lss: materialise page or let auto-repair upgrade to advanced query)`,
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
        `- live-query-note/stored-advanced: datascript with venture id ${venturePageId ?? '?'} => ${storedDsHit.count} hit(s); lss: materialise page should keep DB /Advanced Query structure with a Logseq DSL :query payload`,
      );
    }
    if (!anyHits) {
      lines.push(
        '- live-query-note: DB.q/customQuery returned 0 for plugin probes (expected for advanced EDN); datascript proves data exists — if UI is empty, run lss: materialise page or wait for auto-repair to add #Query tag on the query block',
      );
    } else if (storedBestForNote?.count && storedBestForNote.count > 0) {
      lines.push(
        `- live-query-note: stored dashboard query resolves via ${storedBestForNote.channel}; the Functions section should list ${storedBestForNote.count} matching page(s)`,
      );
    } else {
      lines.push(
        '- live-query-note: probe variants returned hits, but the stored dashboard query did not; run lss: materialise page to rebuild the stored query block',
      );
    }
  } catch (error) {
    lines.push(`live-query-error:: ${String(error)}`);
  }
  return lines;
}
