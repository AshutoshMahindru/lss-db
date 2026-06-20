import { MODE } from '../config';
import {
  appendManagedBlock,
  currentPageName,
  ensurePage,
  flattenBlockText,
  getBlocks,
} from '../core/editor';
import { escapeRegExp, safePageName, safeTag, tsKey } from '../core/names';
import type { AuditFinding, Result } from '../core/types';
import { allObjects, allTags, registry } from '../registry';
import { isQueryLikeContent, relationshipPropertyNames, sectionNameFromLine, tagsRequiringConfidentiality } from './queries';
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

function auditPlainTextRelationships(text: string, pageName: string): AuditFinding[] {
  const findings: AuditFinding[] = [];
  for (const prop of relationshipPropertyNames()) {
    const value = propertyValue(text, prop);
    if (!value) continue;
    if (!value.includes('[[') && !value.includes('#') && !/^https?:/i.test(value) && value.trim()) {
      findings.push({
        ruleId: 'LSS-AUD-005-node-properties-use-node-references',
        severity: 'ERROR',
        message: `${pageName}: ${prop}:: uses plain text "${value}" instead of node reference`,
        suggestedFix: 'Run lss: 39convert-text-relationships or repair manually with [[Page]] refs.',
      });
    }
  }
  return findings;
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

function auditDashboardSections(blocks: any[], pageName: string): AuditFinding[] {
  const findings: AuditFinding[] = [];
  const stack = [...blocks];
  while (stack.length) {
    const block = stack.shift();
    const section = sectionNameFromLine(block?.content);
    if (section) {
      const children = block?.children ?? [];
      const hasQuery = children.some((child: any) => isQueryLikeContent(child?.content));
      if (!hasQuery) {
        findings.push({
          ruleId: 'LSS-AUD-010-dashboard-query-backed-sections',
          severity: 'ERROR',
          message: `${pageName}: dashboard section "${section}" has no query-backed child block`,
          suggestedFix: 'Run lss: 50repair-current-page or insert dashboard with lss: 35-37.',
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
  lines.push(`plugin-version:: 2.0.0`);
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
  const text = flattenBlockText(blocks);
  const findings: AuditFinding[] = [
    ...auditNamespacedPage(page),
    ...auditRequiredProperties(text, page),
    ...auditPlainTextRelationships(text, page),
    ...auditConfidentiality(text, page),
    ...auditDashboardSections(blocks, page),
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
    `Registry counts: areas=${(registry.areas ?? []).length}, entities=${(registry.entityTypes ?? []).length}, forms=${(registry.formTypes ?? []).length}, tags=${allTags().length}, relationships=${(registry.relationshipRegistry ?? []).length}.`,
  );
  const applicableRules = (registry.auditRules ?? []).filter((rule) =>
    ['instances', 'dashboards', 'privacy', 'properties'].includes(String(rule.scope ?? '')),
  );
  r.notes.push(`Registry audit rules applicable to page-level checks: ${applicableRules.length}.`);
  r.notes.push('Run lss: 33audit-current-page on individual pages for detailed instance audits.');
}
