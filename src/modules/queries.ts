import {
  canonicalPropertyKey,
  entityIdentity,
  isDbGraph,
  pluginPropertyIdent,
  propertyQueryName,
  resolvePropertyQueryName,
} from '../core/db-properties';
import { blockId, updateBlockContent, walkBlocks } from '../core/editor';
import { normalizePageRefName, safePageName, safeTag } from '../core/names';
import { formatError, sleep } from '../core/runner';
import type { Result } from '../core/types';
import {
  allObjects,
  dashboardPageForObjectType,
  objectByName,
  registry,
  relationshipsForTag,
  templateDefByObjectType,
  templateNameFromRegistry,
} from '../registry';
import type { RegistryTemplate, ViewDefinition } from '../registry/types';

export function normTagList(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return value.map((x) => String(x).trim()).filter(Boolean);
  return String(value ?? '')
    .split(/[.,\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

export function queryValue(value: unknown): string {
  const raw = String(value ?? '').trim();
  if (!raw) return '""';
  if (raw.startsWith('[[') || raw.startsWith('<%') || /^-?\d+(\.\d+)?$/.test(raw)) return raw;
  return `"${raw.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function filterProps(filter: { property?: string; propertyAny?: string[] }): string[] {
  if (Array.isArray(filter.propertyAny)) {
    return filter.propertyAny.map((p) => String(p).trim()).filter(Boolean);
  }
  return filter.property ? [String(filter.property).trim()].filter(Boolean) : [];
}

function queryPropertyName(shortName: string): string {
  return propertyQueryName(shortName);
}

async function queryPropertyNameAsync(shortName: string): Promise<string> {
  return resolvePropertyQueryName(shortName);
}

/**
 * DB graph: (tags Function) per db-version-changes.md (page-tags was file-graph only).
 * File graph: (property lss-object-type "…") — avoid (tags [[Tag]]) wiki form (Function) parse bug).
 */
export function queryDbPageClassTagExpr(view: ViewDefinition): string {
  const tags = normTagList(view.sourceTags).map(safeTag).filter(Boolean);
  if (!tags.length) return '';
  const parts = tags.map((tag) => `(tags ${tag})`);
  return parts.length > 1 ? `(or ${parts.join(' ')})` : parts[0];
}

/** @deprecated Use queryDbPageClassTagExpr — kept for diagnose probe labels */
export function queryDbClassTagExpr(view: ViewDefinition): string {
  return queryDbPageClassTagExpr(view);
}

export function queryTagExpr(view: ViewDefinition): string {
  // Use (tags ...) for class matching (preferred on DB graphs; works on file graphs too)
  return queryDbPageClassTagExpr(view);
}

async function queryTagExprAsync(view: ViewDefinition, dbGraph = false): Promise<string> {
  if (dbGraph) return queryDbPageClassTagExpr(view);
  const tags = normTagList(view.sourceTags).map(safeTag).filter(Boolean);
  if (!tags.length) return '';
  const propName = await queryPropertyNameAsync('lss-object-type');
  const parts = tags.map((tag) => {
    const objectType = objectByName(tag)?.name ?? tag;
    return `(property ${propName} ${queryValue(objectType)})`;
  });
  return parts.length > 1 ? `(or ${parts.join(' ')})` : parts[0];
}

export function queryFilterExpr(
  filter: NonNullable<ViewDefinition['filters']>[number],
  pageRef = '<% current page %>',
): string | null {
  const props = filterProps(filter);
  const op = String(filter.operator ?? '');
  if (!props.length) return null;

  if (op === 'includesCurrentPage') {
    const parts = props.map(
      (p) =>
        `(property ${queryPropertyName(p)} ${pageRef === '<% current page %>' ? '<% current page %>' : queryValue(pageRef)})`,
    );
    return parts.length > 1 ? `(or ${parts.join(' ')})` : parts[0];
  }
  if (op === 'in' && Array.isArray(filter.value) && filter.value.length) {
    const parts: string[] = [];
    for (const prop of props) {
      for (const val of filter.value) {
        parts.push(`(property ${queryPropertyName(prop)} ${queryValue(val)})`);
      }
    }
    return parts.length > 1 ? `(or ${parts.join(' ')})` : parts[0];
  }
  if (op === 'onOrBeforeToday') return `(property ${queryPropertyName(props[0])} <% today %>)`;
  return null;
}

async function queryDbPropertyRefExpr(shortKey: string, pageRef = '<% current page %>'): Promise<string> {
  const propName = await queryPropertyNameAsync(shortKey);
  const value = pageRef === '<% current page %>' ? '<% current page %>' : queryValue(pageRef);
  return `(property ${propName} ${value})`;
}

async function queryFilterExprAsync(
  filter: NonNullable<ViewDefinition['filters']>[number],
  pageRef = '<% current page %>',
  dbGraph = false,
): Promise<string | null> {
  const props = filterProps(filter);
  const op = String(filter.operator ?? '');
  if (!props.length) return null;

  if (op === 'includesCurrentPage') {
    if (dbGraph) {
      const parts = await Promise.all(props.map((p) => queryDbPropertyRefExpr(p, pageRef)));
      return parts.length > 1 ? `(or ${parts.join(' ')})` : parts[0];
    }
    const parts = await Promise.all(
      props.map(async (p) => {
        const propName = await queryPropertyNameAsync(p);
        return `(property ${propName} ${pageRef === '<% current page %>' ? '<% current page %>' : queryValue(pageRef)})`;
      }),
    );
    return parts.length > 1 ? `(or ${parts.join(' ')})` : parts[0];
  }
  if (op === 'in' && Array.isArray(filter.value) && filter.value.length) {
    const parts: string[] = [];
    for (const prop of props) {
      const propName = await queryPropertyNameAsync(prop);
      for (const val of filter.value) {
        parts.push(`(property ${propName} ${queryValue(val)})`);
      }
    }
    return parts.length > 1 ? `(or ${parts.join(' ')})` : parts[0];
  }
  if (op === 'onOrBeforeToday') {
    const propName = await queryPropertyNameAsync(props[0]);
    return `(property ${propName} <% today %>)`;
  }
  return null;
}

export function simpleQueryForView(view: ViewDefinition, pageRef = '<% current page %>'): string {
  const parts: string[] = [];
  const tagExpr = queryTagExpr(view);
  if (tagExpr) parts.push(tagExpr);
  for (const filter of view.filters ?? []) {
    const expr = queryFilterExpr(filter, pageRef);
    if (expr) parts.push(expr);
  }
  return parts.length ? `(and ${parts.join(' ')})` : '';
}

export async function simpleQueryForViewAsync(
  view: ViewDefinition,
  pageRef = '<% current page %>',
): Promise<string> {
  const parts: string[] = [];
  const dbGraph = await isDbGraph();
  const tagExpr = await queryTagExprAsync(view, dbGraph);
  if (tagExpr) parts.push(tagExpr);
  for (const filter of view.filters ?? []) {
    const expr = await queryFilterExprAsync(filter, pageRef, dbGraph);
    if (expr) parts.push(expr);
  }
  return parts.length ? `(and ${parts.join(' ')})` : '';
}

/** Canonical DB simple query for dashboard sections (tags + property ident). */
export async function dbDashboardQueryForViewAsync(
  view: ViewDefinition,
  pageRef = '<% current page %>',
): Promise<string> {
  const parts: string[] = [];
  const tagExpr = queryDbPageClassTagExpr(view);
  if (tagExpr) parts.push(tagExpr);
  for (const filter of view.filters ?? []) {
    const expr = await queryFilterExprAsync(filter, pageRef, true);
    if (expr) parts.push(expr);
  }
  return parts.length ? `(and ${parts.join(' ')})` : '';
}

function identToDatascriptAttr(ident: string): string {
  const raw = String(ident ?? '').trim();
  return raw.startsWith(':') ? raw : `:${raw}`;
}

function ednQuotedString(value: string): string {
  return JSON.stringify(String(value ?? ''));
}

function todayJournalDay(): number {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return Number(`${y}${m}${day}`);
}

function ednStringSet(values: unknown[]): string {
  const set = new Set<string>();
  for (const value of values ?? []) {
    const raw = String(value ?? '').trim();
    if (!raw) continue;
    set.add(raw);
    set.add(raw.toLowerCase());
  }
  return `#{${[...set].map(ednQuotedString).join(' ')}}`;
}

function advancedTagClauses(tag: string, index: number): string[] {
  const title = ednQuotedString(tag);
  return [':block/tags', ':blocks/tags'].map((attr, attrIndex) => {
    const tagVar = `?tag${index}_${attrIndex}`;
    return `(and [?b ${attr} ${tagVar}] [${tagVar} :block/title ${title}])`;
  });
}

async function currentPagePropertyClause(prop: string, currentPageId?: number): Promise<string> {
  const attr = identToDatascriptAttr(await resolvePropertyQueryName(prop));
  if (currentPageId != null) {
    return `[?b ${attr} ${currentPageId}]`;
  }
  return `(or [?b ${attr} ?current] (and [?b ${attr} ?ref] (or [(= ?current ?ref)] [?ref :db/id ?current] [?ref :block/title ?current] [?ref :block/name ?current] [?ref :block/uuid ?current])))`;
}

function notInPropertyClauses(attr: string, values: unknown[]): string[] {
  const blocked = ednStringSet(values);
  if (blocked === '#{}') return [];
  return [
    `(not-join [?b] [?b ${attr} ?blocked] [(contains? ${blocked} ?blocked)])`,
    `(not-join [?b] [?b ${attr} ?blocked] [?blocked :block/title ?blockedTitle] [(contains? ${blocked} ?blockedTitle)])`,
  ];
}

async function advancedQueryWhereLinesForView(view: ViewDefinition, currentPageId?: number): Promise<string[]> {
  const lines: string[] = [];
  const tags = normTagList(view.sourceTags).map(safeTag).filter(Boolean);

  if (tags.length > 0) {
    const clauses = tags.flatMap((tag, index) => advancedTagClauses(tag, index));
    lines.push(clauses.length > 1 ? `(or ${clauses.join(' ')})` : clauses[0]);
  }

  for (const filter of view.filters ?? []) {
    const props = filterProps(filter);
    const op = String(filter.operator ?? '');
    if (op === 'includesCurrentPage' && props.length) {
      const clauses = await Promise.all(props.map((prop) => currentPagePropertyClause(prop, currentPageId)));
      lines.push(clauses.length > 1 ? `(or ${clauses.join(' ')})` : clauses[0]);
      continue;
    }
    if (op === 'onOrBeforeToday' && props.length) {
      const attr = identToDatascriptAttr(await resolvePropertyQueryName(props[0]));
      lines.push(`[?b ${attr} ?today]`);
      lines.push(`[(<= ?today ${todayJournalDay()})]`);
      continue;
    }
    if (op === 'notIn' && props.length && Array.isArray(filter.value) && filter.value.length) {
      for (const prop of props) {
        const attr = identToDatascriptAttr(await resolvePropertyQueryName(prop));
        lines.push(...notInPropertyClauses(attr, filter.value));
      }
    }
  }

  return lines;
}

/** Advanced query EDN body for DB dashboards (matches working datascript tag+venture pattern).
 *
 * On DB graphs, we hardcode the current page's numeric :db/id (when known) for
 * includesCurrentPage filters instead of using :inputs [:current-page] / ?current.
 * Reason: Logseq's live query engine (customQuery, datascript-current-page, stored
 * paths used by in-page /Query blocks and dashboard sections) often cannot reliably
 * bind ?current for custom plugin properties on DB graphs (see probe notes).
 * Hardcoded literal makes the filter self-contained and matches what direct
 * datascript probes succeed with.
 *
 * Use flat clause style to match proven probe patterns.
 */
export async function advancedDashboardQueryEdnForViewAsync(view: ViewDefinition, currentPageId?: number): Promise<string> {
  const whereLines = await advancedQueryWhereLinesForView(view, currentPageId);
  const hasCurrent = whereLines.some(l => l.includes('?current'));
  const inPart = hasCurrent ? ' $ ?current' : ' $';
  const inputsPart = hasCurrent ? '\n:inputs [:current-page]' : '';
  return `{:query [:find (pull ?b [*])
 :in${inPart}
 :where
 ${whereLines.join('\n ')}]${inputsPart}}`;
}

/** Raw EDN for /Advanced Query (no #+BEGIN_QUERY wrapper — deprecated in DB v2). */
export function advancedQueryBlockContent(ednBody: string): string {
  return String(ednBody ?? '').trim();
}

function extractBalancedVector(text: string, startIdx: number): string | null {
  if (text[startIdx] !== '[') return null;
  let depth = 0;
  for (let i = startIdx; i < text.length; i++) {
    const ch = text[i];
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) return text.slice(startIdx, i + 1);
    }
  }
  return null;
}

/** Pull the `[:find …]` vector from advanced query EDN block content. */
export function extractAdvancedQueryVector(content: string): string | null {
  const text = queryBodyFromBlockContent(content);
  const marker = text.search(/:query\s+\[/i);
  if (marker < 0) return null;
  const bracketStart = text.indexOf('[', marker);
  if (bracketStart < 0) return null;
  return extractBalancedVector(text, bracketStart);
}

const QUERY_CLASS_TAG_NAMES = ['logseq.class/Query', 'Query'] as const;
const QUERY_PROPERTY_KEY = 'logseq.property/query';
const QUERY_DISPLAY_TYPE_KEY = 'logseq.property.node/display-type';
const QUERY_CODE_LANG_KEY = 'logseq.property.code/lang';

function isPlausibleBlockIdentity(v: unknown): boolean {
  if (v == null) return false;
  if (typeof v === 'number') return Number.isFinite(v) && v > 0;
  if (typeof v === 'string') {
    const t = v.trim();
    if (/^\d+$/.test(t)) return true;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(t)) return true;
    // reject edn content, long titles, raw query text etc.
    if (t.startsWith('{') || t.includes(':query') || t.includes('\n:') || t.length > 100) return false;
    return false;
  }
  return false;
}

function propertyBlockRefId(value: unknown): string | number | null {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;
  if (typeof value === 'string') {
    const text = value.trim();
    if (/^\d+$/.test(text)) return Number(text);
    if (isPlausibleBlockIdentity(text)) return text;
    return null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const id = propertyBlockRefId(item);
      if (id != null) return id;
    }
    return null;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const cand = record.id ?? record.dbId ?? record[':db/id'] ?? record.uuid ?? record[':block/uuid'];
    if (cand != null) return propertyBlockRefId(cand);
    return null;
  }
  return null;
}

function readCanonicalProperty(props: Record<string, unknown>, shortName: string): unknown {
  const target = canonicalPropertyKey(shortName);
  for (const [key, value] of Object.entries(props)) {
    if (canonicalPropertyKey(key) === target) return value;
  }
  return undefined;
}

export type DbQueryBlockStructure = {
  hasQueryClassTag: boolean;
  hasQueryProperty: boolean;
  hasCodeChild: boolean;
  rawEdnInParentContent: boolean;
  queryEdnInChild: boolean;
  childDisplayTypeIsCode: boolean;
  childTitleHasEdn: boolean;
  parentCollapsed: boolean;
};

function displayTypeIsCodeKeyword(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const name = String(record.name ?? record[':name'] ?? '').trim().toLowerCase();
    if (name === 'code') return true;
  }
  const token = normalizeDisplayTypeToken(value);
  return token === 'code';
}

async function readBlockDatascriptProperty(
  entityId: string | number,
  attribute: string,
): Promise<unknown> {
  if (!logseq.DB?.datascriptQuery) return undefined;
  let e: number | null = null;
  const raw = String(entityId).trim();
  if (raw.includes('-') && raw.length >= 32) {
    // uuid string - resolve to :db/id first
    try {
      const q = '[:find (pull ?b [:db/id]) :in $ ?u :where [?b :block/uuid ?u]]';
      const rows = await logseq.DB.datascriptQuery(q, '#uuid "' + raw + '"');
      const rec = rows && rows[0] && rows[0][0];
      const dbid = rec && (rec[':db/id'] ?? rec.id);
      if (typeof dbid === 'number' && dbid > 0) e = dbid;
    } catch {}
  } else {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) e = n;
  }
  if (e == null) return undefined;
  const attr = attribute.startsWith(':') ? attribute : `:${attribute}`;
  try {
    const results = await logseq.DB.datascriptQuery(
      `[:find ?v :in $ ?e :where [?e ${attr} ?v]]`,
      e,
    );
    const row = Array.isArray(results) ? results[0] : null;
    return Array.isArray(row) ? row[0] : row;
  } catch {
    return undefined;
  }
}

async function resolveBlockIdentity(blockRef: string | number): Promise<string | number> {
  if (logseq.Editor.getBlock) {
    const block = await logseq.Editor.getBlock(blockRef).catch(() => null);
    const uuid = block ? blockId(block) : null;
    if (uuid) return uuid;
  }
  return blockRef;
}

async function findQueryChildIdFromChildren(parent: any): Promise<string | number | null> {
  const collect = (b: any): any[] => (b && Array.isArray(b.children) ? b.children : []);
  const pick = (kids: any[]): (string | number) | null => {
    for (const ch of kids) {
      const c = String(ch?.content ?? ch?.title ?? '').trim();
      if (isAdvancedQueryBlockContent(c)) {
        const id = blockId(ch);
        if (id) return id;
      }
    }
    return null;
  };
  let found = pick(collect(parent));
  if (found) return found;
  const pid = blockId(parent);
  if (pid && logseq.Editor.getBlock) {
    try {
      const fresh = await logseq.Editor.getBlock(pid).catch(() => null);
      if (fresh) {
        found = pick(collect(fresh));
        if (found) return found;
      }
    } catch {}
  }
  return null;
}

async function queryChildEntityIdFromParent(block: any): Promise<string | number | null> {
  const parentId = blockId(block);
  if (!parentId) return null;
  let props: Record<string, unknown> = {};
  if (logseq.Editor.getBlockProperties) {
    props = ((await logseq.Editor.getBlockProperties(parentId).catch(() => null)) ?? {}) as Record<
      string,
      unknown
    >;
  } else if (block?.properties) {
    props = block.properties as Record<string, unknown>;
  }
  const fromRef = propertyBlockRefId(
    readCanonicalProperty(props, 'query') ?? props[`:${QUERY_PROPERTY_KEY}`],
  );
  if (fromRef != null) return fromRef;
  // Fallback: scan hydrated children for the edn-bearing code child (handles cases where
  // getBlockProperties returns resolved edn body or other non-id for the special query prop)
  return await findQueryChildIdFromChildren(block);
}

export type HostQueryRepairCapability = {
  keyword: boolean;
  querySetup: boolean;
  hostScope: boolean;
  hostLogseqApi: boolean;
  hostToKeyword: boolean;
  hostFunction: boolean;
  hostInlineRunnerCapable: boolean;
};

function hostRepairPrimitives(host: LogseqHostWindow | null): Omit<
  HostQueryRepairCapability,
  'keyword' | 'querySetup'
> {
  const hostScope = Boolean(host);
  const hostLogseqApi = Boolean(host?.logseq?.api?.upsert_block_property);
  const hostToKeyword = Boolean(host?.logseq?.sdk?.utils?.to_keyword ?? host?.logseq?.sdk?.utils?.toKeyword);
  const hostFunction = Boolean(host?.Function);
  return {
    hostScope,
    hostLogseqApi,
    hostToKeyword,
    hostFunction,
    hostInlineRunnerCapable: hostScope && hostLogseqApi && hostToKeyword && hostFunction,
  };
}

/** Run a JS snippet in Logseq host scope (no Experiments.loadScripts). */
function runInHostScope(host: LogseqHostWindow, source: string): boolean {
  const HostFunction = host.Function;
  if (!HostFunction) return false;
  try {
    const runner = new HostFunction(source) as () => unknown;
    runner();
    return true;
  } catch {
    return false;
  }
}

const INLINE_HOST_KEYWORD_HELPER = `
if (typeof window.__lssUpsertKeywordProperty !== 'function') {
  window.__lssUpsertKeywordProperty = function (blockId, key, keywordName) {
    var utils = logseq.sdk && logseq.sdk.utils;
    var toKw = utils && (utils.to_keyword || utils.toKeyword);
    var upsert = logseq.api && logseq.api.upsert_block_property;
    if (!toKw || !upsert) throw new Error('host logseq api/sdk unavailable');
    var raw = String(keywordName ?? '').trim().replace(/^:/, '');
    if (!raw) throw new Error('empty keyword name');
    return upsert(blockId, key, toKw(raw));
  };
}
`;

const INLINE_HOST_QUERY_SETUP = `
(function () {
  var QUERY_CLASS = 'logseq.class/Query';
  var QUERY_PROP = 'logseq.property/query';
  var DISPLAY_TYPE = 'logseq.property.node/display-type';
  var CODE_LANG = 'logseq.property.code/lang';
  var COLLAPSED = 'block/collapsed?';

  function toKw(name) {
    var utils = logseq.sdk && logseq.sdk.utils;
    var fn = utils && (utils.to_keyword || utils.toKeyword);
    if (!fn) throw new Error('logseq.sdk.utils.to_keyword unavailable');
    return fn(String(name ?? '').trim().replace(/^:/, ''));
  }
  function blockUuid(ent) {
    if (!ent || typeof ent !== 'object') return null;
    var raw = ent[':block/uuid'] ?? ent.uuid ?? ent.blockUuid ?? null;
    return raw != null ? String(raw) : null;
  }
  function entityId(ent) {
    if (ent == null) return null;
    if (typeof ent === 'number') return ent;
    if (typeof ent === 'string' && /^\\d+$/.test(ent.trim())) return Number(ent);
    if (typeof ent === 'object') return ent.id ?? ent.dbId ?? ent[':db/id'] ?? null;
    return null;
  }
  async function upsertProp(blockId, key, value) {
    if (!logseq.api || !logseq.api.upsert_block_property) {
      throw new Error('logseq.api.upsert_block_property unavailable');
    }
    return await logseq.api.upsert_block_property(blockId, key, value);
  }
  async function upsertDisplayTypeCode(childEnt, childId) {
    var childUuid = blockUuid(childEnt);
    var target = childUuid || childId;
    if (typeof window.__lssUpsertKeywordProperty === 'function') {
      return await window.__lssUpsertKeywordProperty(target, DISPLAY_TYPE, 'code');
    }
    return await upsertProp(target, DISPLAY_TYPE, toKw('code'));
  }
  async function getBlock(uuidOrId) {
    if (logseq.api && logseq.api.get_block) {
      try { return await logseq.api.get_block(uuidOrId); } catch (_e) {}
    }
    if (logseq.api && logseq.api.datascript_query && typeof uuidOrId === 'string' && uuidOrId.length >= 32) {
      var q = '[:find (pull ?b [*]) :in $ ?buuid :where [?b :block/uuid ?buuid]]';
      var rows = await logseq.api.datascript_query(q, '#uuid "' + uuidOrId + '"');
      if (rows && rows[0] && rows[0][0]) return rows[0][0];
    }
    return null;
  }
  async function updateBlockTitle(blockId, title) {
    if (logseq.api && logseq.api.update_block) return await logseq.api.update_block(blockId, title);
    if (logseq.api && logseq.api.edit_block) return await logseq.api.edit_block(blockId, title);
    throw new Error('logseq.api.update_block/edit_block unavailable');
  }
  function readQueryChild(parent) {
    if (!parent) return null;
    return parent[QUERY_PROP] ?? parent[':' + QUERY_PROP] ?? null;
  }

  async function waitForChild(pId, pUuid, maxTries = 6) {
    for (let i = 0; i < maxTries; i++) {
      await new Promise(r => setTimeout(r, 80));
      var p = await getBlock(pUuid);
      var c = readQueryChild(p);
      var cid = entityId(c);
      if (cid != null) return { parent: p, childEnt: c, childId: cid };
    }
    return null;
  }

  window.__lssConfigureDbAdvancedQuery = async function (parentUuid, ednContent) {
    var edn = String(ednContent ?? '').trim();
    if (!edn) throw new Error('empty EDN');
    var parent = await getBlock(parentUuid);
    if (!parent) throw new Error('parent block not found: ' + parentUuid);
    var parentId = entityId(parent);
    if (parentId == null) throw new Error('parent block has no entity id');
    await upsertProp(parentId, 'block/tags', toKw(QUERY_CLASS));
    var childEnt = readQueryChild(parent);
    var childId = entityId(childEnt);
    if (childId == null) {
      await upsertProp(parentId, QUERY_PROP, '');
      var waited = await waitForChild(parentId, parentUuid);
      if (waited) {
        parent = waited.parent;
        childEnt = waited.childEnt;
        childId = waited.childId;
      }
    }
    if (childId == null && logseq.api && logseq.api.insert_block) {
      try {
        var inserted = await logseq.api.insert_block(parentId, '', { sibling: false, before: false, end: true });
        childId = entityId(inserted);
        childEnt = inserted;
      } catch (_e) {}
    }
    if (childId == null) throw new Error('logseq.property/query child was not created');
    childEnt = (await getBlock(childId)) || childEnt;
    var childRef = blockUuid(childEnt) || childId;
    var parentRef = blockUuid(parent) || parentId;
    await upsertProp(childRef, CODE_LANG, 'clojure');
    await upsertProp(parentRef, QUERY_PROP, childId);
    try {
      await updateBlockTitle(childRef, edn);
      await updateBlockTitle(parentRef, '');
    } catch (_titleError) {}
    // Set display :code late, after titles are in place (more reliable)
    await upsertDisplayTypeCode(childEnt, childId);
    // Extra attempt + small wait + one more
    await new Promise(r => setTimeout(r, 60));
    await upsertDisplayTypeCode(childEnt, childId);
    await new Promise(r => setTimeout(r, 60));
    await upsertDisplayTypeCode(childEnt, childId);
    await upsertProp(parentRef, COLLAPSED, false);
    return { ok: true, parentId: parentId, childId: childId, childUuid: blockUuid(childEnt) };
  };

  // safety wrapper always re-applied
  var _origSetup = window.__lssConfigureDbAdvancedQuery;
  window.__lssConfigureDbAdvancedQuery = async function (parentUuid, ednContent) {
    try {
      var p = await getBlock(parentUuid);
      if (p) {
        var qref = p[QUERY_PROP] ?? p[':' + QUERY_PROP];
        var cid = entityId(qref);
        if (cid != null) {
          var c = await getBlock(cid);
          var cc = c ? String(c[':block/content'] ?? c.content ?? c.title ?? '').trim() : '';
          if (!c || !/^\\s*\\{[\\s\\S]*:query\\s+\\[:find/i.test(cc)) {
            if (logseq.api && logseq.api.remove_block) {
              await logseq.api.remove_block(cid).catch(() => {});
            }
            await upsertProp(entityId(p), QUERY_PROP, '');
          }
        }
      }
    } catch (e) {}
    return _origSetup(parentUuid, ednContent);
  };
})();
`;

function installInlineHostKeywordHelper(host: LogseqHostWindow): boolean {
  if (host.__lssUpsertKeywordProperty) return true;
  if (!hostRepairPrimitives(host).hostInlineRunnerCapable) return false;
  return runInHostScope(host, INLINE_HOST_KEYWORD_HELPER) && Boolean(host.__lssUpsertKeywordProperty);
}

function installInlineHostQuerySetup(host: LogseqHostWindow): boolean {
  if (!hostRepairPrimitives(host).hostInlineRunnerCapable) return false;
  installInlineHostKeywordHelper(host);
  // Always (re)run the source to (re)install — the old "if already" check was too early.
  const ok = runInHostScope(host, INLINE_HOST_QUERY_SETUP);
  return ok && typeof host.__lssConfigureDbAdvancedQuery === 'function';
}

export async function hostQueryRepairScriptsReady(): Promise<HostQueryRepairCapability> {
  const host = getLogseqHostWindow();
  const primitives = hostRepairPrimitives(host);
  if (host) {
    installInlineHostKeywordHelper(host);
    installInlineHostQuerySetup(host);
  }
  const keyword = await ensureHostKeywordHelperScript();
  const querySetup = Boolean(await ensureHostQuerySetupScript());
  return { ...primitives, keyword, querySetup };
}

export async function blockHasQueryClassTag(blockIdentity: string | number): Promise<boolean> {
  const target = String(blockIdentity);
  if (logseq.Editor.getTagObjects) {
    for (const tagName of QUERY_CLASS_TAG_NAMES) {
      const objects = await logseq.Editor.getTagObjects(tagName).catch(() => null);
      if (
        objects?.some((obj) => {
          const record = obj as Record<string, unknown>;
          return String(record.uuid ?? '') === target || String(record.id ?? '') === target;
        })
      ) {
        return true;
      }
    }
  }
  if (logseq.Editor.getBlock) {
    const block = await logseq.Editor.getBlock(blockIdentity).catch(() => null);
    if (block) {
      const record = block as Record<string, unknown>;
      const tags = record.tags ?? (record.properties as Record<string, unknown> | undefined)?.tags;
      const names = new Set<string>();
      const collect = (tag: unknown) => {
        if (typeof tag === 'string') names.add(safeTag(tag).toLowerCase());
        else if (tag && typeof tag === 'object') {
          const r = tag as Record<string, unknown>;
          const name = r.name ?? r.originalName ?? r.title ?? r.ident;
          if (name) names.add(String(name).toLowerCase());
        }
      };
      if (Array.isArray(tags)) tags.forEach(collect);
      if (names.has('query') || names.has('logseq.class/query')) return true;
    }
  }
  return false;
}

export async function inspectDbQueryBlockStructure(block: any): Promise<DbQueryBlockStructure> {
  const id = blockId(block);
  const parentContent = String(block?.content ?? '').trim();
  const rawEdnInParentContent = isAdvancedQueryBlockContent(parentContent);
  let hasQueryProperty = false;
  let hasCodeChild = false;
  let queryEdnInChild = false;
  let childDisplayTypeIsCode = false;
  let childTitleHasEdn = false;

  let props: Record<string, unknown> = {};
  if (id && logseq.Editor.getBlockProperties) {
    props = ((await logseq.Editor.getBlockProperties(id).catch(() => null)) ?? {}) as Record<string, unknown>;
  } else if (block?.properties) {
    props = block.properties as Record<string, unknown>;
  }

  const parentCollapsedRaw =
    readCanonicalProperty(props, 'block/collapsed?') ?? readCanonicalProperty(props, 'collapsed?');
  const parentCollapsed = parentCollapsedRaw === true || String(parentCollapsedRaw ?? '').toLowerCase() === 'true';

  const queryRef = readCanonicalProperty(props, 'query') ?? props[`:${QUERY_PROPERTY_KEY}`];
  const childId = propertyBlockRefId(queryRef);
  if (childId != null) {
    hasQueryProperty = true;
    if (logseq.Editor.getBlock) {
      const child = await logseq.Editor.getBlock(childId).catch(() => null);
      if (child) {
        const childRecord = child as Record<string, unknown>;
        const childContent = String(childRecord.content ?? childRecord.title ?? '').trim();
        queryEdnInChild = isAdvancedQueryBlockContent(childContent);
        childTitleHasEdn = queryEdnInChild;
        let childProps: Record<string, unknown> = {};
        if (logseq.Editor.getBlockProperties) {
          childProps =
            ((await logseq.Editor.getBlockProperties(childId).catch(() => null)) ?? {}) as Record<string, unknown>;
        }
        const displayType = readCanonicalProperty(childProps, 'node/display-type')
          ?? readCanonicalProperty(childProps, 'display-type');
        const codeLang = readCanonicalProperty(childProps, 'code/lang');
        const dsDisplayType = await readBlockDatascriptProperty(childId, QUERY_DISPLAY_TYPE_KEY);
        const dsCodeLang = await readBlockDatascriptProperty(childId, QUERY_CODE_LANG_KEY);
        childDisplayTypeIsCode =
          displayTypeIsCodeKeyword(displayType) || displayTypeIsCodeKeyword(dsDisplayType);
        const langIsClojure =
          String(codeLang ?? dsCodeLang ?? '')
            .trim()
            .toLowerCase() === 'clojure';
        hasCodeChild = queryEdnInChild && childDisplayTypeIsCode && langIsClojure;
      }
    }
  }

  // Fallback: scan direct children in snapshot for an edn-bearing child even if
  // the logseq.property/query ref is not exposed by getBlockProperties.
  if (!hasQueryProperty && Array.isArray(block?.children)) {
    for (const ch of block.children) {
      const ccontent = String(ch?.content ?? ch?.title ?? '').trim();
      if (isAdvancedQueryBlockContent(ccontent)) {
        hasQueryProperty = true;
        queryEdnInChild = true;
        childTitleHasEdn = true;
        const cid = blockId(ch);
        if (cid != null && logseq.Editor.getBlockProperties) {
          try {
            const cprops = (await logseq.Editor.getBlockProperties(cid).catch(() => ({}))) || {};
            const displayType = readCanonicalProperty(cprops, 'node/display-type') ?? readCanonicalProperty(cprops, 'display-type');
            const codeLang = readCanonicalProperty(cprops, 'code/lang');
            const dsDisplayType = await readBlockDatascriptProperty(cid, QUERY_DISPLAY_TYPE_KEY);
            const dsCodeLang = await readBlockDatascriptProperty(cid, QUERY_CODE_LANG_KEY);
            childDisplayTypeIsCode = displayTypeIsCodeKeyword(displayType) || displayTypeIsCodeKeyword(dsDisplayType);
            const langIsClojure = String(codeLang ?? dsCodeLang ?? '').trim().toLowerCase() === 'clojure';
            hasCodeChild = childDisplayTypeIsCode && langIsClojure;
          } catch {}
        }
        break;
      }
    }
  }

  const hasQueryClassTag = id != null ? await blockHasQueryClassTag(id) : false;
  return {
    hasQueryClassTag,
    hasQueryProperty,
    hasCodeChild,
    rawEdnInParentContent,
    queryEdnInChild,
    childDisplayTypeIsCode,
    childTitleHasEdn,
    parentCollapsed,
  };
}

export async function resolveQueryClassTagId(): Promise<string | number | null> {
  if (!logseq.Editor.getTag) return null;
  for (const name of QUERY_CLASS_TAG_NAMES) {
    const tag = await logseq.Editor.getTag(name).catch(() => null);
    const id = tag ? entityIdentity(tag) : null;
    if (id != null) return id;
  }
  return null;
}

function normalizeDisplayTypeToken(value: unknown): string {
  if (value == null) return '';
  return String(value).trim().toLowerCase().replace(/^:/, '');
}

/** Strip leading colon from a display-type / keyword token (e.g. ":code" → "code"). */
export function normalizeKeywordPropertyName(name: string): string {
  return String(name ?? '').trim().replace(/^:/, '');
}

type LogseqHostWindow = Window & {
  Function?: typeof Function;
  __lssConfigureDbAdvancedQuery?: (
    parentBlockUuid: string,
    ednContent: string,
  ) => Promise<{ ok: boolean; parentId?: number; childId?: number }>;
  __lssUpsertKeywordProperty?: (
    blockId: string | number,
    key: string,
    keywordName: string,
  ) => Promise<void> | void;
  logseq?: {
    api?: {
      upsert_block_property?: (
        id: string | number,
        key: string,
        value: unknown,
        options?: { reset?: boolean },
      ) => Promise<void> | void;
    };
    sdk?: {
      utils?: {
        to_keyword?: (input: string) => unknown;
        toKeyword?: (input: string) => unknown;
      };
    };
  };
};

function getLogseqHostWindow(): LogseqHostWindow | null {
  try {
    const experiments = logseq.Experiments as { ensureHostScope?: () => LogseqHostWindow } | undefined;
    const host = experiments?.ensureHostScope?.() ?? window.top;
    return (host ?? null) as LogseqHostWindow | null;
  } catch {
    return null;
  }
}

let hostKeywordScriptReady: Promise<boolean> | null = null;
let hostQuerySetupScriptReady: Promise<HostConfigureDbAdvancedQuery | null> | null = null;

async function ensureHostKeywordHelperScript(): Promise<boolean> {
  const host = getLogseqHostWindow();
  if (host?.__lssUpsertKeywordProperty) return true;
  if (host && installInlineHostKeywordHelper(host)) return true;
  if (hostKeywordScriptReady) return hostKeywordScriptReady;
  hostKeywordScriptReady = (async () => {
    if (getLogseqHostWindow()?.__lssUpsertKeywordProperty) return true;
    const retryHost = getLogseqHostWindow();
    if (retryHost && installInlineHostKeywordHelper(retryHost)) return true;
    if (!logseq.Experiments?.loadScripts || !logseq.resolveResourceFullUrl) return false;
    try {
      await logseq.Experiments.loadScripts(logseq.resolveResourceFullUrl('lss-host-keyword.js'));
      return Boolean(getLogseqHostWindow()?.__lssUpsertKeywordProperty);
    } catch {
      return false;
    }
  })();
  return hostKeywordScriptReady;
}

type HostConfigureDbAdvancedQuery = (
  parentBlockUuid: string,
  ednContent: string,
) => Promise<{ ok: boolean; parentId?: number; childId?: number; childUuid?: string }>;

async function ensureHostQuerySetupScript(): Promise<HostConfigureDbAdvancedQuery | null> {
  const host = getLogseqHostWindow();
  const existing = host?.__lssConfigureDbAdvancedQuery as HostConfigureDbAdvancedQuery | null | undefined;
  if (typeof existing === 'function') return existing;
  if (host && installInlineHostQuerySetup(host)) {
    const fn = host.__lssConfigureDbAdvancedQuery;
    if (typeof fn === 'function') return fn as HostConfigureDbAdvancedQuery;
  }
  // Force another inline attempt
  if (host && installInlineHostQuerySetup(host)) {
    const fn = host.__lssConfigureDbAdvancedQuery;
    if (typeof fn === 'function') return fn as HostConfigureDbAdvancedQuery;
  }
  if (hostQuerySetupScriptReady) return hostQuerySetupScriptReady;
  hostQuerySetupScriptReady = (async () => {
    let h = getLogseqHostWindow();
    if (h && installInlineHostQuerySetup(h)) {
      const fn = h.__lssConfigureDbAdvancedQuery;
      if (typeof fn === 'function') return fn as HostConfigureDbAdvancedQuery;
    }
    h = getLogseqHostWindow();
    if (h && installInlineHostQuerySetup(h)) {
      const fn = h.__lssConfigureDbAdvancedQuery;
      if (typeof fn === 'function') return fn as HostConfigureDbAdvancedQuery;
    }
    if (!logseq.Experiments?.loadScripts || !logseq.resolveResourceFullUrl) return null;
    try {
      await ensureHostKeywordHelperScript();
      await logseq.Experiments.loadScripts(logseq.resolveResourceFullUrl('lss-host-query-setup.js'));
      const fn = getLogseqHostWindow()?.__lssConfigureDbAdvancedQuery;
      return typeof fn === 'function' ? (fn as HostConfigureDbAdvancedQuery) : null;
    } catch {
      return null;
    }
  })();
  return hostQuerySetupScriptReady;
}

async function configureDbAdvancedQueryBlockViaHost(
  parentUuid: string,
  edn: string,
): Promise<{ ok: boolean; error?: string; childId?: string | number }> {
  const configure = await ensureHostQuerySetupScript();
  if (!configure) return { ok: false, error: 'host query setup script unavailable' };
  try {
    const result = await Promise.resolve(configure(parentUuid, edn));
    if (result?.ok) return { ok: true, childId: result.childId ?? result.childUuid ?? undefined };
    return { ok: false, error: 'host configure returned not ok' };
  } catch (error) {
    return { ok: false, error: formatError(error) };
  }
}

/**
 * Keyword-typed DB properties (e.g. logseq.property.node/display-type) must be real cljs keywords.
 * logseq.Editor.upsertBlockProperty serializes values over IPC, so :code becomes a string and fails
 * malli validation ("should be a Clojure keyword"). Run upsert_block_property + to_keyword entirely
 * inside the host window so the keyword never crosses the plugin iframe boundary.
 */
async function collectBlockIdentityCandidates(
  blockIdentity: string | number,
): Promise<Array<string | number>> {
  const candidates: Array<string | number> = [blockIdentity];
  const alt = await resolveBlockIdentity(blockIdentity).catch(() => null);
  if (alt != null && !candidates.some((id) => String(id) === String(alt))) {
    candidates.push(alt);
  }
  const numeric = Number(blockIdentity);
  if (Number.isFinite(numeric) && numeric > 0 && !candidates.some((id) => Number(id) === numeric)) {
    candidates.push(numeric);
  }
  return candidates;
}

async function upsertKeywordBlockPropertyHost(
  blockIdentity: string | number,
  key: string,
  keywordName: string,
): Promise<{ ok: boolean; error?: string }> {
  const raw = normalizeKeywordPropertyName(keywordName);
  if (!raw) return { ok: false, error: 'empty keyword name' };

  await ensureHostKeywordHelperScript();
  const host = getLogseqHostWindow();
  if (!host) return { ok: false, error: 'host scope unavailable' };
  if (!host.__lssUpsertKeywordProperty) {
    installInlineHostKeywordHelper(host);
  }

  let identities = await collectBlockIdentityCandidates(blockIdentity);
  // Filter out ids that are clearly edn content (from misread query prop) or invalid
  identities = identities.filter((id) => {
    const s = String(id);
    if (s.includes('{') || s.includes(':query') || s.includes(':title') || s.length > 120) return false;
    return isPlausibleBlockIdentity(id) || typeof id === 'number';
  });
  if (!identities.length) {
    return { ok: false, error: 'no valid block id candidate (edn or non-id leaked as query ref)' };
  }

  const errors: string[] = [];

  const verifyKeyword = async (identity: string | number): Promise<boolean> => {
    const stored = await readBlockDatascriptProperty(identity, key);
    return displayTypeIsCodeKeyword(stored) || normalizeDisplayTypeToken(stored) === raw;
  };

  const tryWithRetries = async (fn: (id: string | number) => Promise<void>, identity: string | number, label: string): Promise<boolean> => {
    for (let r = 0; r < 3; r++) {
      try {
        await fn(identity);
        await sleep(60 + r * 30);
        if (await verifyKeyword(identity)) return true;
      } catch (e) {
        if (r === 2) errors.push(`${label}(${identity}): ${formatError(e)}`);
      }
    }
    if (!errors.some((e) => e.includes(String(identity)))) {
      errors.push(`${label}: upsert did not persist for ${identity}`);
    }
    return false;
  };

  if (host.__lssUpsertKeywordProperty) {
    for (const identity of identities) {
      const ok = await tryWithRetries(
        (id) => Promise.resolve(host.__lssUpsertKeywordProperty!(id, key, raw)),
        identity,
        'host-script'
      );
      if (ok) return { ok: true };
    }
  } else {
    errors.push('host-script: __lssUpsertKeywordProperty not installed');
  }

  const api = host.logseq?.api;
  const utils = host.logseq?.sdk?.utils;
  const toKeyword = utils?.to_keyword ?? utils?.toKeyword;
  if (api?.upsert_block_property && toKeyword) {
    const HostFunction = host.Function as typeof Function | undefined;
    if (HostFunction) {
      const runner = new HostFunction(
        'blockId',
        'propKey',
        'kwName',
        `var utils = logseq.sdk.utils;
         var toKw = utils.to_keyword || utils.toKeyword;
         return logseq.api.upsert_block_property(blockId, propKey, toKw(kwName));`,
      ) as (blockId: string | number, propKey: string, kwName: string) => Promise<void> | void;
      for (const identity of identities) {
        const ok = await tryWithRetries(
          (id) => Promise.resolve(runner(id, key, raw)),
          identity,
          'host-runner'
        );
        if (ok) return { ok: true };
      }
    } else {
      errors.push('host-runner: host.Function unavailable');
    }
    for (const identity of identities) {
      const ok = await tryWithRetries(
        (id) => Promise.resolve(api.upsert_block_property!(id, key, toKeyword(raw))),
        identity,
        'direct'
      );
      if (ok) return { ok: true };
    }
  } else {
    errors.push('host logseq.api.upsert_block_property or sdk.utils.to_keyword unavailable');
  }

  return { ok: false, error: errors.join('; ') };
}

async function upsertQueryBlockProperty(
  blockIdentity: string | number,
  key: string,
  value: unknown,
): Promise<void> {
  if (!logseq.Editor.upsertBlockProperty) return;
  await logseq.Editor.upsertBlockProperty(blockIdentity, key, value);
  await sleep(15);
}

/** Always run host keyword upsert for display-type :code — required for Logseq UI query rendering. */
async function finalizeDbAdvancedQueryBlockUi(
  result: Result,
  parentBlock: any,
  knownChildId: string | number | null = null,
): Promise<DbQueryBlockStructure> {
  const parentId = blockId(parentBlock);
  const parent =
    parentId && logseq.Editor.getBlock
      ? ((await logseq.Editor.getBlock(parentId).catch(() => null)) ?? parentBlock)
      : parentBlock;

  // First check if already good (host configure already called upsertDisplayTypeCode inside)
  const pre = await inspectDbQueryBlockStructure(parent);
  if (pre.childDisplayTypeIsCode && pre.hasCodeChild && pre.childTitleHasEdn) {
    return pre;
  }

  let childNumericId = knownChildId ?? (await queryChildEntityIdFromParent(parent));
  if (childNumericId == null) {
    childNumericId = await findQueryChildIdFromChildren(parent);
  }
  if (childNumericId != null) {
    const idStr = String(childNumericId);
    if (idStr.includes('{') || idStr.includes(':query') || idStr.length > 120) {
      result.errors.push(
        `query child display-type :code host upsert skipped: invalid child id resolved (got edn-like instead of block ref)`,
      );
    } else {
      const childIdentity = await resolveBlockIdentity(childNumericId);
      // Be very insistent on the :code keyword (this is the last UI-BLOCKER)
      let displayOk = false;
      for (let i = 0; i < 5; i++) {
        const res = await upsertKeywordBlockPropertyHost(
          childIdentity,
          QUERY_DISPLAY_TYPE_KEY,
          'code',
        );
        if (res.ok) {
          displayOk = true;
          break;
        }
        await sleep(80);
      }
      if (displayOk) {
        result.actions.push('SET query child Node Display Type :code (host keyword)');
      } else {
        // last attempt via the helper directly if available
        const host = getLogseqHostWindow();
        if (host && host.__lssUpsertKeywordProperty) {
          try {
            await Promise.resolve(host.__lssUpsertKeywordProperty(childIdentity, QUERY_DISPLAY_TYPE_KEY, 'code'));
            await sleep(100);
            const afterTry = await inspectDbQueryBlockStructure(parent);
            if (afterTry.childDisplayTypeIsCode) displayOk = true;
          } catch {}
        }
        if (!displayOk) {
          result.errors.push(
            `query child display-type :code host upsert failed after retries`,
          );
        }
      }
      await upsertQueryBlockProperty(childIdentity, QUERY_CODE_LANG_KEY, 'clojure');
      if (parentId) {
        await upsertQueryBlockProperty(parentId, 'block/collapsed?', false);
      }
      await sleep(80);
    }
  }
  const refreshedParent =
    parentId && logseq.Editor.getBlock
      ? await logseq.Editor.getBlock(parentId).catch(() => null)
      : null;
  return inspectDbQueryBlockStructure(refreshedParent ?? parent);
}

/**
 * Delete a legacy raw-EDN query block and insert a fresh empty shell, then configure it.
 * In-place repair on blocks that still hold EDN in the parent often leaves Logseq in a bad state.
 */
export async function recreateDbAdvancedQueryBlock(
  result: Result,
  sectionBlock: any,
  existingQueryBlock: any,
  ednContent: string,
): Promise<boolean> {
  const sectionId = blockId(sectionBlock);
  const existingId = blockId(existingQueryBlock);
  if (!sectionId) return false;
  if (existingId && logseq.Editor.removeBlock) {
    try {
      await logseq.Editor.removeBlock(existingId);
      result.actions.push('REMOVE legacy dashboard query block (raw EDN shell)');
      await sleep(80);
    } catch (error) {
      result.notes.push(`recreateDbAdvancedQueryBlock: could not remove, attempting in-place fix: ${formatError(error)}`);
      // clear parent content and try configure in place instead of failing
      if (logseq.Editor.updateBlock) {
        await logseq.Editor.updateBlock(existingId, '').catch(() => {});
      }
      return configureDbAdvancedQueryBlock(result, existingQueryBlock, ednContent);
    }
  }
  if (!logseq.Editor.insertBlock) {
    result.errors.push('recreateDbAdvancedQueryBlock: insertBlock API unavailable');
    return false;
  }
  const inserted = await logseq.Editor.insertBlock(sectionId, '', {
    sibling: false,
    before: false,
    end: true,
  });
  if (!inserted) {
    result.errors.push('recreateDbAdvancedQueryBlock: failed to insert empty query shell');
    return false;
  }
  result.actions.push('INSERT fresh empty query shell under dashboard section');
  await sleep(50);
  return configureDbAdvancedQueryBlock(result, inserted, ednContent);
}

/** Convert a raw-EDN block into Logseq DB /Advanced Query shape (#Query + logseq.property/query code child). */
export async function configureDbAdvancedQueryBlock(
  result: Result,
  block: any,
  ednContent: string,
): Promise<boolean> {
  const edn = String(ednContent ?? '').trim();
  const parentId = blockId(block);
  if (!parentId || !edn || !isAdvancedQueryBlockContent(edn)) return false;
  if (!(await isDbGraph())) return false;

  try {
    const hostConfigured = await configureDbAdvancedQueryBlockViaHost(parentId, edn);
    let hostChildId: string | number | null = hostConfigured.childId ?? null;
    if (hostConfigured.ok) {
      result.actions.push('CONFIGURE DB advanced query via host (/Advanced Query native steps)');
      await sleep(120); // allow internal keyword sets to land before we inspect/finalize
    } else {
      result.notes.push(
        `Host /Advanced Query setup unavailable (${hostConfigured.error ?? 'unknown'}); falling back to plugin IPC configure`,
      );
    }

    if (!hostConfigured.ok) {
      // Prefer raw host api when available (more reliable for special query prop + tag)
      const hostWin = getLogseqHostWindow();
      const hostApi = hostWin && hostWin.logseq && hostWin.logseq.api;

      const setProp = async (id: any, key: string, val: any) => {
        if (hostApi && hostApi.upsert_block_property) {
          try { await Promise.resolve(hostApi.upsert_block_property(id, key, val)); await sleep(20); return; } catch {}
        }
        // Fallbacks
        if (logseq.Editor.upsertBlockProperty) {
          await logseq.Editor.upsertBlockProperty(id, key, val).catch(() => {});
          await sleep(15);
        }
        await upsertQueryBlockProperty(id, 'query', val).catch(() => {}); // last attempt for the short key
      };

      // Ensure tag using host api if possible
      if (hostApi && hostApi.upsert_block_property) {
        try { await hostApi.upsert_block_property(parentId, 'block/tags', (hostWin.logseq.sdk.utils.to_keyword || hostWin.logseq.sdk.utils.toKeyword)('Query')); } catch {}
      }
      const queryTagId = await resolveQueryClassTagId();
      if (queryTagId != null && logseq.Editor.addBlockTag && !(await blockHasQueryClassTag(parentId))) {
        await logseq.Editor.addBlockTag(parentId, queryTagId).catch(() => {});
        await sleep(15);
      }

      // Trigger the official child creation the same way the host script does:
      // set the query prop to empty string on a #Query block.
      await setProp(parentId, QUERY_PROPERTY_KEY, '');
      result.actions.push('SET QUERY_PROP="" to trigger system query child');
      await sleep(120);  // give Logseq time to auto-create the special child

      // Try to discover the system-created child
      let childId: string | number | null = await queryChildEntityIdFromParent({ uuid: parentId } as any);
      if (childId == null) childId = await findQueryChildIdFromChildren({ uuid: parentId, children: [] });

      let childBlock: any = null;
      if (childId == null && logseq.Editor.insertBlock) {
        // Fallback: manually insert
        childBlock = await logseq.Editor.insertBlock(parentId, '', { sibling: false, before: false, end: true });
        childId = childBlock ? blockId(childBlock) : null;
        result.actions.push('INSERT query code child (fallback)');
        await sleep(30);
      } else if (childId != null) {
        result.actions.push('DISCOVERED system query child after empty-prop trigger');
        if (logseq.Editor.getBlock) {
          childBlock = await logseq.Editor.getBlock(childId).catch(() => null);
        }
      }

      if (!childId) {
        result.errors.push('configureDbAdvancedQueryBlock: failed to obtain query code child');
        return false;
      }

      // Set EDN on the child (prefer raw api.update_block)
      let ednSet = false;
      const useUpdate: any = (hostApi && (hostApi as any).update_block) ? (hostApi as any).update_block : (logseq.api && (logseq.api as any).update_block);
      if (useUpdate) {
        try {
          await Promise.resolve(useUpdate(childId, edn));
          result.actions.push('SET EDN on code child via update_block');
          ednSet = true;
        } catch (e) {}
      }
      if (!ednSet && childBlock) {
        await updateBlockContent(result, childBlock, edn, 'Set EDN into query code child');
      } else if (!ednSet) {
        // last resort via Editor
        if (logseq.Editor.updateBlock) await logseq.Editor.updateBlock(childId as any, edn).catch(() => {});
      }

      await setProp(childId, QUERY_CODE_LANG_KEY, 'clojure');
      await setProp(parentId, QUERY_PROPERTY_KEY, childId);
      await updateBlockContent(result, block, '', 'Clear raw EDN from query parent shell');
      await setProp(parentId, 'block/collapsed?', false);
    }

    let after = await finalizeDbAdvancedQueryBlockUi(result, block, hostChildId);
    let repaired = !dbAdvancedQueryBlockNeedsStructureRepair(after);
    if (!repaired) {
      await sleep(100);
      after = await finalizeDbAdvancedQueryBlockUi(result, block, hostChildId);
      repaired = !dbAdvancedQueryBlockNeedsStructureRepair(after);
    }
    if (!repaired) {
      result.notes.push(
        `NOTE: query UI finalize incomplete (tag=${after.hasQueryClassTag ? 'yes' : 'no'}, query-prop=${after.hasQueryProperty ? 'yes' : 'no'}, code-child=${after.hasCodeChild ? 'yes' : 'no'}, child-edn=${after.childTitleHasEdn ? 'yes' : 'no'}, display-code=${after.childDisplayTypeIsCode ? 'yes' : 'no'}, collapsed=${after.parentCollapsed ? 'yes' : 'no'})`,
      );
    }
    return repaired;
  } catch (error) {
    result.errors.push(`configureDbAdvancedQueryBlock: ${formatError(error)}`);
    return false;
  }
}

/** Host-only repair for query child display-type :code when EDN is already present. */
export async function repairDbQueryBlockUiKeywords(result: Result, block: any): Promise<boolean> {
  const after = await finalizeDbAdvancedQueryBlockUi(result, block, null);
  return !dbAdvancedQueryBlockNeedsStructureRepair(after);
}

/**
 * Force-create the code child for an existing #Query shell that is missing it.
 * This is a direct, reliable path when the shell (tag + prop) exists but no child.
 * Uses insert + direct sets, then finalize for :code.
 */
export async function forceCreateQueryChild(result: Result, block: any, ednContent: string): Promise<boolean> {
  const parentId = blockId(block);
  const edn = String(ednContent ?? '').trim();
  if (!parentId || !edn || !isAdvancedQueryBlockContent(edn)) {
    result.errors.push('forceCreateQueryChild: prerequisites not met');
    return false;
  }

  // Clear any bad child and the query prop to give the host a clean shell
  let childId = propertyBlockRefId(
    block?.properties ? readCanonicalProperty(block.properties as Record<string, unknown>, 'query') : null,
  );
  if (!childId && logseq.Editor.getBlockProperties) {
    try {
      const props = (await logseq.Editor.getBlockProperties(parentId).catch(() => null)) ?? {};
      childId = propertyBlockRefId(readCanonicalProperty(props, 'query'));
    } catch {}
  }
  if (childId && logseq.Editor.removeBlock) {
    await logseq.Editor.removeBlock(childId).catch(() => {});
    result.actions.push('REMOVE bad child for clean host setup');
    await sleep(30);
  }
  await upsertQueryBlockProperty(parentId, QUERY_PROPERTY_KEY, '');
  await sleep(20);

  // Prefer the dedicated host function, which is designed exactly for this
  const hostConfigured = await configureDbAdvancedQueryBlockViaHost(parentId, edn);
  if (hostConfigured.ok) {
    result.actions.push('CONFIGURE via host in forceCreateQueryChild');
    let after = await finalizeDbAdvancedQueryBlockUi(result, block, hostConfigured.childId ?? null);
    if (dbAdvancedQueryBlockNeedsStructureRepair(after)) {
      await sleep(80);
      after = await finalizeDbAdvancedQueryBlockUi(result, block, hostConfigured.childId ?? null);
    }
    return !dbAdvancedQueryBlockNeedsStructureRepair(after);
  }

  // Fallback direct creation
  if (!logseq.Editor.insertBlock) {
    result.errors.push('forceCreateQueryChild: insertBlock unavailable');
    return false;
  }

  const childBlock = await logseq.Editor.insertBlock(parentId, '', {
    sibling: false,
    before: false,
    end: true,
  });
  childId = childBlock ? blockId(childBlock) : null;
  if (!childId) {
    result.errors.push('forceCreateQueryChild: insert failed');
    return false;
  }
  result.actions.push('INSERT code child (force fallback)');
  await sleep(20);

  // Set EDN
  let ednSet = false;
  if (logseq.api && logseq.api.update_block) {
    try {
      await logseq.api.update_block(childId, edn);
      result.actions.push('SET EDN via api.update_block');
      ednSet = true;
    } catch (e) {}
  }
  if (!ednSet) {
    await updateBlockContent(result, childBlock, edn, 'Set EDN');
  }

  await upsertQueryBlockProperty(childId, QUERY_CODE_LANG_KEY, 'clojure');
  await upsertQueryBlockProperty(parentId, QUERY_PROPERTY_KEY, childId);
  await updateBlockContent(result, block, '', 'Clear parent');
  await upsertQueryBlockProperty(parentId, 'block/collapsed?', false);

  const after = await finalizeDbAdvancedQueryBlockUi(result, block);
  const ok = !dbAdvancedQueryBlockNeedsStructureRepair(after);
  if (!ok) {
    result.notes.push('force fallback: still incomplete');
  }
  return ok;
}

/**
 * Fix child in place: for blocks that already have the #Query tag and query prop,
 * but no proper code child (common after partial repairs or manual edits).
 * This avoids removing the parent shell (which can fail or change block position).
 * Always creates a fresh child with EDN and lets finalize set :code.
 */
export async function fixDbQueryChild(result: Result, block: any, ednContent: string): Promise<boolean> {
  const parentId = blockId(block);
  const edn = String(ednContent ?? '').trim();
  if (!parentId || !edn || !isAdvancedQueryBlockContent(edn) || !logseq.Editor.insertBlock) {
    result.errors.push('fixDbQueryChild: prerequisites not met');
    return false;
  }

  // Remove any bad child
  let childId = propertyBlockRefId(
    block?.properties ? readCanonicalProperty(block.properties as Record<string, unknown>, 'query') : null,
  );
  if (!childId && logseq.Editor.getBlockProperties) {
    const props = (await logseq.Editor.getBlockProperties(parentId).catch(() => null)) ?? {};
    childId = propertyBlockRefId(readCanonicalProperty(props as Record<string, unknown>, 'query'));
  }
  if (childId && logseq.Editor.removeBlock) {
    await logseq.Editor.removeBlock(childId).catch(() => {});
    result.actions.push('REMOVE bad code child (in-place fix)');
    await sleep(30);
  }

  // Clear prop to be safe
  await upsertQueryBlockProperty(parentId, QUERY_PROPERTY_KEY, '');
  await sleep(20);

  // Insert fresh child
  const childBlock = await logseq.Editor.insertBlock(parentId, '', {
    sibling: false,
    before: false,
    end: true,
  });
  childId = childBlock ? blockId(childBlock) : null;
  if (!childId) {
    result.errors.push('fixDbQueryChild: failed to insert code child');
    return false;
  }
  result.actions.push('INSERT code child (in-place fix)');
  await sleep(20);

  // Set EDN on child (prefer api.update_block like host)
  let ednSet = false;
  if (logseq.api && logseq.api.update_block) {
    try {
      await logseq.api.update_block(childId, edn);
      result.actions.push('SET EDN on code child via api.update_block');
      ednSet = true;
    } catch (e) {}
  }
  if (!ednSet) {
    await updateBlockContent(result, childBlock, edn, 'Set EDN into code child');
  }

  await upsertQueryBlockProperty(childId, QUERY_CODE_LANG_KEY, 'clojure');
  await upsertQueryBlockProperty(parentId, QUERY_PROPERTY_KEY, childId);
  await updateBlockContent(result, block, '', 'Clear parent content');
  await upsertQueryBlockProperty(parentId, 'block/collapsed?', false);

  const after = await finalizeDbAdvancedQueryBlockUi(result, block);
  const repaired = !dbAdvancedQueryBlockNeedsStructureRepair(after);
  if (!repaired) {
    result.notes.push(
      `NOTE: in-place child fix incomplete (code-child=${after.hasCodeChild ? 'yes' : 'no'}, child-edn=${after.childTitleHasEdn ? 'yes' : 'no'}, display-code=${after.childDisplayTypeIsCode ? 'yes' : 'no'})`,
    );
  }
  return repaired;
}

export async function readQueryChildDisplayTypeRaw(
  queryBlock: any,
): Promise<string> {
  const childId = await queryChildEntityIdFromParent(queryBlock);
  if (childId == null) return '(no query child)';
  const ds = await readBlockDatascriptProperty(childId, QUERY_DISPLAY_TYPE_KEY);
  if (ds == null || ds === undefined) return '(unset)';
  if (typeof ds === 'object') {
    const record = ds as Record<string, unknown>;
    const ns = String(record.ns ?? record[':ns'] ?? '').trim();
    const name = String(record.name ?? record[':name'] ?? '').trim();
    if (name) return ns ? `:${ns}/${name}` : `:${name}`;
  }
  return String(ds);
}

export function dbAdvancedQueryBlockNeedsStructureRepair(struct: DbQueryBlockStructure): boolean {
  return (
    !struct.hasQueryClassTag ||
    !struct.hasQueryProperty ||
    !struct.hasCodeChild ||
    !struct.childTitleHasEdn ||
    !struct.childDisplayTypeIsCode ||
    struct.rawEdnInParentContent ||
    struct.parentCollapsed
  );
}

/** Run stored advanced EDN with an explicit venture page id for `?current` (plugin probes lack :current-page). */
export async function runAdvancedQueryDatascriptProbe(
  content: string,
  venturePageId: number,
): Promise<unknown[]> {
  const queryVector = extractAdvancedQueryVector(content);
  if (!queryVector || !logseq.DB?.datascriptQuery) return [];
  try {
    const results = /\?current\b/.test(queryVector)
      ? await logseq.DB.datascriptQuery(queryVector, venturePageId)
      : await logseq.DB.datascriptQuery(queryVector);
    return Array.isArray(results) ? results : results == null ? [] : [results];
  } catch {
    return [];
  }
}

export function isAdvancedQueryBlockContent(content: string): boolean {
  const text = String(content ?? '').trim();
  if (/#\+BEGIN_QUERY/i.test(text)) return true;
  return /^\{[\s\S]*:query\s+\[:find/i.test(text);
}

export function isLegacyBeginQueryWrapper(content: string): boolean {
  return /#\+BEGIN_QUERY/i.test(String(content ?? ''));
}

export function queryBodyFromBlockContent(content: string): string {
  const text = String(content ?? '').trim();
  if (isAdvancedQueryBlockContent(text)) {
    return text.replace(/^#\+BEGIN_QUERY\s*/i, '').replace(/\s*#\+END_QUERY\s*$/i, '').trim();
  }
  return queryBodyFromContent(text);
}

async function resolvePageDbId(
  pageName?: string,
  page?: { originalName?: string; name?: string; title?: string; id?: number | string; uuid?: string } | null,
): Promise<number | undefined> {
  if (typeof page?.id === 'number' && Number.isFinite(page.id) && page.id > 0) return page.id;

  const identity = entityIdentity(page);
  if (typeof identity === 'number' && Number.isFinite(identity) && identity > 0) return identity;
  if (!logseq.DB?.datascriptQuery) return undefined;

  const uuid =
    typeof page?.uuid === 'string'
      ? page.uuid
      : typeof identity === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identity)
        ? identity
        : null;
  if (uuid) {
    try {
      const rows = await logseq.DB.datascriptQuery(
        '[:find ?e :in $ ?uuid :where [?e :block/uuid ?uuid]]',
        `#uuid "${uuid}"`,
      );
      const found = Array.isArray(rows) ? rows[0]?.[0] : null;
      if (typeof found === 'number' && found > 0) return found;
    } catch {
      /* fall through to title lookup */
    }
  }

  const title = String(page?.originalName ?? page?.title ?? page?.name ?? pageName ?? '').trim();
  if (!title) return undefined;
  const titleCandidates = [...new Set([title, safePageName(title)])].filter(Boolean);
  for (const candidate of titleCandidates) {
    try {
      const rows = await logseq.DB.datascriptQuery(
        '[:find ?e :in $ ?title :where [?e :block/title ?title]]',
        candidate,
      );
      const found = Array.isArray(rows) ? rows[0]?.[0] : null;
      if (typeof found === 'number' && found > 0) return found;
    } catch {
      /* try next candidate */
    }
  }
  return undefined;
}

/**
 * Full dashboard query block content.
 * DB graphs: s-expression only; repair adds #Query block tag via addBlockTag.
 * File graphs: inline `#Query` prefix in content.
 */
export async function dashboardQueryBlockForViewAsync(
  view: ViewDefinition,
  _pageName?: string,
  _page?: { originalName?: string; name?: string; id?: number } | null,
): Promise<string> {
  if (await isDbGraph()) {
    const currentId = await resolvePageDbId(_pageName, _page);
    const advanced = await advancedDashboardQueryEdnForViewAsync(view, currentId);
    return advanced ? advancedQueryBlockContent(advanced) : '';
  }
  const body = await simpleQueryForViewAsync(view, '<% current page %>');
  if (!body) return '';
  return queryBlockContent(body);
}

/** Dashboard queries on a venture/project page must keep <% current page %> for Logseq's engine. */
export function concreteSimpleQueryForView(
  view: ViewDefinition,
  _pageName?: string,
  _page?: { originalName?: string; name?: string } | null,
): string {
  return simpleQueryForView(view, '<% current page %>');
}

export async function concreteSimpleQueryForViewAsync(
  view: ViewDefinition,
  _pageName?: string,
  _page?: { originalName?: string; name?: string } | null,
): Promise<string> {
  return simpleQueryForViewAsync(view, '<% current page %>');
}

type DatascriptProbeAttempt = {
  label: string;
  query: string;
  inputs: unknown[];
};

async function runDatascriptProbe(attempt: DatascriptProbeAttempt): Promise<unknown[]> {
  if (!logseq.DB?.datascriptQuery) return [];
  try {
    const results = await logseq.DB.datascriptQuery(attempt.query, ...attempt.inputs);
    return Array.isArray(results) ? results : [];
  } catch {
    return [];
  }
}

function ventureDatascriptAttempts(
  venturePageId: number,
  venturePageName: string,
  objectTypeValue: string,
  ventureAttrs: string[],
  typeAttrs: string[],
): DatascriptProbeAttempt[] {
  const pageName = venturePageName.trim().toLowerCase();
  const typeValues = [...new Set([objectTypeValue, objectTypeValue.toLowerCase()])];
  const attempts: DatascriptProbeAttempt[] = [];

  const add = (label: string, where: string, inputs: unknown[] = []) => {
    const inVars = inputs.map((_, i) => `?in${i}`).join(' ');
    const inClause = inVars ? ` $ ${inVars}` : ' $';
    attempts.push({
      label,
      query: `[:find (pull ?b [:block/uuid :block/title :block/name :block/original-name])
 :in${inClause}
 :where
 ${where}]`,
      inputs,
    });
  };

  for (const ventureAttr of ventureAttrs) {
    add(
      `tag-${objectTypeValue}+entity-id:${ventureAttr}`,
      `[?b :block/tags ?tag]
 [?tag :block/title ${JSON.stringify(objectTypeValue)}]
 [?b ${ventureAttr} ?in0]`,
      [venturePageId],
    );
    if (pageName) {
      add(
        `tag-${objectTypeValue}+page-name:${ventureAttr}`,
        `[?b :block/tags ?tag]
 [?tag :block/title ${JSON.stringify(objectTypeValue)}]
 [?b ${ventureAttr} ?val]
 [?val :block/name ?in0]`,
        [pageName],
      );
    }
    for (const typeAttr of typeAttrs) {
      for (const typeVal of typeValues) {
        add(
          `entity-id+type:${ventureAttr}/${typeAttr}/${typeVal}`,
          `[?b ${ventureAttr} ?in0]
 [?b ${typeAttr} ${JSON.stringify(typeVal)}]`,
          [venturePageId],
        );
        if (pageName) {
          add(
            `page-name+type:${ventureAttr}/${typeAttr}/${typeVal}`,
            `[?ftv :block/name ?in0]
 [?b ${ventureAttr} ?ftv]
 [?b ${typeAttr} ${JSON.stringify(typeVal)}]`,
            [pageName],
          );
          add(
            `ref-name+type:${ventureAttr}/${typeAttr}/${typeVal}`,
            `[?b ${ventureAttr} ?val]
 [?val :block/name ?in0]
 [?b ${typeAttr} ${JSON.stringify(typeVal)}]`,
            [pageName],
          );
          add(
            `ref-title+type:${ventureAttr}/${typeAttr}/${typeVal}`,
            `[?b ${ventureAttr} ?val]
 [?val :block/title ?in0]
 [?b ${typeAttr} ${JSON.stringify(typeVal)}]`,
            [pageName],
          );
        }
      }
    }
    add(`entity-id-only:${ventureAttr}`, `[?b ${ventureAttr} ?in0]`, [venturePageId]);
    if (pageName) {
      add(
        `page-name-only:${ventureAttr}`,
        `[?ftv :block/name ?in0]
 [?b ${ventureAttr} ?ftv]`,
        [pageName],
      );
      add(
        `ref-name-only:${ventureAttr}`,
        `[?b ${ventureAttr} ?val]
 [?val :block/name ?in0]`,
        [pageName],
      );
    }
  }

  for (const typeVal of typeValues) {
    for (const typeAttr of typeAttrs) {
      add(
        `type-only:${typeAttr}/${typeVal}`,
        `[?b ${typeAttr} ${JSON.stringify(typeVal)}]`,
        [],
      );
    }
    add(
      `tag-function+type:${typeVal}`,
      `[?b :block/tags ?tag]
 [?tag :block/title "Function"]
 [?b ${typeAttrs[0]} ${JSON.stringify(typeVal)}]`,
      [],
    );
  }

  add(
    'tag-function-only',
    `[?b :block/tags ?tag]
 [?tag :block/title "Function"]`,
    [],
  );

  return attempts;
}

export async function datascriptVentureChildProbe(
  venturePageId: number,
  objectTypeValue: string,
  venturePageName = '',
): Promise<unknown[]> {
  const report = await datascriptVentureProbeReport(venturePageId, objectTypeValue, venturePageName);
  return report.hits;
}

export async function datascriptVentureProbeReport(
  venturePageId: number,
  objectTypeValue: string,
  venturePageName = '',
): Promise<{ hits: unknown[]; matchedLabel: string | null; attempts: Array<{ label: string; count: number }> }> {
  if (!logseq.DB?.datascriptQuery) {
    return { hits: [], matchedLabel: null, attempts: [] };
  }
  const ventureAttrs = [
    ...new Set([
      await resolvePropertyQueryName('venture'),
      pluginPropertyIdent('venture'),
    ]),
  ];
  const typeAttrs = [
    ...new Set([
      await resolvePropertyQueryName('lss-object-type'),
      pluginPropertyIdent('lss-object-type'),
    ]),
  ];
  const attempts = ventureDatascriptAttempts(
    venturePageId,
    venturePageName,
    objectTypeValue,
    ventureAttrs,
    typeAttrs,
  );
  const counts: Array<{ label: string; count: number }> = [];

  for (const attempt of attempts) {
    const hits = await runDatascriptProbe(attempt);
    counts.push({ label: attempt.label, count: hits.length });
    if (hits.length) {
      return { hits, matchedLabel: attempt.label, attempts: counts };
    }
  }

  return { hits: [], matchedLabel: null, attempts: counts };
}

export async function datascriptInspectBlock(uuid: string): Promise<Record<string, unknown> | null> {
  if (!logseq.DB?.datascriptQuery || !uuid) return null;
  const query = `[:find (pull ?b [*])
 :in $ ?buuid
 :where
 [?b :block/uuid ?buuid]]`;
  try {
    const results = await logseq.DB.datascriptQuery(query, `#uuid "${uuid}"`);
    const row = Array.isArray(results) ? results[0] : null;
    if (!row) return null;
    return (Array.isArray(row) ? row[0] : row) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function datascriptInspectEntityId(
  entityId: number | string,
): Promise<Record<string, unknown> | null> {
  if (!logseq.DB?.datascriptQuery) return null;
  const id = Number(entityId);
  if (!Number.isFinite(id) || id <= 0) return null;
  const query = `[:find (pull ?b [*])
 :in $ ?eid
 :where
 [?b :db/id ?eid]]`;
  try {
    const results = await logseq.DB.datascriptQuery(query, id);
    const row = Array.isArray(results) ? results[0] : null;
    if (!row) return null;
    return (Array.isArray(row) ? row[0] : row) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function venturePagePropertyClause(pageRef = '<% current page %>'): string {
  const value = pageRef === '<% current page %>' ? '<% current page %>' : queryValue(pageRef);
  return `(property venture ${value})`;
}

export function venturePropertyClauseFromQuery(queryBody: string): string | null {
  const text = String(queryBody ?? '');
  const legacyPageProp = text.match(/\(page-property\s+venture\s+<% current page %>\)/i);
  if (legacyPageProp) return venturePagePropertyClause();
  const blockProp = text.match(/\(property\s+([^\s)]+)\s+<% current page %>\)/i);
  if (blockProp && /venture/i.test(blockProp[1])) {
    return venturePagePropertyClause();
  }
  return null;
}

export function sectionNameFromLine(line: string): string | null {
  let text = String(line ?? '').trim();
  if (!text || text.includes('::')) return null;
  if (text.startsWith('(') || text.startsWith('{{') || text.startsWith('<!--') || text.startsWith('```')) {
    return null;
  }
  text = text.replace(/^[-*]\s+/, '').replace(/#Template\b/g, '').trim();
  if (!text || text === '-') return null;
  return text;
}

function canonicalizePropertyTokenInQuery(token: string): string {
  const raw = String(token ?? '').trim().toLowerCase();
  if (!raw) return raw;
  const pluginTail = raw.match(/:plugin\.property\.[^/]+\/(.+)$/);
  if (pluginTail?.[1]) return pluginTail[1];
  const userTail = raw.match(/:user\.property\/([^/\s]+)$/);
  if (userTail?.[1]) return userTail[1].replace(/-[a-z0-9_]+$/i, '');
  return raw.replace(/^:/, '');
}

function canonicalizeClassFilterInQuery(text: string): string {
  let out = text.replace(
    /\(page-tags\s+#?([^)\s]+)\)/gi,
    (_, tag: string) => `(tags ${safeTag(tag).toLowerCase()})`,
  );
  out = out.replace(/\(tags\s+#?([^)\s]+)\)/gi, (_, tag: string) => `(tags ${safeTag(tag).toLowerCase()})`);
  out = out.replace(
    /\(property\s+([^\s)]+)\s+lss-object-type\s+"([^"]+)"\)/gi,
    (_, _prop: string, type: string) => `(tags ${safeTag(type).toLowerCase()})`,
  );
  return out;
}

function canonicalizeVentureFilterInQuery(text: string): string {
  return text
    .replace(
      /\(page-property\s+venture\s+(?:<% current page %>|\d+|\[\[[^\]]+\]\])\)/gi,
      '(property venture <% current page %>)',
    )
    .replace(
      /\(property\s+[^\s)]*venture[^\s)]*\s+(?:<% current page %>|\d+|\[\[[^\]]+\]\])\)/gi,
      '(property venture <% current page %>)',
    );
}

function normalizeAdvancedQueryBlockContent(content: string): string {
  const text = String(content ?? '')
    .replace(/^#\+BEGIN_QUERY\s*/i, '')
    .replace(/#\+END_QUERY\s*$/i, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
  const tags = [...text.matchAll(/\[?\?tag\s+:block\/title\s+"([^"]+)"\]/gi)].map((m) =>
    safeTag(m[1]).toLowerCase(),
  );
  const ventureAttrs = [
    ...text.matchAll(/\[?\?b\s+(:[^\s\]]+)\s+\?current\]/gi),
  ].map((m) => canonicalizePropertyTokenInQuery(m[1]));
  const parts: string[] = [];
  for (const tag of [...new Set(tags)]) {
    if (tag) parts.push(`(tags ${tag})`);
  }
  if (ventureAttrs.some((attr) => attr.includes('venture'))) {
    parts.push('(property venture <% current page %>)');
  }
  return parts.length ? `(and ${parts.join(' ')})` : text;
}

export function normalizeQueryBlockContent(content: string, _venturePageId?: string | number | null): string {
  if (isAdvancedQueryBlockContent(content)) {
    return normalizeAdvancedQueryBlockContent(content);
  }
  let text = String(content ?? '')
    .trim()
    .replace(/^#Query\s+/, '');
  text = text.replace(/\s+\)/g, ')');
  text = text.replace(/\(property\s+([^\s]+)\s+([^)]+)\)/gi, (segment, prop: string, value: string) => {
    const propKey = canonicalizePropertyTokenInQuery(prop);
    const rawValue = String(value ?? '').trim().toLowerCase();
    if (propKey === 'venture' && (rawValue === '<% current page %>' || /^\d+$/.test(rawValue) || rawValue.startsWith('[['))) {
      return `(property venture <% current page %>)`;
    }
    if (propKey === 'lss-object-type') {
      const type = String(value ?? '').trim().replace(/^"|"$/g, '').toLowerCase();
      return `(tags ${safeTag(type).toLowerCase()})`;
    }
    return `(property ${propKey} ${String(value).trim().toLowerCase()})`;
  });
  text = canonicalizeClassFilterInQuery(text);
  text = canonicalizeVentureFilterInQuery(text);
  text = text.replace(/\[\[([^\]]+)\]\]/g, (_, name: string) => `[[${normalizePageRefName(name)}]]`);
  return text.replace(/\s+/g, ' ').toLowerCase();
}

export function queryBlockContent(query: string): string {
  const body = String(query ?? '').trim();
  return body ? `#Query ${body}` : '';
}

export function queriesEquivalent(
  stored: string,
  expected: string,
  venturePageId?: string | number | null,
): boolean {
  return (
    normalizeQueryBlockContent(stored, venturePageId) === normalizeQueryBlockContent(expected, venturePageId)
  );
}

export function queryBodyFromContent(content: string): string {
  return String(content ?? '')
    .trim()
    .replace(/^#Query\s+/, '')
    .trim();
}

function queryUsesBarePropertyNames(content: string): boolean {
  const text = String(content ?? '');
  if (/\(property\s+:(?:plugin|user)\.property/i.test(text)) return false;
  return (
    /\(property\s+(?!:)(?:venture|lss-object-type)\b/i.test(text) ||
    /\(tags\s+/i.test(text)
  );
}

function queryUsesDbQueryFilters(content: string): boolean {
  const text = String(content ?? '');
  return /\(tags\s+/i.test(text) && /\(property\s+[^\s)]*venture\b/i.test(text);
}

function queryUsesLegacyDbPageQueryFilters(content: string): boolean {
  const text = String(content ?? '');
  return /\(page-tags\s+/i.test(text) || /\(page-property\s+venture\b/i.test(text);
}

function queryUsesPropertyIdents(content: string): boolean {
  return /\(property\s+:(?:plugin|user)\.property[\w.-]*\//i.test(String(content ?? ''));
}

/** True when repair should rewrite the block (semantic drift or non-canonical page-ref casing). */
export function queryBlockNeedsRepair(stored: string, expected: string): boolean {
  if (isLegacyBeginQueryWrapper(stored)) return true;
  const storedAdvanced = isAdvancedQueryBlockContent(stored);
  const expectedAdvanced = isAdvancedQueryBlockContent(expected);
  if (storedAdvanced !== expectedAdvanced) return true;
  if (expectedAdvanced) {
    const storedNorm = normalizeAdvancedQueryBlockContent(stored).replace(/\s+/g, ' ').trim();
    const expectedNorm = normalizeAdvancedQueryBlockContent(expected).replace(/\s+/g, ' ').trim();
    return storedNorm !== expectedNorm;
  }
  const expectedBody = queryBodyFromContent(expected);
  if (!queriesEquivalent(stored, expectedBody)) return true;
  const storedBody = queryBodyFromContent(stored);
  if (storedBody !== expectedBody) return true;
  if (queryUsesPropertyIdents(expectedBody) && queryUsesBarePropertyNames(storedBody)) return true;
  if (queryUsesDbQueryFilters(expectedBody) && !queryUsesDbQueryFilters(storedBody)) return true;
  if (queryUsesLegacyDbPageQueryFilters(storedBody)) return true;
  return false;
}

export function isSimpleQueryBlockContent(content: string): boolean {
  if (isAdvancedQueryBlockContent(content)) return false;
  const text = normalizeQueryBlockContent(content);
  return /^(\(and\s|\(or\s|\(tags\s|\(page-tags\s|\(property\s|\(page-property\s)/.test(text);
}

function blockSnapshotHasQueryClassTag(block: any): boolean {
  const tags = block?.tags ?? (block?.properties as Record<string, unknown> | undefined)?.tags;
  const names = new Set<string>();
  const collect = (tag: unknown) => {
    if (typeof tag === 'string') names.add(safeTag(tag).toLowerCase());
    else if (tag && typeof tag === 'object') {
      const record = tag as Record<string, unknown>;
      const name = record.name ?? record.originalName ?? record.title ?? record.ident;
      if (name) names.add(String(name).toLowerCase());
    }
  };
  if (Array.isArray(tags)) tags.forEach(collect);
  else if (tags) collect(tags);
  return names.has('query') || names.has('logseq.class/query');
}

/** Sync heuristic: content, #Query shell, query property ref, or Query class tag on block snapshot. */
export function isQueryLikeBlockSnapshot(block: any): boolean {
  if (isQueryLikeContent(String(block?.content ?? ''))) return true;
  const props = (block?.properties ?? {}) as Record<string, unknown>;
  if (propertyBlockRefId(readCanonicalProperty(props, 'query') ?? props[`:${QUERY_PROPERTY_KEY}`]) != null) {
    return true;
  }
  return blockSnapshotHasQueryClassTag(block);
}

export async function isQueryLikeBlockAsync(block: any): Promise<boolean> {
  if (isQueryLikeBlockSnapshot(block)) return true;
  const id = blockId(block);
  return id != null ? blockHasQueryClassTag(id) : false;
}

/** Dashboard queries are direct children of the section heading — not nested code-child blocks. */
export function findAllQueryBlocksInSection(sectionBlock: any): any[] {
  return (sectionBlock?.children ?? []).filter((block: any) => isQueryLikeBlockSnapshot(block));
}

export async function findAllQueryBlocksInSectionAsync(sectionBlock: any): Promise<any[]> {
  const results: any[] = [];
  for (const block of sectionBlock?.children ?? []) {
    if (await isQueryLikeBlockAsync(block)) results.push(block);
  }
  return results;
}

export function readQueryBlockContentFromSnapshot(queryBlock: any): string {
  const parent = String(queryBlock?.content ?? '').trim();
  if (isQueryLikeContent(parent) && isAdvancedQueryBlockContent(parent)) return parent;
  if (isSimpleQueryBlockContent(parent)) return parent;
  const props = (queryBlock?.properties ?? {}) as Record<string, unknown>;
  const childId = propertyBlockRefId(
    readCanonicalProperty(props, 'query') ?? props[`:${QUERY_PROPERTY_KEY}`],
  );
  if (childId != null) {
    for (const child of queryBlock?.children ?? []) {
      const cid = blockId(child);
      if (cid != null && String(cid) === String(childId)) {
        const childContent = String(child?.content ?? child?.title ?? '').trim();
        if (childContent) return childContent;
      }
    }
  }
  // fallback scan: any child with edn content (snapshot props may not expose internal query prop)
  for (const child of queryBlock?.children ?? []) {
    const cc = String(child?.content ?? child?.title ?? '').trim();
    if (isAdvancedQueryBlockContent(cc)) return cc;
  }
  return parent;
}

export async function readDashboardQueryBlockContent(queryBlock: any): Promise<string> {
  const fromSnapshot = readQueryBlockContentFromSnapshot(queryBlock);
  if (isAdvancedQueryBlockContent(fromSnapshot) || isSimpleQueryBlockContent(fromSnapshot)) {
    return fromSnapshot;
  }
  const parentId = blockId(queryBlock);
  if (!parentId || !logseq.Editor.getBlockProperties) return fromSnapshot;
  const props = ((await logseq.Editor.getBlockProperties(parentId).catch(() => null)) ?? {}) as Record<
    string,
    unknown
  >;
  const childId = propertyBlockRefId(
    readCanonicalProperty(props, 'query') ?? props[`:${QUERY_PROPERTY_KEY}`],
  );
  if (childId == null || !logseq.Editor.getBlock) return fromSnapshot;
  const child = await logseq.Editor.getBlock(childId).catch(() => null);
  let result = child ? String((child as Record<string, unknown>).content ?? (child as Record<string, unknown>).title ?? '').trim() : fromSnapshot;
  if (!result && queryBlock) {
    // fallback: scan the queryBlock's children for any that look like the edn child
    const kids = queryBlock.children ?? [];
    for (const ch of kids) {
      const cc = String(ch?.content ?? ch?.title ?? '').trim();
      if (isAdvancedQueryBlockContent(cc)) {
        result = cc;
        break;
      }
    }
  }
  return result;
}

export async function scoreQueryBlockCandidate(block: any, expectedContent: string): Promise<number> {
  const content = await readDashboardQueryBlockContent(block);
  const struct = await inspectDbQueryBlockStructure(block);
  let score = 0;
  if (struct.hasQueryClassTag) score += 10;
  if (struct.hasQueryProperty) score += 20;
  if (struct.hasCodeChild) score += 30;
  if (!struct.rawEdnInParentContent) score += 5;
  if (struct.queryEdnInChild) score += 15;
  if (!queryBlockNeedsRepair(content, expectedContent)) score += 50;
  if (struct.rawEdnInParentContent) score -= 5;
  return score;
}

export async function pickCanonicalQueryBlock(
  blocks: any[],
  expectedContent: string,
): Promise<any | null> {
  if (!blocks.length) return null;
  const scored = await Promise.all(
    blocks.map(async (block) => ({
      block,
      score: await scoreQueryBlockCandidate(block, expectedContent),
    })),
  );
  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.block ?? null;
}

export function findQueryBlockInSection(sectionBlock: any): any | null {
  return findAllQueryBlocksInSection(sectionBlock)[0] ?? null;
}

export function findSectionQueryContent(blocks: any[], section: string): string | null {
  for (const block of walkBlocks(blocks)) {
    if (sectionNameFromLine(block?.content) !== section) continue;
    const queryBlock = findQueryBlockInSection(block);
    if (queryBlock) return readQueryBlockContentFromSnapshot(queryBlock);
  }
  return null;
}

export function isQueryLikeContent(content: string): boolean {
  const text = String(content ?? '').trim();
  return (
    isAdvancedQueryBlockContent(text) ||
    isSimpleQueryBlockContent(text) ||
    text.includes('<% current page %>') ||
    text.includes('{{query') ||
    text.includes('Manual post-filter:') ||
    /^#Query\b/i.test(text)
  );
}

export function queryLineForView(view: ViewDefinition, indent: string, inlineQueryTag = true): string[] {
  const query = simpleQueryForView(view);
  if (!query) return [];
  // Put #Query before the s-expression so a trailing ")" cannot create a phantom #Tag) tag.
  const line = inlineQueryTag ? `${indent}  - #Query ${query}` : `${indent}  - ${query}`;
  return [line];
}

export function templateSectionAliases(template: RegistryTemplate, section: string): string {
  const objectType = templateNameFromRegistry(template);
  const raw = String(section ?? '');
  if (objectType === 'Project' && raw === 'Action-Items') return 'Next actions';
  if (objectType === 'Person' && raw === 'Owned Work') return 'Ventures / projects';
  if (objectType === 'Person' && raw === 'Commitments') return 'Follow-ups';
  return raw;
}

export function templateBodySectionSet(template: RegistryTemplate): Set<string> {
  const set = new Set<string>();
  for (const line of String(template.body ?? '').split(/\r?\n/)) {
    const section = sectionNameFromLine(line);
    if (section) set.add(section);
  }
  return set;
}

export function viewKey(view: ViewDefinition): string {
  const tags = (view.sourceTags ?? []).join('|');
  const filters = (view.filters ?? [])
    .map(
      (f) =>
        `${f.property ?? (f.propertyAny ?? []).join('|')}:${f.operator ?? ''}:${
          Array.isArray(f.value) ? f.value.join('|') : f.value ?? ''
        }`,
    )
    .join(';');
  return `${view.section}::${tags}::${filters}`;
}

export function makeView(
  objectType: string,
  section: string,
  sourceTags: string | string[],
  filterProp: string | string[],
): ViewDefinition {
  const tags = Array.isArray(sourceTags) ? sourceTags : [sourceTags];
  const filters = Array.isArray(filterProp)
    ? [{ propertyAny: filterProp, operator: 'includesCurrentPage' }]
    : [{ property: filterProp, operator: 'includesCurrentPage' }];
  return {
    id: `LSS-TEMPLATE-${objectType}-${String(section).replace(/[^a-zA-Z0-9]+/g, '-').toUpperCase()}`,
    title: `${objectType} / ${section}`,
    dashboard: dashboardPageForObjectType(objectType) ?? undefined,
    section,
    sourceTags: tags,
    filters,
    viewType: 'table',
    nativeQueryStatus: 'template-query-block',
    exportPolicy: 'inherit',
  };
}

export function supplementalTemplateViews(template: RegistryTemplate): ViewDefinition[] {
  const objectType = templateNameFromRegistry(template);
  const views: ViewDefinition[] = [];
  if (objectType === 'Venture') {
    views.push(
      makeView(objectType, 'Organisations', 'Organisation', ['venture', 'related-venture']),
      makeView(objectType, 'People', 'Person', ['venture', 'related-venture']),
    );
  }
  if (objectType === 'Function') {
    views.push(
      makeView(objectType, 'People', 'Person', ['function', 'related-function']),
      makeView(objectType, 'Documents', ['Document', 'File'], ['function', 'related-function']),
    );
  }
  if (objectType === 'Person') {
    views.push(
      makeView(objectType, 'Organisations', 'Organisation', ['relationship-owner', 'related-person']),
      makeView(objectType, 'Notes', 'Note', ['related-person', 'attendees', 'owner']),
    );
  }
  return views;
}

export function autoRelationshipTemplateViews(template: RegistryTemplate): ViewDefinition[] {
  const objectType = templateNameFromRegistry(template);
  const sections = templateBodySectionSet(template);
  const views: ViewDefinition[] = [];

  for (const rel of registry.relationshipRegistry ?? []) {
    const targets = rel.targets ?? [];
    if (!targets.map(safeTag).includes(safeTag(objectType))) continue;
    const related = [
      ...(Array.isArray(rel.requiredBy) ? rel.requiredBy : []),
      ...(Array.isArray(rel.optionalBy)
        ? rel.optionalBy
        : String(rel.optionalBy ?? '')
            .split(/[.,\s]+/)
            .filter(Boolean)),
    ];
    for (const relatedName of related) {
      const obj = objectByName(relatedName);
      if (!obj) continue;
      const section = String(obj.dashboardSection ?? obj.name ?? relatedName).trim();
      if (!section || (sections.size && !sections.has(section))) continue;
      views.push(makeView(objectType, section, obj.name ?? relatedName, rel.property));
    }
  }
  return views;
}

export function viewDefinitionsSafe(template: RegistryTemplate): ViewDefinition[] {
  const objectType = templateNameFromRegistry(template);
  const dashboard = dashboardPageForObjectType(objectType);
  const bodySections = templateBodySectionSet(template);
  const views: ViewDefinition[] = [];

  const allowed = (section: string) => {
    const name = String(section ?? '').trim();
    return name && (!bodySections.size || bodySections.has(name));
  };

  if (dashboard) {
    for (const view of registry.viewDefinitions ?? []) {
      if (view.dashboard !== dashboard) continue;
      const mapped = { ...view, section: templateSectionAliases(template, view.section ?? '') };
      if (allowed(mapped.section ?? '')) views.push(mapped);
    }
  }

  views.push(...autoRelationshipTemplateViews(template));
  for (const extra of supplementalTemplateViews(template)) {
    const section = String(extra.section ?? '').trim();
    if (allowed(section)) views.push({ ...extra, section });
  }

  const deduped: ViewDefinition[] = [];
  const seenSections = new Set<string>();
  const seenKeys = new Set<string>();
  for (const view of views) {
    const section = String(view.section ?? '').trim();
    if (!section) continue;
    const normalized = { ...view, section };
    const key = viewKey(normalized);
    if (seenSections.has(section) || seenKeys.has(key)) continue;
    seenSections.add(section);
    seenKeys.add(key);
    deduped.push(normalized);
  }
  return deduped;
}

export function viewsForDashboardKind(kind: string): ViewDefinition[] {
  const template = templateDefByObjectType(kind);
  if (template) return viewDefinitionsSafe(template);
  const dashboardPage = `Dashboard/${kind}`;
  return (registry.viewDefinitions ?? []).filter((v) => v.dashboard === dashboardPage);
}

export function filterIntentText(filter: NonNullable<ViewDefinition['filters']>[number]): string {
  const prop =
    filter.property ?? (Array.isArray(filter.propertyAny) ? filter.propertyAny.join(' or ') : '-');
  const op = filter.operator ?? '-';
  const value = Array.isArray(filter.value) ? filter.value.join(', ') : filter.value ?? '';
  if (op === 'includesCurrentPage') return `${prop} includes current page`;
  if (op === 'notIn') return `${prop} not in ${value}`;
  if (op === 'in') return `${prop} in ${value}`;
  if (op === 'onOrBeforeToday') return `${prop} on or before today`;
  if (op === 'withinDays') return `${prop} within ${value} days`;
  return `${prop} ${op}${value ? ` ${value}` : ''}`.trim();
}

export function objectTypesUsingProperty(property: string): string[] {
  const names: string[] = [];
  for (const obj of allObjects()) {
    if ((obj.properties ?? []).includes(property)) names.push(obj.name);
  }
  return names;
}

export function relationshipPropertyNames(): string[] {
  const set = new Set<string>();
  for (const rel of registry.relationshipRegistry ?? []) {
    if (rel.property) set.add(String(rel.property));
  }
  return [...set];
}

export function tagsRequiringConfidentiality(): Set<string> {
  const set = new Set<string>();
  for (const obj of allObjects()) {
    if ((obj.properties ?? []).includes('confidentiality')) {
      set.add(safeTag(obj.tag));
      set.add(obj.name);
    }
  }
  return set;
}

export function sensitiveAreaTags(): string[] {
  return ['HealthObject', 'WealthObject'];
}
