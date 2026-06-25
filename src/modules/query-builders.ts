import {
  entityIdentity,
  isDbGraph,
  propertyQueryName,
  resolvePropertyQueryName,
} from '../core/db-properties';
import { safePageName, safeTag } from '../core/names';
import { objectByName } from '../registry';
import type { ViewDefinition } from '../registry/types';

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

function ednString(value: string): string {
  return `"${String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function queryTitleForView(view: ViewDefinition): string {
  return String(normTagList(view.sourceTags)[0] ?? view.section ?? view.title ?? 'Query').trim() || 'Query';
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

function placeholderExclusionExpr(): string {
  return `(not (property ${queryPropertyName('lss-kind')} "Template Placeholder"))`;
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
  if (op === 'notIn' && Array.isArray(filter.value) && filter.value.length) {
    const parts: string[] = [];
    for (const prop of props) {
      for (const val of filter.value) {
        parts.push(`(not (property ${queryPropertyName(prop)} ${queryValue(val)}))`);
      }
    }
    return parts.length > 1 ? `(and ${parts.join(' ')})` : parts[0];
  }
  if (op === 'onOrBeforeToday') return `(property ${queryPropertyName(props[0])} <% today %>)`;
  return null;
}

async function queryDbPropertyRefExpr(shortKey: string, pageRef = '<% current page %>'): Promise<string> {
  const propName = await queryPropertyNameAsync(shortKey);
  const value = pageRef === '<% current page %>' ? '<% current page %>' : queryValue(pageRef);
  return `(property ${propName} ${value})`;
}

function currentPageTextFallbackValues(currentPageName?: string): string[] {
  const raw = String(currentPageName ?? '').trim();
  if (!raw) return [];
  const candidates = [
    raw,
    safePageName(raw),
    raw.toLowerCase(),
    safePageName(raw).toLowerCase(),
    raw.toUpperCase(),
    safePageName(raw).toUpperCase(),
  ];
  return [...new Set(candidates.map((value) => value.trim()).filter(Boolean))];
}

async function queryDbCurrentPagePropertyExpr(
  shortKey: string,
  pageRef = '<% current page %>',
  currentPageName?: string,
): Promise<string> {
  const propName = await queryPropertyNameAsync(shortKey);
  const parts = [`(property ${propName} ${pageRef === '<% current page %>' ? '<% current page %>' : queryValue(pageRef)})`];
  if (pageRef === '<% current page %>') {
    for (const value of currentPageTextFallbackValues(currentPageName)) {
      parts.push(`(property ${propName} ${queryValue(value)})`);
    }
  }
  return parts.length > 1 ? `(or ${parts.join(' ')})` : parts[0];
}

async function queryFilterExprAsync(
  filter: NonNullable<ViewDefinition['filters']>[number],
  pageRef = '<% current page %>',
  dbGraph = false,
  currentPageName?: string,
): Promise<string | null> {
  const props = filterProps(filter);
  const op = String(filter.operator ?? '');
  if (!props.length) return null;

  if (op === 'includesCurrentPage') {
    if (dbGraph) {
      const parts = await Promise.all(props.map((p) => queryDbCurrentPagePropertyExpr(p, pageRef, currentPageName)));
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
  if (op === 'notIn' && Array.isArray(filter.value) && filter.value.length) {
    const parts: string[] = [];
    for (const prop of props) {
      const propName = await queryPropertyNameAsync(prop);
      for (const val of filter.value) {
        parts.push(`(not (property ${propName} ${queryValue(val)}))`);
      }
    }
    return parts.length > 1 ? `(and ${parts.join(' ')})` : parts[0];
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
  if (tagExpr) parts.push(placeholderExclusionExpr());
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
  if (tagExpr) parts.push(placeholderExclusionExpr());
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
  currentPageName?: string,
): Promise<string> {
  const parts: string[] = [];
  const tagExpr = queryDbPageClassTagExpr(view);
  if (tagExpr) parts.push(tagExpr);
  if (tagExpr) parts.push(placeholderExclusionExpr());
  for (const filter of view.filters ?? []) {
    const expr = await queryFilterExprAsync(filter, pageRef, true, currentPageName);
    if (expr) parts.push(expr);
  }
  return parts.length ? `(and ${parts.join(' ')})` : '';
}

/** Advanced query EDN body for DB dashboards.
 *
 * DB graphs keep Logseq's /Advanced Query block structure, but use the Logseq
 * query DSL as the `:query` payload because DB v2 plugin properties resolve
 * correctly through that engine path while raw Datalog EDN can return 0 hits.
 */
export async function advancedDashboardQueryEdnForViewAsync(
  view: ViewDefinition,
  _currentPageId?: number,
  _currentPageName?: string,
): Promise<string> {
  const body = await dbDashboardQueryForViewAsync(view, '<% current page %>', _currentPageName);
  return body ? `{:title ${ednString(queryTitleForView(view))} :query ${body}}` : '';
}

/** Raw EDN for /Advanced Query (no #+BEGIN_QUERY wrapper — deprecated in DB v2). */
export function advancedQueryBlockContent(ednBody: string): string {
  return String(ednBody ?? '').trim();
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
        `[:find ?e :in $ ?title ?name
 :where
 (or [?e :block/title ?title]
     [?e :block/original-name ?title]
     [?e :block/name ?name])]`,
        candidate,
        safePageName(candidate).toLowerCase(),
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
  _page?: { originalName?: string; name?: string; title?: string; id?: number } | null,
): Promise<string> {
  if (await isDbGraph()) {
    const currentId = await resolvePageDbId(_pageName, _page);
    const currentName = String(_page?.originalName ?? _page?.title ?? _page?.name ?? _pageName ?? '').trim();
    const advanced = await advancedDashboardQueryEdnForViewAsync(view, currentId, currentName);
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

export function queryBlockContent(query: string): string {
  const body = String(query ?? '').trim();
  return body ? `#Query ${body}` : '';
}
