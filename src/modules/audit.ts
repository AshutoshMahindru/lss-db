import { MODE } from '../config';
import {
  appendManagedBlock,
  blockId,
  currentPageName,
  ensurePage,
  flattenBlockText,
  getBlocks,
  getPage,
  resolvePageFromIdentity,
} from '../core/editor';
import { canonicalPropertyKey } from '../core/db-properties';
import { escapeRegExp, looksLikeUuid, safePageName, safeTag, tsKey, visiblePageLabel } from '../core/names';
import type { AuditFinding, Result } from '../core/types';
import { allObjects, allRelationships, allTags, registry } from '../registry';
import { readNativeTagSchemaFindings } from './diagnose-native-tags';
import { findAllQueryBlocksInSectionAsync, relationshipPropertyNames, sectionNameFromLine, tagsRequiringConfidentiality } from './queries';
import { stepVerify } from './setup';

function propertyValue(text: string, property: string): string | null {
  const re = new RegExp(`(^|\\n)\\s*${escapeRegExp(property)}::\\s*([^\\n]+)`, 'i');
  const match = re.exec(text);
  return match ? String(match[2] ?? '').trim() : null;
}

function hasProperty(text: string, property: string): boolean {
  return new RegExp(`(^|\\n)\\s*${escapeRegExp(property)}::`, 'i').test(text);
}

function isEmptyPropertyValue(value: string | null): boolean {
  if (value == null) return true;
  const trimmed = value.trim();
  return !trimmed || trimmed === '-' || trimmed === '[[]]';
}

function detectObjects(text: string) {
  // Primary match is the class #tag. lss-object-type is a compatibility fallback.
  const detected = allObjects().filter((o) => {
    const tagHit = text.includes(`#${safeTag(o.tag)}`);
    const typeHit = text.includes(`lss-object-type:: ${o.name}`);
    return tagHit || typeHit;
  });
  return detected;
}

function auditRequiredProperties(text: string, pageName: string): AuditFinding[] {
  // Audit uses RegistryObject.requiredProperties. Entity pages materialize those properties;
  // native Logseq tag properties are intentionally not the LSS instance schema source.
  const findings: AuditFinding[] = [];
  for (const obj of detectObjects(text)) {
    for (const prop of obj.requiredProperties ?? []) {
      const value = propertyValue(text, prop);
      if (!hasProperty(text, prop)) {
        findings.push({
          ruleId: 'LSS-AUD-004-required-property-values',
          severity: 'ERROR',
          message: `${pageName}: #${safeTag(obj.tag)} missing required property ${prop}`,
          suggestedFix: `Add ${prop}:: with a non-empty value.`,
        });
      } else if (isEmptyPropertyValue(value)) {
        findings.push({
          ruleId: 'LSS-AUD-004-required-property-values',
          severity: 'ERROR',
          message: `${pageName}: #${safeTag(obj.tag)} has empty required property ${prop}`,
          suggestedFix: `Fill ${prop}:: with a meaningful value.`,
        });
      }
    }
  }
  return findings;
}

const KEY_RELATIONSHIP_VALIDATION_PROPS = new Set([
  'venture',
  'project',
  'related-project',
  'related-projects',
  'participants',
  'attendees',
  'related-to',
]);

type RelationshipAuditValue = {
  display: string;
  raw: string;
  kind: 'wiki' | 'identity' | 'tag' | 'url' | 'text';
};

function isRelationshipIdentity(value: string): boolean {
  const raw = String(value ?? '').trim();
  return /^\d+$/.test(raw) || looksLikeUuid(raw);
}

function normalizeRelationshipAuditValue(value: string): string {
  return visiblePageLabel(String(value ?? '').trim())
    .replace(/^["'`]+|["'`]+$/g, '')
    .trim();
}

function classifyRelationshipAuditValue(value: string, kind?: RelationshipAuditValue['kind']): RelationshipAuditValue | null {
  const display = normalizeRelationshipAuditValue(value);
  if (!display || display === '-' || display === '[[]]') return null;
  if (kind) return { display, raw: String(value ?? '').trim(), kind };
  if (/^https?:/i.test(display)) return { display, raw: display, kind: 'url' };
  if (display.startsWith('#')) return { display, raw: display, kind: 'tag' };
  if (isRelationshipIdentity(display)) return { display, raw: display, kind: 'identity' };
  return { display, raw: display, kind: 'text' };
}

function relationshipAuditValues(value: string): RelationshipAuditValue[] {
  const raw = String(value ?? '').trim();
  if (!raw) return [];

  const values: RelationshipAuditValue[] = [];
  const refs = [...raw.matchAll(/\[\[([^\]]+)\]\]/g)];
  for (const match of refs) {
    const parsed = classifyRelationshipAuditValue(match[1] ?? '', 'wiki');
    if (parsed) values.push({ ...parsed, raw: `[[${parsed.display}]]` });
  }

  if (refs.length) {
    const remainder = raw
      .replace(/\[\[[^\]]+\]\]/g, ',')
      .split(',')
      .map((part) => classifyRelationshipAuditValue(part))
      .filter((part): part is RelationshipAuditValue => Boolean(part));
    return [...values, ...remainder];
  }

  const parts = raw
    .split(',')
    .map((part) => classifyRelationshipAuditValue(part))
    .filter((part): part is RelationshipAuditValue => Boolean(part));
  if (parts.length > 1 && parts.every((part) => part.kind === 'identity' || part.kind === 'tag' || part.kind === 'url')) {
    return parts;
  }

  const parsed = classifyRelationshipAuditValue(raw);
  return parsed ? [parsed] : [];
}

function isPlainTextRelationshipValue(value: string): boolean {
  const trimmed = String(value ?? '').trim();
  if (!trimmed || trimmed === '-' || trimmed === '[[]]') return false;
  const parts = relationshipAuditValues(trimmed);
  const allIdentities = parts.length > 0 && parts.every((part) => part.kind === 'identity');
  return !allIdentities && !trimmed.includes('[[') && !trimmed.includes('#') && !/^https?:/i.test(trimmed) && !isRelationshipIdentity(trimmed);
}

async function relationshipValueResolvesToPage(value: RelationshipAuditValue): Promise<boolean> {
  if (value.kind === 'identity') return Boolean(await resolvePageFromIdentity(value.display).catch(() => null));
  if (value.kind !== 'wiki') return false;
  const pageName = value.display;
  return Boolean(
    (await getPage(pageName)) ||
      (await getPage(safePageName(pageName))) ||
      (await getPage(pageName.toLowerCase())) ||
      (await resolvePageFromIdentity(pageName).catch(() => null)),
  );
}

async function auditRelationshipReferences(text: string, pageName: string): Promise<AuditFinding[]> {
  const findings: AuditFinding[] = [];
  const props = new Set([...relationshipPropertyNames(), ...KEY_RELATIONSHIP_VALIDATION_PROPS]);
  for (const prop of props) {
    const value = propertyValue(text, prop);
    if (!value) continue;
    const isKeyRelationship = KEY_RELATIONSHIP_VALIDATION_PROPS.has(prop);
    const plainTextValue = isPlainTextRelationshipValue(value);
    if (plainTextValue) {
      findings.push({
        ruleId: 'LSS-AUD-005-node-properties-use-node-references',
        severity: 'ERROR',
        message: `${pageName}: ${prop}:: uses plain text "${value}" instead of node reference`,
        suggestedFix: 'Run lss: 39convert-text-relationships or repair manually with [[Page]] refs.',
      });
    }
    if (!isKeyRelationship) continue;
    for (const part of relationshipAuditValues(value)) {
      if (part.kind === 'text') {
        if (plainTextValue && part.display === normalizeRelationshipAuditValue(value)) continue;
        findings.push({
          ruleId: 'LSS-AUD-005-node-properties-use-node-references',
          severity: 'ERROR',
          message: `${pageName}: ${prop}:: value "${part.display}" is not a page reference`,
          suggestedFix: `Select or link a real page for ${prop}; run lss: 39convert-text-relationships or lss: materialise page.`,
        });
      } else if (part.kind === 'tag' || part.kind === 'url') {
        findings.push({
          ruleId: 'LSS-AUD-005-node-properties-use-node-references',
          severity: 'ERROR',
          message: `${pageName}: ${prop}:: value "${part.display}" is a ${part.kind}, not a page reference`,
          suggestedFix:
            part.kind === 'tag'
              ? `Replace ${part.display} with a page link like [[${safePageName(part.display.replace(/^#/, ''))}]].`
              : `Replace the URL with a page link that represents the ${prop} target.`,
        });
      } else if (!(await relationshipValueResolvesToPage(part))) {
        findings.push({
          ruleId: 'LSS-AUD-005-node-properties-use-node-references',
          severity: 'ERROR',
          message: `${pageName}: ${prop}:: page reference "${part.raw}" does not resolve to an existing page`,
          suggestedFix: `Create or select the target page, then repair ${prop} with lss: materialise page if needed.`,
        });
      }
    }
  }
  return findings;
}

function formatAuditPropertyValue(value: unknown): string {
  if (value == null) return '';
  if (Array.isArray(value)) return value.map(formatAuditPropertyValue).filter(Boolean).join(', ');
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const name = String(record.originalName ?? record.name ?? record.title ?? '').trim();
    if (name) return `[[${safePageName(name)}]]`;
    const id = record.id ?? record.uuid;
    return id != null ? String(id) : '';
  }
  return String(value).trim();
}

async function readPagePropertyText(pageName: string): Promise<string> {
  const page = await getPage(pageName);
  const pageBlockId = blockId(page);
  const props = new Map<string, string>();
  const assign = (source: Record<string, unknown> | null | undefined) => {
    if (!source) return;
    for (const [rawKey, rawValue] of Object.entries(source)) {
      const key = canonicalPropertyKey(rawKey);
      if (!key || key === 'tags' || key.startsWith('block/')) continue;
      const value = formatAuditPropertyValue(rawValue);
      if (value) props.set(key, value);
    }
  };
  assign((page as Record<string, unknown> | null)?.properties as Record<string, unknown> | undefined);
  if (logseq.Editor.getPageProperties) {
    assign((await logseq.Editor.getPageProperties(pageName).catch(() => null)) ?? undefined);
  }
  if (pageBlockId && logseq.Editor.getBlockProperties) {
    assign((await logseq.Editor.getBlockProperties(pageBlockId).catch(() => null)) ?? undefined);
  }
  return [...props.entries()].map(([key, value]) => `${key}:: ${value}`).join('\n');
}

function auditConfidentiality(text: string, pageName: string): AuditFinding[] {
  const findings: AuditFinding[] = [];
  const sensitive = tagsRequiringConfidentiality();
  for (const obj of detectObjects(text)) {
    const tag = safeTag(obj.tag);
    const isSensitive =
      sensitive.has(tag) ||
      sensitive.has(obj.name) ||
      (obj.area ?? '').includes('Area/Health') ||
      (obj.area ?? '').includes('Area/Wealth');
    if (!isSensitive) continue;
    const value = propertyValue(text, 'confidentiality');
    if (!hasProperty(text, 'confidentiality') || isEmptyPropertyValue(value)) {
      findings.push({
        ruleId: 'LSS-AUD-014-confidentiality-required-for-sensitive-types',
        severity: 'ERROR',
        message: `${pageName}: sensitive object #${tag} missing confidentiality`,
        suggestedFix: 'Set confidentiality:: internal (or appropriate classification).',
      });
    }
  }
  return findings;
}

function auditNamespacedPage(pageName: string): AuditFinding[] {
  const findings: AuditFinding[] = [];
  const candidates = allObjects().filter((o) => String(o.nodeKind ?? '').includes('page'));
  const match = candidates.find(
    (o) =>
      pageName.startsWith(`${o.name}/`) ||
      pageName.startsWith(`${safeTag(o.tag)}/`) ||
      pageName.startsWith(`${o.name} - `) ||
      pageName.startsWith(`${safeTag(o.tag)} - `),
  );
  if (match) {
    findings.push({
      ruleId: 'LSS-AUD-009-namespaced-instances',
      severity: 'WARNING',
      message: `${pageName}: appears to be a namespaced ${match.name} instance page`,
      suggestedFix: 'Run lss: 40migrate-namespaced-objects to flatten to clean page + tag.',
    });
  }
  return findings;
}

async function auditDashboardSections(blocks: any[], pageName: string): Promise<AuditFinding[]> {
  const findings: AuditFinding[] = [];
  const stack = [...blocks];
  while (stack.length) {
    const block = stack.shift();
    const section = sectionNameFromLine(block?.content);
    if (section) {
      const hasQuery = (await findAllQueryBlocksInSectionAsync(block)).length > 0;
      if (!hasQuery) {
        findings.push({
          ruleId: 'LSS-AUD-010-dashboard-query-backed-sections',
          severity: 'ERROR',
          message: `${pageName}: dashboard section "${section}" has no query-backed block`,
          suggestedFix: 'Run lss: materialise page or insert dashboard with lss: 35-37.',
        });
      }
    }
    if (block?.children) stack.push(...block.children);
  }
  return findings;
}

function formatAuditReport(pageName: string, findings: AuditFinding[]): string {
  const lines: string[] = [];
  lines.push(`Audit for ${pageName}`);
  lines.push(`checked-at:: ${new Date().toISOString()}`);
  lines.push(`plugin-version:: 2.0.45`);
  lines.push('');
  if (!findings.length) {
    lines.push('## Summary');
    lines.push('- No issues detected by active audit rules.');
    return lines.join('\n');
  }
  const bySeverity = { ERROR: 0, WARNING: 0, INFO: 0 };
  for (const f of findings) bySeverity[f.severity]++;
  lines.push('## Summary');
  lines.push(`- ERROR: ${bySeverity.ERROR}`);
  lines.push(`- WARNING: ${bySeverity.WARNING}`);
  lines.push(`- INFO: ${bySeverity.INFO}`);
  lines.push('');
  for (const severity of ['ERROR', 'WARNING', 'INFO'] as const) {
    const group = findings.filter((f) => f.severity === severity);
    if (!group.length) continue;
    lines.push(`## ${severity}`);
    for (const f of group) {
      lines.push(`- [${f.ruleId}] ${f.message}`);
      if (f.suggestedFix) lines.push(`  - suggested-fix:: ${f.suggestedFix}`);
    }
    lines.push('');
  }
  return lines.join('\n').trim();
}

export async function auditCurrentPage(r: Result): Promise<void> {
  const page = await currentPageName();
  if (!page) {
    r.errors.push('No current page detected. Open a page and rerun.');
    return;
  }
  const blocks = await getBlocks(page);
  const propText = await readPagePropertyText(page);
  const text = [flattenBlockText(blocks), propText].filter(Boolean).join('\n');
  const findings: AuditFinding[] = [
    ...auditNamespacedPage(page),
    ...auditRequiredProperties(text, page),
    ...(await auditRelationshipReferences(text, page)),
    ...auditConfidentiality(text, page),
    ...(await auditDashboardSections(blocks, page)),
  ];

  const report = formatAuditReport(page, findings);
  await ensurePage(r, 'LSS Audit');
  await appendManagedBlock(r, 'LSS Audit', `${MODE}-audit-current-${tsKey()}`, report);

  const errors = findings.filter((f) => f.severity === 'ERROR').length;
  const warnings = findings.filter((f) => f.severity === 'WARNING').length;
  r.notes.push(`Audit findings: ${errors} ERROR, ${warnings} WARNING, ${findings.length - errors - warnings} INFO.`);
}

export async function auditGraph(r: Result): Promise<void> {
  await stepVerify(r);
  r.notes.push(
    `Registry counts: areas=${(registry.areas ?? []).length}, entities=${(registry.entityTypes ?? []).length}, forms=${(registry.formTypes ?? []).length}, tags=${allTags().length}, relationships=${allRelationships().length}.`,
  );
  if (MODE === 'db') {
    const nativeTagSchema = await readNativeTagSchemaFindings();
    if (!nativeTagSchema.available) {
      r.notes.push('Native tag schema pollution: inspection unavailable (getTag/getTagsByName APIs missing).');
    } else if (!nativeTagSchema.findings.length) {
      r.notes.push('Native tag schema pollution: none detected.');
    } else {
      const totalProps = nativeTagSchema.findings.reduce((sum, finding) => sum + finding.properties.length, 0);
      const sample = nativeTagSchema.findings
        .slice(0, 10)
        .map((finding) => `#${finding.tag}(${finding.properties.length}: ${finding.properties.slice(0, 5).join(', ')})`)
        .join('; ');
      r.notes.push(
        `Native tag schema pollution: ${nativeTagSchema.findings.length} tag(s), ${totalProps} schema property binding(s). ${sample}${nativeTagSchema.findings.length > 10 ? '; ...' : ''}`,
      );
      r.actions.push('Run lss: 54clean-native-tag-schema-properties, then lss: 51diagnose-current-page on affected journals.');
    }
  }
  const applicableRules = (registry.auditRules ?? []).filter((rule) =>
    ['instances', 'dashboards', 'privacy', 'properties'].includes(String(rule.scope ?? '')),
  );
  r.notes.push(`Registry audit rules applicable to page-level checks: ${applicableRules.length}.`);
  r.notes.push('Run lss: 33audit-current-page on individual pages for detailed instance audits.');
}
