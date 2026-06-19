/**
 * Pure-logic checks for repair/date/query helpers (no Logseq runtime required).
 * Mirrors the rules in src/core/db-properties.ts and src/modules/queries.ts.
 */

function looksLikePageEntityId(raw) {
  return /^\d+$/.test(raw) && Number(raw) < 1e9;
}

function parseDateFromRawString(raw) {
  const text = String(raw ?? '').trim();
  if (!text || /^\[\[\s*\]\]$/.test(text)) return null;
  const wiki = text.match(/\[\[(\d{4}-\d{2}-\d{2})\]\]/);
  if (wiki?.[1]) {
    const ms = Date.parse(`${wiki[1]}T12:00:00.000Z`);
    return Number.isNaN(ms) ? null : ms;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const ms = Date.parse(`${text}T12:00:00.000Z`);
    return Number.isNaN(ms) ? null : ms;
  }
  if (/^\d+$/.test(text)) {
    const num = Number(text);
    if (!Number.isNaN(num) && num >= 1e11) return num;
  }
  return null;
}

function parseDatePropertyValue(value) {
  if (value == null) return null;
  if (typeof value === 'number' && !Number.isNaN(value) && value >= 1e11) return value;
  if (typeof value === 'object') {
    const label = String(value.name ?? value.originalName ?? value.title ?? '').trim();
    if (label) {
      const fromLabel = parseDateFromRawString(label) ?? parseDateFromRawString(`[[${label}]]`);
      if (fromLabel != null) return fromLabel;
    }
  }
  return parseDateFromRawString(String(value));
}

function coerceNodePropertyReadValue(value) {
  if (value == null) return undefined;
  const toId = (item) => {
    if (typeof item === 'number' && looksLikePageEntityId(String(item))) return Number(item);
    if (typeof item === 'object' && item != null && item.id != null && looksLikePageEntityId(String(item.id))) {
      return Number(item.id);
    }
    const raw = String(item ?? '').trim();
    if (looksLikePageEntityId(raw)) return Number(raw);
    return null;
  };
  if (Array.isArray(value)) {
    const ids = value.map(toId).filter((id) => id != null);
    return ids.length ? ids : value;
  }
  const id = toId(value);
  return id != null ? id : value;
}

function isDbPageRefValue(value) {
  const isRef = (item) => {
    if (item == null) return false;
    if (typeof item === 'number') return looksLikePageEntityId(String(item));
    if (typeof item === 'object' && item.id != null) return looksLikePageEntityId(String(item.id));
    const raw = String(item).trim();
    if (!raw || raw.startsWith('[[')) return false;
    return looksLikePageEntityId(raw);
  };
  if (Array.isArray(value)) return value.some(isRef);
  return isRef(value);
}

function normalizePageRefName(name) {
  return String(name ?? '')
    .replace(/^\[\[/, '')
    .replace(/\]\]$/, '')
    .trim()
    .toLowerCase();
}

function safeTag(tag) {
  return String(tag ?? '')
    .replace(/^#/, '')
    .trim();
}

function isAdvancedQueryBlockContent(content) {
  const text = String(content ?? '').trim();
  if (/#\+BEGIN_QUERY/i.test(text)) return true;
  return /^\{[\s\S]*:query\s+(?:\[:find|\()/i.test(text);
}

function extractBalancedVector(text, startIdx) {
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

function extractBalancedList(text, startIdx) {
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

function extractAdvancedQueryVector(content) {
  const text = String(content ?? '')
    .trim()
    .replace(/^#\+BEGIN_QUERY\s*/i, '')
    .replace(/\s*#\+END_QUERY\s*$/i, '')
    .trim();
  const marker = text.search(/:query\s+\[/i);
  if (marker < 0) return null;
  const bracketStart = text.indexOf('[', marker);
  if (bracketStart < 0) return null;
  return extractBalancedVector(text, bracketStart);
}

function extractAdvancedQueryDsl(content) {
  const text = String(content ?? '')
    .trim()
    .replace(/^#\+BEGIN_QUERY\s*/i, '')
    .replace(/\s*#\+END_QUERY\s*$/i, '')
    .trim();
  const marker = text.search(/:query\s+\(/i);
  if (marker < 0) return null;
  const listStart = text.indexOf('(', marker);
  if (listStart < 0) return null;
  return extractBalancedList(text, listStart);
}

function normalizeAdvancedQueryBlockContent(content) {
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
  const ventureAttrs = [...text.matchAll(/\[?\?b\s+(:[^\s\]]+)\s+(?:\?current|\d+)\]/gi)].map((m) =>
    String(m[1]).split('/').pop()?.replace(/^:/, '').toLowerCase() ?? '',
  );
  const parts = [];
  for (const tag of [...new Set(tags)]) {
    if (tag) parts.push(`(tags ${tag})`);
  }
  if (ventureAttrs.some((attr) => attr.includes('venture'))) {
    parts.push('(property venture <% current page %>)');
  }
  return parts.length ? `(and ${parts.join(' ')})` : text;
}

function normalizeQueryBlockContent(content) {
  if (isAdvancedQueryBlockContent(content)) {
    return normalizeAdvancedQueryBlockContent(content);
  }
  let text = String(content ?? '')
    .trim()
    .replace(/^#Query\s+/, '');
  text = text.replace(/\s+\)/g, ')');
  text = text.replace(/\(property\s+:plugin\.property\.[^/\s]+\//gi, '(property ');
  text = text.replace(/\(property\s+:user\.property\.[^/\s]+\//gi, '(property ');
  text = text.replace(
    /\(property\s+venture\s+(?:\d+|\[\[[^\]]+\]\]|<% current page %>)\)/gi,
    '(property venture <% current page %>)',
  );
  text = text.replace(
    /\(property\s+(?:[^\s]+\/)?lss-object-type\s+"([^"]+)"\)/gi,
    (_, type) => `(tags ${safeTag(type).toLowerCase()})`,
  );
  text = text.replace(/\(page-tags\s+#?([^)\s]+)\)/gi, (_, tag) => `(tags ${safeTag(tag).toLowerCase()})`);
  text = text.replace(/\(tags\s+#?([^)\s]+)\)/gi, (_, tag) => `(tags ${safeTag(tag).toLowerCase()})`);
  text = text.replace(
    /\(page-property\s+venture\s+(?:<% current page %>|\d+|\[\[[^\]]+\]\])\)/gi,
    '(property venture <% current page %>)',
  );
  text = text.replace(
    /\(property\s+[^\s)]*venture[^\s)]*\s+(?:<% current page %>|\d+|\[\[[^\]]+\]\])\)/gi,
    '(property venture <% current page %>)',
  );
  text = text.replace(/\[\[([^\]]+)\]\]/g, (_, name) => `[[${normalizePageRefName(name)}]]`);
  return text.replace(/\s+/g, ' ').toLowerCase();
}

function queryBodyFromContent(content) {
  return String(content ?? '')
    .trim()
    .replace(/^#Query\s+/, '')
    .trim();
}

function queriesEquivalent(stored, expected) {
  return normalizeQueryBlockContent(stored) === normalizeQueryBlockContent(expected);
}

function queryUsesBarePropertyNames(content) {
  const text = String(content ?? '');
  if (/\(property\s+:(?:plugin|user)\.property/i.test(text)) return false;
  return (
    /\(property\s+(?!:)(?:venture|lss-object-type)\b/i.test(text) ||
    /\(tags\s+/i.test(text)
  );
}

function queryUsesDbQueryFilters(content) {
  const text = String(content ?? '');
  return /\(tags\s+/i.test(text) && /\(property\s+[^\s)]*venture\b/i.test(text);
}

function queryUsesLegacyDbPageQueryFilters(content) {
  const text = String(content ?? '');
  return /\(page-tags\s+/i.test(text) || /\(page-property\s+venture\b/i.test(text);
}

function queryUsesPropertyIdents(content) {
  return /\(property\s+:(?:plugin|user)\.property[\w.-]*\//i.test(String(content ?? ''));
}

function isLegacyBeginQueryWrapper(content) {
  return /#\+BEGIN_QUERY/i.test(String(content ?? ''));
}

function queryBodyFromBlockContent(content) {
  const text = String(content ?? '').trim();
  if (/^#\+BEGIN_QUERY/i.test(text)) {
    return text.replace(/^#\+BEGIN_QUERY\s*/i, '').replace(/\s*#\+END_QUERY\s*$/i, '').trim();
  }
  return queryBodyFromContent(text);
}

function normalizeAdvancedQueryVectorForRepair(content) {
  return String(extractAdvancedQueryVector(content) ?? queryBodyFromBlockContent(content))
    .replace(/\s+/g, ' ')
    .trim();
}

function extractAdvancedQueryInputs(content) {
  const body = queryBodyFromBlockContent(content);
  const match = body.match(/:inputs\s+(\[[\s\S]*?\])/i);
  return String(match?.[1] ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeAdvancedQueryForRepair(content) {
  const vector = normalizeAdvancedQueryVectorForRepair(content);
  const inputs = extractAdvancedQueryInputs(content);
  return `${vector} ::inputs ${inputs}`;
}

function queryBlockNeedsRepair(stored, expected) {
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

const tests = [
  () => {
    const ms = parseDatePropertyValue('[[2026-06-17]]');
    if (ms == null) throw new Error('wiki date should parse');
  },
  () => {
    const ms = parseDatePropertyValue({ originalName: '2026-06-17' });
    if (ms == null) throw new Error('journal object date should parse');
  },
  () => {
    if (isDbPageRefValue(1739750400000)) throw new Error('timestamp must not be page ref');
    if (!isDbPageRefValue(465)) throw new Error('page id 465 must be page ref');
    if (isDbPageRefValue('FTV')) throw new Error('plain text must not be page ref');
    if (!isDbPageRefValue([11182])) throw new Error('venture id array must be page ref');
  },
  () => {
    const a = '#Query (and (property :plugin.property.logseq-lss-db-final-plugin/venture [[ftv]] ))';
    const b = '(and (property venture <% current page %>))';
    if (!queriesEquivalent(a, b)) throw new Error('plugin venture ref should match current-page placeholder');
  },
  () => {
    if (looksLikePageEntityId('1739750400000')) throw new Error('timestamp is not page entity id');
  },
  () => {
    const stored = '#Query (and (property :plugin.property.logseq-lss-db-final-plugin/venture [[FTV]]))';
    const expected = '(and (property venture <% current page %>))';
    if (!queriesEquivalent(stored, expected)) throw new Error('[[FTV]] should match <% current page %> venture filter');
    if (!queryBlockNeedsRepair(stored, expected)) {
      throw new Error('legacy plugin-prefixed query should still need repair rewrite');
    }
    if (queryBlockNeedsRepair(expected, expected)) throw new Error('canonical query should not need repair');
  },
  () => {
    const entity = coerceNodePropertyReadValue({ id: 11182, name: 'FTV' });
    if (entity !== 11182) throw new Error('node entity should coerce to numeric page id');
    const text = coerceNodePropertyReadValue(['FTV']);
    if (text?.[0] !== 'FTV') throw new Error('plain text node values should stay as text');
  },
  () => {
    const stored = '(and (property :plugin.property.logseq-lss-db-final-plugin/venture 11182))';
    const expected = '(and (property venture <% current page %>))';
    if (!queriesEquivalent(stored, expected)) throw new Error('numeric venture id should match current-page filter');
    if (!queryBlockNeedsRepair(stored, expected)) throw new Error('numeric id query should need canonical rewrite');
  },
  () => {
    const stored =
      '(and (property lss-object-type "Function") (property venture <% current page %>))';
    const expected =
      '(and (property :plugin.property.logseq-lss-db-final-plugin/lss-object-type "Function") (property :plugin.property.logseq-lss-db-final-plugin/venture <% current page %>))';
    if (!queriesEquivalent(stored, expected)) throw new Error('bare names should be semantically equivalent to idents');
    if (!queryBlockNeedsRepair(stored, expected)) {
      throw new Error('bare property names should need ident rewrite when expected uses idents');
    }
    if (queryBlockNeedsRepair(expected, expected)) throw new Error('ident query should not need repair');
  },
  () => {
    const legacy =
      '(and (property :plugin.property.logseq-lss-db-final-plugin/lss-object-type "Function") (property :plugin.property.logseq-lss-db-final-plugin/venture <% current page %>))';
    const tags =
      '(and (tags Function) (property :plugin.property.logseq-lss-db-final-plugin/venture <% current page %>))';
    if (!queriesEquivalent(legacy, tags)) throw new Error('lss-object-type property should normalize to tags class filter');
    if (!queryBlockNeedsRepair(legacy, tags)) throw new Error('legacy object-type filter should need tags rewrite');
    if (queryBlockNeedsRepair(tags, tags)) throw new Error('tags query should not need repair');
  },
  () => {
    const canonical =
      '(and (tags Function) (property :plugin.property.logseq-lss-db-final-plugin/venture <% current page %>))';
    const legacy = '(and (page-tags Function) (page-property venture <% current page %>))';
    if (!queriesEquivalent(canonical, legacy)) {
      throw new Error('legacy page-tags/page-property should normalize to tags/property');
    }
    if (!queryBlockNeedsRepair(legacy, canonical)) {
      throw new Error('legacy page-tags/page-property query should need repair');
    }
    if (queryBlockNeedsRepair(canonical, canonical)) throw new Error('canonical DB query should not need repair');
  },
  () => {
    const simple =
      '(and (tags Function) (property :plugin.property.logseq-lss-db-final-plugin/venture <% current page %>))';
    const advanced = `{:query (and (tags Function) (property :plugin.property.logseq-lss-db-final-plugin/venture <% current page %>))}`;
    if (!queryBlockNeedsRepair(simple, advanced)) {
      throw new Error('DB dashboard should repair simple query to advanced EDN');
    }
    if (queryBlockNeedsRepair(advanced, advanced)) {
      throw new Error('advanced dashboard query should not need repair');
    }
    if (!advanced.includes('(property :plugin.property.logseq-lss-db-final-plugin/venture <% current page %>)')) {
      throw new Error('advanced venture clause should keep Logseq DSL current-page binding');
    }
  },
  () => {
    function looksLikeQueryEntityId(raw) {
      return /^\d+$/.test(raw) && Number(raw) > 0;
    }
    function readHitField(record, ...keys) {
      for (const key of keys) {
        if (record[key] != null) return record[key];
      }
      return null;
    }
    function findHitIdentity(item) {
      const queue = [item];
      const seen = new Set();
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
          continue;
        }
        if (Array.isArray(current)) {
          queue.push(...current);
          continue;
        }
        if (typeof current === 'object') {
          const record = current;
          const label = readHitField(record, 'blockTitle', 'blockName', 'name', 'title');
          if (typeof label === 'string' && label.trim()) return { kind: 'name', value: label.trim() };
          const id = readHitField(record, 'id', 'dbId', ':db/id', 'db/id');
          if (id != null && looksLikeQueryEntityId(String(id))) return { kind: 'id', value: String(id) };
          for (const value of Object.values(record)) queue.push(value);
        }
      }
      return null;
    }
    function flattenQueryHits(results) {
      if (!Array.isArray(results)) return results == null ? [] : [results];
      const out = [];
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
    const fromDbId = findHitIdentity({ dbId: 6525 });
    if (fromDbId?.kind !== 'id' || fromDbId.value !== '6525') {
      throw new Error('customQuery dbId object should resolve to entity id');
    }
    const fromBare = findHitIdentity(6525);
    if (fromBare?.value !== '6525') throw new Error('bare entity id hit should resolve');
    const fromNested = findHitIdentity([[{ id: 11182 }]]);
    if (fromNested?.value !== '11182') throw new Error('nested datalog tuple should flatten to entity id');
    const fromTitle = findHitIdentity({ blockTitle: 'Marketing', id: 6525 });
    if (fromTitle?.kind !== 'name' || fromTitle.value !== 'Marketing') {
      throw new Error('blockTitle should win over numeric id for labeling');
    }
    if (flattenQueryHits([[6525], [6530]]).length !== 2) {
      throw new Error('flattenQueryHits should unwrap singleton tuples');
    }
  },
  () => {
    function hasCodeChildFromParts(queryEdnInChild, langIsClojure, displayIsCodeKeyword) {
      return queryEdnInChild && displayIsCodeKeyword && langIsClojure;
    }
    function dbAdvancedQueryBlockNeedsStructureRepair(struct) {
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
    if (!hasCodeChildFromParts(true, true, true)) {
      throw new Error('EDN child with :code display-type and clojure lang should count as code child');
    }
    if (hasCodeChildFromParts(true, true, false)) {
      throw new Error('EDN child without :code display-type must not count as code child');
    }
    if (
      dbAdvancedQueryBlockNeedsStructureRepair({
        hasQueryClassTag: true,
        hasQueryProperty: true,
        hasCodeChild: true,
        rawEdnInParentContent: false,
        queryEdnInChild: true,
        childTitleHasEdn: true,
        childDisplayTypeIsCode: true,
        parentCollapsed: false,
      })
    ) {
      throw new Error('complete DB query structure should not need structure repair');
    }
    if (
      !dbAdvancedQueryBlockNeedsStructureRepair({
        hasQueryClassTag: false,
        hasQueryProperty: false,
        hasCodeChild: false,
        rawEdnInParentContent: true,
        queryEdnInChild: false,
      })
    ) {
      throw new Error('raw EDN parent without Query structure should need structure repair');
    }
  },
  () => {
    const advanced = `{:query (and (tags Function) (property :plugin.property.logseq-lss-db-final-plugin/venture <% current page %>))}`;
    const dsl = extractAdvancedQueryDsl(advanced);
    if (!dsl?.includes('(property :plugin.property.logseq-lss-db-final-plugin/venture <% current page %>)')) {
      throw new Error('extractAdvancedQueryDsl should pull full DSL expression');
    }
    if (extractAdvancedQueryVector(advanced) != null) throw new Error('DSL advanced query should not expose datalog vector');
  },
  () => {
    function normalizeKeywordPropertyName(name) {
      return String(name ?? '').trim().replace(/^:/, '');
    }
    if (normalizeKeywordPropertyName(':code') !== 'code') {
      throw new Error('normalizeKeywordPropertyName should strip leading colon');
    }
    if (normalizeKeywordPropertyName('  quote  ') !== 'quote') {
      throw new Error('normalizeKeywordPropertyName should trim whitespace');
    }
  },
  () => {
    function isQueryLikeContent(content) {
      const text = String(content ?? '').trim();
      const isAdvanced = /^\{[\s\S]*:query\s+(?:\[:find|\()/i.test(text);
      const isSimple = /^(\(and\s|\(or\s|\(tags\s|\(page-tags\s|\(property\s|\(page-property\s)/.test(
        text.replace(/^#Query\s+/, '').replace(/\s+/g, ' ').toLowerCase(),
      );
      return (
        isAdvanced ||
        isSimple ||
        text.includes('<% current page %>') ||
        text.includes('{{query') ||
        text.includes('Manual post-filter:') ||
        /^#Query\b/i.test(text)
      );
    }
    function isQueryLikeBlockSnapshot(block) {
      if (isQueryLikeContent(block?.content ?? '')) return true;
      const props = block?.properties ?? {};
      const queryRef = props.query ?? props[':logseq.property/query'];
      if (queryRef != null && (typeof queryRef === 'number' || /^\d+$/.test(String(queryRef)))) return true;
      const tags = block?.tags ?? props.tags;
      const names = new Set();
      const collect = (tag) => {
        if (typeof tag === 'string') names.add(tag.toLowerCase());
        else if (tag && typeof tag === 'object') {
          const name = tag.name ?? tag.originalName ?? tag.title;
          if (name) names.add(String(name).toLowerCase());
        }
      };
      if (Array.isArray(tags)) tags.forEach(collect);
      return names.has('query');
    }
    if (!isQueryLikeContent('#Query')) throw new Error('empty #Query shell should be query-like');
    if (!isQueryLikeBlockSnapshot({ content: '', properties: { query: 12345 } })) {
      throw new Error('query property ref should mark block as query-like');
    }
    if (!isQueryLikeBlockSnapshot({ content: '', tags: [{ name: 'Query' }] })) {
      throw new Error('Query class tag on snapshot should mark block as query-like');
    }
    function findAllQueryBlocksInSection(sectionBlock) {
      return (sectionBlock?.children ?? []).filter((block) => isQueryLikeBlockSnapshot(block));
    }
    const edn = `{:query (and (tags Function) (property :plugin.property.logseq-lss-db-final-plugin/venture <% current page %>))}`;
    const section = {
      children: [
        {
          content: '',
          properties: { query: 99 },
          tags: [{ name: 'Query' }],
          children: [{ id: 99, content: edn }],
        },
      ],
    };
    if (findAllQueryBlocksInSection(section).length !== 1) {
      throw new Error('nested advanced query code child must not count as a second section query');
    }
  },
  () => {
    function scoreQueryBlockCandidate(struct, content, expectedContent) {
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
    const expected = `{:query (and (tags Function) (property :plugin.property.logseq-lss-db-final-plugin/venture <% current page %>))}`;
    const good = scoreQueryBlockCandidate(
      {
        hasQueryClassTag: true,
        hasQueryProperty: true,
        hasCodeChild: true,
        rawEdnInParentContent: false,
        queryEdnInChild: true,
        childTitleHasEdn: true,
        childDisplayTypeIsCode: true,
        parentCollapsed: false,
      },
      expected,
      expected,
    );
    const bad = scoreQueryBlockCandidate(
      {
        hasQueryClassTag: false,
        hasQueryProperty: false,
        hasCodeChild: false,
        rawEdnInParentContent: true,
        queryEdnInChild: false,
        childTitleHasEdn: false,
        childDisplayTypeIsCode: false,
        parentCollapsed: true,
      },
      expected,
      expected,
    );
    if (good <= bad) throw new Error('canonical structured query block should outscore raw EDN shell');
  },
  () => {
    const advanced = `#+BEGIN_QUERY
{:query (and (tags Function) (property :plugin.property.logseq-lss-db-final-plugin/venture <% current page %>))}
#+END_QUERY`;
    const simple =
      '(and (tags function) (property venture <% current page %>))';
    if (!queriesEquivalent(advanced, simple)) {
      throw new Error('advanced query should normalize to tags+venture simple form');
    }
    if (!queryBlockNeedsRepair(advanced, simple)) {
      throw new Error('legacy BEGIN_QUERY wrapper should always need repair');
    }
  },
  () => {
    const advanced = `{:query (and (tags Function) (property :plugin.property.logseq-lss-db-final-plugin/venture <% current page %>))}`;
    const simple = '(and (tags function) (property venture <% current page %>))';
    if (!queriesEquivalent(advanced, simple)) {
      throw new Error('advanced DSL query should normalize');
    }
  },
  () => {
    const stored = `{:query [:find (pull ?b [*])
 :in $
 :where
 (or (and [?b :block/tags ?tag0_0] (or [?tag0_0 :block/title "Function"] [?tag0_0 :block/name "function"]))
     (and [?b :blocks/tags ?tag0_1] (or [?tag0_1 :block/title "Function"] [?tag0_1 :block/name "function"])))
 (or [?b :plugin.property.logseq-lss-db-final-plugin/venture 3505]
     [?b :plugin.property.logseq-lss-db-final-plugin/venture "FTV"])]}`;
    const expected = `{:query (and (tags Function) (property :plugin.property.logseq-lss-db-final-plugin/venture <% current page %>))}`;
    if (!queriesEquivalent(stored, expected)) {
      throw new Error('stale and expected advanced queries should remain semantically equivalent');
    }
    if (!queryBlockNeedsRepair(stored, expected)) {
      throw new Error('stale advanced OR query should need advanced DSL repair');
    }
  },
  () => {
    const stale = `{:query [:find (pull ?b [*])
 :in $ ?current
 :where
 [?b :block/tags ?tag]
 [?tag :block/title "Function"]
 [?b :plugin.property.logseq-lss-db-final-plugin/venture ?current]]
:inputs [:current-page]}`;
    const expected = `{:query (and (tags Function) (property :plugin.property.logseq-lss-db-final-plugin/venture <% current page %>))}`;
    if (!queriesEquivalent(stale, expected)) {
      throw new Error('stale :current-page and advanced DSL queries should be semantically equivalent');
    }
    if (!queryBlockNeedsRepair(stale, expected)) {
      throw new Error('stale :current-page advanced query should need advanced DSL repair');
    }
    if (queryBlockNeedsRepair(expected, expected)) {
      throw new Error('advanced DSL query should not need repair');
    }
  },
  () => {
    function liveQueryNote(anyHits, storedBestForNote) {
      if (!anyHits) {
        return 'DB.q/customQuery returned 0 for plugin probes';
      }
      if (storedBestForNote?.count && storedBestForNote.count > 0) {
        return `stored dashboard query resolves via ${storedBestForNote.channel}`;
      }
      return 'probe variants returned hits, but the stored dashboard query did not';
    }
    const note = liveQueryNote(true, { channel: 'advanced-dsl', count: 2 });
    if (!note.includes('advanced-dsl')) {
      throw new Error('successful stored advanced DSL query should get the success note');
    }
    const fallback = liveQueryNote(true, { channel: 'none', count: 0 });
    if (!fallback.includes('stored dashboard query did not')) {
      throw new Error('variant-only hits should still warn about stored query failure');
    }
  },
];

for (const [i, test] of tests.entries()) {
  test();
  console.log(`ok: test ${i + 1}`);
}
console.log(`validate-repair-logic: ${tests.length} passed`);
