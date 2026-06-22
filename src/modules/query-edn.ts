import { normalizePageRefName, safeTag } from '../core/names';
import {
  extractAdvancedQueryDsl,
  extractAdvancedQueryVector,
  isAdvancedQueryBlockContent,
  isLegacyBeginQueryWrapper,
  queryBodyFromBlockContent,
} from './advanced-query-blocks';
import { queryValue } from './query-builders';

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
  const dsl = extractAdvancedQueryDsl(content);
  if (dsl) return normalizeQueryBlockContent(`#Query ${dsl}`);

  const text = String(content ?? '')
    .replace(/^#\+BEGIN_QUERY\s*/i, '')
    .replace(/#\+END_QUERY\s*$/i, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
  const tags = [...text.matchAll(/\[?\?tag[^\s\]]*\s+:(?:block\/title|block\/original-name|block\/name)\s+"([^"]+)"\]/gi)].map((m) =>
    safeTag(m[1]).toLowerCase(),
  );
  const ventureAttrs = [
    ...text.matchAll(/\[?\?b\s+(:[^\s\]]+)\s+(?:\?current|\d+)\]/gi),
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

function normalizeAdvancedQueryVectorForRepair(content: string): string {
  return String(extractAdvancedQueryVector(content) ?? queryBodyFromBlockContent(content))
    .replace(/\s+/g, ' ')
    .trim();
}

function extractAdvancedQueryInputs(content: string): string {
  const body = queryBodyFromBlockContent(content);
  const match = body.match(/:inputs\s+(\[[\s\S]*?\])/i);
  return String(match?.[1] ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeAdvancedQueryForRepair(content: string): string {
  const vector = normalizeAdvancedQueryVectorForRepair(content);
  const inputs = extractAdvancedQueryInputs(content);
  return `${vector} ::inputs ${inputs}`;
}

/** True when repair should rewrite the block (semantic drift or non-canonical page-ref casing). */
export function queryBlockNeedsRepair(stored: string, expected: string): boolean {
  if (isLegacyBeginQueryWrapper(stored)) return true;
  const storedAdvanced = isAdvancedQueryBlockContent(stored);
  const expectedAdvanced = isAdvancedQueryBlockContent(expected);
  if (storedAdvanced !== expectedAdvanced) return true;
  if (expectedAdvanced) {
    return normalizeAdvancedQueryForRepair(stored) !== normalizeAdvancedQueryForRepair(expected);
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
