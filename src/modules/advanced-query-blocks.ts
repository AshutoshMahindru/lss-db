import { canonicalPropertyKey, entityIdentity, isDbGraph } from '../core/db-properties';
import { blockId, updateBlockContent } from '../core/editor';
import { safeTag } from '../core/names';
import { formatError, sleep } from '../core/runner';
import type { Result } from '../core/types';

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

function extractBalancedList(text: string, startIdx: number): string | null {
  if (text[startIdx] !== '(') return null;
  let depth = 0;
  for (let i = startIdx; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
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

/** Pull a Logseq DSL s-expression from `{:query (and …)}` advanced query maps. */
export function extractAdvancedQueryDsl(content: string): string | null {
  const text = queryBodyFromBlockContent(content);
  const marker = text.search(/:query\s+\(/i);
  if (marker < 0) return null;
  const listStart = text.indexOf('(', marker);
  if (listStart < 0) return null;
  return extractBalancedList(text, listStart);
}

const QUERY_CLASS_TAG_NAMES = ['logseq.class/Query', 'Query'] as const;
export const QUERY_PROPERTY_KEY = 'logseq.property/query';
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

export function propertyBlockRefId(value: unknown): string | number | null {
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

export function readCanonicalProperty(props: Record<string, unknown>, shortName: string): unknown {
  const target = canonicalPropertyKey(shortName);
  for (const [key, value] of Object.entries(props)) {
    if (canonicalPropertyKey(key) === target) return value;
  }
  return undefined;
}

function readAnyProperty(props: Record<string, unknown>, ...names: string[]): unknown {
  for (const name of names) {
    const direct = props[name] ?? props[`:${name}`];
    if (direct !== undefined) return direct;
    const canonical = readCanonicalProperty(props, name);
    if (canonical !== undefined) return canonical;
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
  const fromRef = propertyBlockRefId(readAnyProperty(props, 'query', QUERY_PROPERTY_KEY));
  if (fromRef != null) return fromRef;
  const dsRef = await readBlockDatascriptProperty(parentId, QUERY_PROPERTY_KEY);
  const fromDatascript = propertyBlockRefId(dsRef);
  if (fromDatascript != null) return fromDatascript;
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
  function rawQueryParentContent(parent) {
    var text = String((parent && (parent[':block/content'] ?? parent.content ?? parent.title)) ?? '').trim();
    return /^\\s*\\{[\\s\\S]*:query\\s+(?:\\[:find|\\()/i.test(text) || /#\\+BEGIN_QUERY/i.test(text);
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
      if (rawQueryParentContent(parent)) await updateBlockTitle(parentRef, '');
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
          if (!c || !/^\\s*\\{[\\s\\S]*:query\\s+(?:\\[:find|\\()/i.test(cc)) {
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

  const queryRef =
    readAnyProperty(props, 'query', QUERY_PROPERTY_KEY) ??
    (id != null ? await readBlockDatascriptProperty(id, QUERY_PROPERTY_KEY) : undefined);
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
        const displayType = readAnyProperty(
          childProps,
          'node/display-type',
          'display-type',
          QUERY_DISPLAY_TYPE_KEY,
        );
        const codeLang = readAnyProperty(childProps, 'code/lang', QUERY_CODE_LANG_KEY);
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
            const displayType = readAnyProperty(cprops, 'node/display-type', 'display-type', QUERY_DISPLAY_TYPE_KEY);
            const codeLang = readAnyProperty(cprops, 'code/lang', QUERY_CODE_LANG_KEY);
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

export async function upsertBlockPropertyViaHost(
  blockIdentity: string | number,
  key: string,
  value: unknown,
  options?: { reset?: boolean },
): Promise<{ ok: boolean; error?: string }> {
  const host = getLogseqHostWindow();
  const upsert = host?.logseq?.api?.upsert_block_property;
  if (!host || !upsert) return { ok: false, error: 'host logseq.api.upsert_block_property unavailable' };

  let identities = await collectBlockIdentityCandidates(blockIdentity);
  identities = identities.filter((id) => {
    const s = String(id);
    if (s.includes('{') || s.includes(':query') || s.length > 120) return false;
    return isPlausibleBlockIdentity(id) || typeof id === 'number';
  });
  if (!identities.length) return { ok: false, error: 'no valid block id candidate' };

  const errors: string[] = [];
  for (const identity of identities) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await Promise.resolve(upsert(identity, key, value, options));
        await sleep(70 + attempt * 40);
        return { ok: true };
      } catch (error) {
        const message = formatError(error);
        if (/journal date|invalid value|should be a/i.test(message)) {
          return { ok: false, error: message };
        }
        if (attempt === 2) errors.push(`host(${identity}): ${message}`);
        await sleep(120 * (attempt + 1));
      }
    }
  }

  return { ok: false, error: errors.join('; ') || 'host upsert did not persist' };
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
      if (isAdvancedQueryBlockContent(String(block?.content ?? ''))) {
        await updateBlockContent(result, block, '', 'Clear raw EDN from query parent shell');
      }
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
  if (isAdvancedQueryBlockContent(String(block?.content ?? ''))) {
    await updateBlockContent(result, block, '', 'Clear parent');
  }
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
  if (isAdvancedQueryBlockContent(String(block?.content ?? ''))) {
    await updateBlockContent(result, block, '', 'Clear parent content');
  }
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
  return /^\{[\s\S]*:query\s+(?:\[:find|\()/i.test(text);
}

export function isLegacyBeginQueryWrapper(content: string): boolean {
  return /#\+BEGIN_QUERY/i.test(String(content ?? ''));
}


function queryBodyFromContent(content: string): string {
  return String(content ?? '')
    .trim()
    .replace(/^#Query\s+/, '')
    .trim();
}

export function queryBodyFromBlockContent(content: string): string {
  const text = String(content ?? '').trim();
  if (isAdvancedQueryBlockContent(text)) {
    return text.replace(/^#\+BEGIN_QUERY\s*/i, '').replace(/\s*#\+END_QUERY\s*$/i, '').trim();
  }
  return queryBodyFromContent(text);
}
