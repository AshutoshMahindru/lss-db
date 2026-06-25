import { MODE } from '../config';
import { safeMarkdownRefs, safePageName, safeTag } from '../core/names';
import {
  allRelationships,
  allObjects,
  allTags,
  areaRelationshipPropertiesForObject,
  normalizeAreaRef,
  objectsForArea,
  propertySpec,
  registry,
  relationshipsForTag,
} from '../registry';
import type { RegistryArea, RegistryObject, RegistryRelationship, RegistryTemplate } from '../registry/types';

export function starterWordEntries(): Array<{
  page: string;
  tag: string;
  body: string;
  props?: Record<string, string>;
}> {
  const entries: Array<{ page: string; tag: string; body: string; props?: Record<string, string> }> = [];
  for (const area of registry.areas ?? []) {
    entries.push({
      page: `Word Extender/Domain Vocabulary/${area.name}`,
      tag: 'DomainVocabulary',
      props: { area: safePageName(area.page), status: 'active' },
      body: `Terms for ${area.name}:\n- Add controlled vocabulary here.`,
    });
  }
  for (const o of allObjects()) {
    entries.push({
      page: `Word Extender/Naming Rule/${o.name}`,
      tag: 'NamingRule',
      props: { 'applies-to': `#${o.tag}`, status: 'active' },
      body: `Naming rule:\n- Use clear, specific names for ${o.name} objects.\n- Avoid generic names like Untitled or Misc.`,
    });
  }
  const abbreviations: Array<[string, string]> = [
    ['rp', 'related-project::'],
    ['rv', 'related-venture::'],
    ['own', 'owner::'],
    ['ven', 'venture::'],
    ['ws', 'workstream::'],
    ['doc', 'related-document::'],
    ['act', 'next-action::'],
  ];
  for (const [trigger, replacement] of abbreviations) {
    entries.push({
      page: `Word Extender/Abbreviation/${trigger}`,
      tag: 'Abbreviation',
      props: { trigger, 'replacement-text': replacement, status: 'active' },
      body: `Expansion:\n- ${trigger} -> ${replacement}`,
    });
  }
  for (const v of registry.viewDefinitions ?? []) {
    entries.push({
      page: `Word Extender/Query Snippet/${v.id ?? v.title}`,
      tag: 'QuerySnippet',
      props: { status: 'active' },
      body: `Query intent:\n- ${v.queryIntent ?? v.intent ?? v.title ?? v.id}`,
    });
  }
  return entries;
}

function contractHeader(kind: string, name: string, canonical: string): string {
  return [
    `${kind}: ${name}`,
    `lss-kind:: ${kind}`,
    `lss-current-page:: ${safePageName(canonical)}`,
    `lss-canonical-page:: ${canonical}`,
    `lss-mode:: ${MODE}`,
    `lss-schema-version:: ${registry.schemaVersion}`,
  ].join('\n');
}

export function formatTagMention(tag: string): string {
  // Never use (#Tag) — Logseq parses the closing paren as part of the tag name (e.g. #Function)).
  return `#${safeTag(tag)}`;
}

export function areaContract(area: RegistryArea): string {
  const related =
    objectsForArea(area.page).map((o) => `${o.name} · ${formatTagMention(o.tag)}`).join(', ') || '-';
  return [
    contractHeader('Area', area.name, area.page),
    `icon:: ${area.icon ?? ''}`,
    `db-tag:: #${area.tag ?? 'Area'}`,
    `description:: ${area.description ?? ''}`,
    '',
    'Objects in this area:',
    related,
  ].join('\n');
}

export function objectContract(o: RegistryObject, kind: string): string {
  const props = [...(o.properties ?? []), ...areaRelationshipPropertiesForObject(o)];
  const rels = relationshipsForTag(safeTag(o.tag));
  return [
    contractHeader(kind, o.name, o.schemaPage),
    `db-tag:: #${o.tag}`,
    `area:: ${normalizeAreaRef(o.area)}`,
    `node-kind:: ${o.nodeKind ?? '-'}`,
    `extends:: ${(o.extends ?? []).map((x) => '#' + x).join(', ') || '-'}`,
    `template:: ${safePageName(o.template ?? '')}`,
    `dashboard-section:: ${o.dashboardSection ?? '-'}`,
    `required-properties:: ${(o.requiredProperties ?? []).join(', ') || '-'}`,
    '',
    'Canonical page properties (materialized on entity/form/word pages; templates provide layout only):',
    ...props.map((p) => `- ${p}`),
    '',
    'Relationships:',
    ...(rels.length
      ? rels.map(
          (r) =>
            `- ${r.property} -> ${(r.targets ?? r.allowedTargets ?? []).join(', ') || r.targetTags || '-'}`,
        )
      : ['- None registered']),
  ].join('\n');
}

export function tagContract(tag: string): string {
  const matches = allObjects().filter((o) => safeTag(o.tag) === tag);
  const base = (registry.baseTags ?? []).find((b) => safeTag(b.name ?? b.tag ?? '') === tag);
  const baseDescription = base?.description ? `description:: ${base.description}` : null;
  const baseGroup = base?.modelGroup ? `model-group:: ${base.modelGroup}` : null;
  return [
    contractHeader(MODE === 'db' ? 'DB Tag' : 'Tag Reference', tag, `${MODE === 'db' ? 'DB Tag' : 'Tag Reference'}/${tag}`),
    `tag:: #${tag}`,
    `native-db-tag:: ${MODE === 'db' ? 'yes' : 'no'}`,
    ...(baseDescription ? [baseDescription] : []),
    ...(baseGroup ? [baseGroup] : []),
    `extends:: ${
      matches
        .flatMap((o) => o.extends ?? [])
        .map((x) => '#' + x)
        .join(', ') ||
      (base?.extends ?? []).join(', ') ||
      '-'
    }`,
    '',
    'Usage policy:',
    '- Class tags identify what a page/block is.',
    '- Contextual tags add browsing/filtering context.',
    '- LSS entity schema fields are materialized as page properties, not native tag properties.',
    '',
    'Used by:',
    ...(matches.length
      ? matches.map((o) => `- ${o.name} (${o.schemaPage})`)
      : ['- Base/admin tag or reference tag']),
  ].join('\n');
}

export function tagPropertiesContract(tag: string): string {
  const objs = allObjects().filter((o) => safeTag(o.tag) === tag);
  const props = new Set<string>();
  for (const o of objs) for (const p of o.properties ?? []) props.add(p);
  const rels = relationshipsForTag(tag);
  return [
    contractHeader(
      MODE === 'db' ? 'Tag Properties' : 'Property Reference',
      tag,
      `${MODE === 'db' ? 'Tag Properties' : 'Property Reference'}/${tag}`,
    ),
    `tag:: #${tag}`,
    `native-db-tag-properties:: documentation-only`,
    `native-db-binding:: disabled for LSS instance schema`,
    '',
    'Property fields:',
    ...([...props].length
      ? [...props].sort().map((p) => {
          const spec = propertySpec(p);
          const typ = spec?.type ?? spec?.kind ?? 'unspecified';
          const sens = spec?.sensitivity ? `; sensitivity=${spec.sensitivity}` : '';
          return `- ${p} (${typ}${sens})`;
        })
      : ['- No direct properties registered']),
    '',
    'Native tag property policy:',
    '- These fields document the canonical page properties for matching entities/forms/word extenders.',
    '- They are not bound to the native Logseq tag, because native tag properties render on every tagged block.',
    '- Run lss: 11setup-db-native-config to remove LSS entity schema properties from native tags.',
    '',
    'Relationship fields:',
    ...(rels.length
      ? rels.map(
          (r) =>
            `- ${r.property} -> ${(r.targets ?? r.allowedTargets ?? r.targetTags ?? []).join(', ') || '-'}`,
        )
      : ['- None']),
  ].join('\n');
}

export function relationshipContract(r: RegistryRelationship): string {
  const property = String(r.property ?? 'unknown');
  return [
    contractHeader('Relationship', property, `Relationship/${property}`),
    `property:: ${property}`,
    `type:: ${r.type ?? 'Node'}`,
    `targets:: ${(r.targets ?? r.allowedTargets ?? r.targetTags ?? []).join(', ') || '-'}`,
    `cardinality:: ${r.cardinality ?? '-'}`,
    `bidirectional:: ${r.bidirectional ?? false}`,
    `inverse-label:: ${r.inverseLabel ?? r.inverse ?? '-'}`,
    `audit-severity:: ${r.auditSeverity ?? '-'}`,
  ].join('\n');
}

export function dashboardContract(d: {
  name?: string;
  page: string;
  status?: string;
  sections?: Array<string | { title?: string; id?: string }>;
  views?: string[];
}): string {
  const views = (registry.viewDefinitions ?? []).filter(
    (v) => (d.views ?? []).includes(v.id) || v.dashboard === d.page,
  );
  return [
    contractHeader('Dashboard', d.name ?? d.page, d.page),
    `status:: ${d.status ?? 'active'}`,
    `page:: ${safePageName(d.page)}`,
    '',
    'Sections / view intent:',
    ...(views.length
      ? views.map((v) => `- ${v.title ?? v.id}: ${v.queryIntent ?? v.intent ?? 'query-backed section'}`)
      : (d.sections ?? []).map((s: any) => `- ${typeof s === 'string' ? s : s.title ?? s.id}`)),
  ].join('\n');
}

export function templateReference(t: RegistryTemplate): string {
  const name = String(t.name ?? '').replace(/^Template\//, '');
  return [
    contractHeader(MODE === 'db' ? 'Template Reference' : 'Legacy Template Reference', name, t.name),
    `applies-to:: ${(t.appliesTo ?? []).map((x) => '#' + x).join(', ') || '-'}`,
    `node-kind:: ${t.nodeKind ?? '-'}`,
    `status:: ${t.status ?? 'active'}`,
    `native-template-created-by:: lss: 8setup-templates`,
    'NOTE: Properties are NOT taken from this body. See RegistryObject for the tag.',
    '',
    'Body (layout/sections only; property schema lives on the matching RegistryObject via tag):',
    '```markdown',
    safeMarkdownRefs(t.body ?? ''),
    '```',
  ].join('\n');
}

export function wordEntryContract(
  page: string,
  tag: string,
  body: string,
  props: Record<string, string> = {},
): string {
  const lines = [contractHeader('Word Extender', page.split('/').slice(-1)[0], page), `tag:: #${tag}`];
  for (const [k, v] of Object.entries(props)) lines.push(`${k}:: ${v}`);
  lines.push('', body);
  return lines.join('\n');
}

export function nativeDbTemplateText(): string {
  const parts: string[] = [];
  parts.push('- LSS Native Template Index');
  parts.push('  - These child blocks are native Logseq DB templates.');
  parts.push('  - Run /template after inserting this outline and waiting for indexing.');
  for (const t of registry.templates ?? []) {
    let body = safeMarkdownRefs(String(t.body ?? '').trim());
    const tag = safeTag((t.appliesTo ?? [])[0] ?? '');
    if (!body) continue;
    if (!body.includes('#Template')) {
      body = body.replace(/^\s*-\s*/, `- ${String(t.name).replace(/^Template\//, '')} #Template\n  `);
    }
    const lines = body.split(/\r?\n/);
    if (lines.length) {
      const root = lines[0];
      const rest = lines.slice(1);
      parts.push(root);
      parts.push(`  template-name:: ${String(t.name).replace(/^Template\//, '')}`);
      parts.push(`  applies-to:: ${tag ? '#' + tag : '-'}`);
      parts.push(`  node-kind:: ${t.nodeKind ?? '-'}`);
      parts.push(...rest);
    }
  }
  return parts.join('\n');
}

export function legacyTemplateText(): string {
  const parts: string[] = [];
  parts.push('- LSS Legacy Template Index');
  parts.push('  - These child blocks use legacy Markdown Logseq template properties.');
  for (const t of registry.templates ?? []) {
    const title = String(t.name ?? '').replace(/^Template\//, '');
    const body = safeMarkdownRefs(String(t.body ?? '')).replace(/#Template/g, '').split(/\r?\n/);
    parts.push(`- ${title}`);
    parts.push(`  template:: ${title}`);
    parts.push(`  template-including-parent:: false`);
    for (const line of body.slice(1)) parts.push(line);
  }
  return parts.join('\n');
}

export function pageTreeText(): string {
  const lines: string[] = [];
  const node = (name: string, depth = 0) => {
    lines.push(`${'  '.repeat(depth)}- ${safePageName(name)}`);
  };
  node('Home');
  node('Pages', 1);
  node('Areas', 2);
  for (const a of registry.areas ?? []) node(a.page, 3);
  node('Entity-Pages', 2);
  for (const a of registry.areas ?? []) {
    const entities = (registry.entityTypes ?? []).filter((o) => o.area === a.page);
    if (entities.length) {
      node(`${a.name} Entity Pages`, 3);
      for (const o of entities) node(o.schemaPage, 4);
    }
  }
  const crossEntities = (registry.entityTypes ?? []).filter((o) => String(o.area ?? '').includes('Cross'));
  if (crossEntities.length) {
    node('Cross-Cutting Entity Pages', 3);
    for (const o of crossEntities) node(o.schemaPage, 4);
  }
  node('Forms', 2);
  for (const o of registry.formTypes ?? []) node(o.schemaPage, 3);
  node('Relationships', 2);
  for (const r of allRelationships()) node(`Relationship/${r.property}`, 3);
  node('Templates', 1);
  for (const t of registry.templates ?? []) node(t.name, 2);
  node('Word Extenders', 1);
  for (const e of starterWordEntries()) node(e.page, 2);
  node('Dashboards', 1);
  for (const d of registry.dashboardDefinitions ?? []) node(d.page, 2);
  node('LSS Schema', 1);
  node('LSS Audit', 2);
  node('LSS Migrations', 2);
  node('LSS Exports', 2);
  node('LSS Reports', 2);
  if (MODE === 'db') {
    node('DB Tags', 1);
    for (const tag of allTags()) node(`DB Tag/${tag}`, 2);
    node('Tag Properties', 1);
    for (const tag of allTags()) node(`Tag Properties/${tag}`, 2);
  }
  return lines.join('\n');
}
