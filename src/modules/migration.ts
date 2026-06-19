import { MODE } from '../config';
import {
  appendManagedBlock,
  currentPageName,
  ensurePage,
  getBlocks,
  walkBlocks,
} from '../core/editor';
import { escapeRegExp, fixPhantomTagParenSyntax, safePageName, safeTag, tsKey } from '../core/names';
import type { Result } from '../core/types';
import { allObjects, registry } from '../registry';
import { relationshipPropertyNames } from './queries';

function aliasPairs(): Array<{ from: string; to: string }> {
  const pairs: Array<{ from: string; to: string }> = [];
  for (const a of registry.propertyAliases ?? []) {
    if (a.scope) continue;
    const from = String(a.alias ?? a.deprecated ?? '').trim();
    const to = String(a.canonical ?? '').trim();
    if (from && to && from !== to) pairs.push({ from, to });
  }
  return pairs;
}

export function normalizePropertyContent(content: string): { content: string; changes: string[] } {
  const phantom = fixPhantomTagParenSyntax(content);
  let out = phantom.content;
  const changes: string[] = [...phantom.changes];
  for (const { from, to } of aliasPairs()) {
    const re = new RegExp(`(^|\\n)(\\s*)${escapeRegExp(from)}::`, 'gi');
    out = out.replace(re, (_m, nl, indent) => {
      changes.push(`${from}:: -> ${to}::`);
      return `${nl}${indent}${to}::`;
    });
  }
  out = out.replace(/\[\[Cross-Area\]\]/g, () => {
    changes.push('[[Cross-Area]] -> [[Area - Cross-Cutting]]');
    return '[[Area - Cross-Cutting]]';
  });
  out = out.replace(/\bCross-Area\b/g, () => {
    changes.push('Cross-Area -> Area - Cross-Cutting');
    return 'Area - Cross-Cutting';
  });
  return { content: out, changes };
}

export function convertRelationshipContent(content: string): { content: string; changes: string[] } {
  let out = String(content ?? '');
  const changes: string[] = [];
  for (const prop of relationshipPropertyNames()) {
    const re = new RegExp(`(^|\\n)(\\s*)${escapeRegExp(prop)}::\\s*([^\\n]+)`, 'gi');
    out = out.replace(re, (_m, nl, indent, rawValue) => {
      const value = String(rawValue ?? '').trim();
      if (!value || value.includes('[[') || value.includes('#') || /^https?:/i.test(value)) {
        return `${nl}${indent}${prop}:: ${rawValue}`;
      }
      const parts = value.split(',').map((x) => x.trim()).filter(Boolean);
      if (!parts.length) return `${nl}${indent}${prop}:: ${rawValue}`;
      const converted = parts.map((x) => `[[${safePageName(x)}]]`).join(', ');
      changes.push(`${prop}:: ${value} -> ${converted}`);
      return `${nl}${indent}${prop}:: ${converted}`;
    });
  }
  return { content: out, changes };
}

async function writeMigrationPlan(
  r: Result,
  title: string,
  lines: string[],
): Promise<void> {
  await ensurePage(r, 'LSS Migrations');
  await appendManagedBlock(
    r,
    'LSS Migrations',
    `${MODE}-migration-plan-${title.replace(/[^a-zA-Z0-9]+/g, '-')}-${tsKey()}`,
    [
      `${title} dry run`,
      `status:: review-required`,
      `dry-run:: true`,
      `generated-at:: ${new Date().toISOString()}`,
      '',
      ...lines,
    ].join('\n'),
  );
}

async function collectCurrentPageChanges(
  r: Result,
  transform: (content: string) => { content: string; changes: string[] },
  label: string,
): Promise<{ page: string; changedBlocks: number; lines: string[] } | null> {
  const page = await currentPageName();
  if (!page) {
    r.errors.push('No current page detected. Open a page and rerun.');
    return null;
  }
  const blocks = walkBlocks(await getBlocks(page));
  let changedBlocks = 0;
  const lines: string[] = [`Scope: [[${safePageName(page)}]]`, ''];
  for (const block of blocks) {
    const before = String(block?.content ?? '');
    const after = transform(before);
    if (after.content !== before) {
      changedBlocks += 1;
      lines.push(`- Block ${changedBlocks}`);
      for (const c of after.changes) lines.push(`  - ${c}`);
    }
  }
  if (!changedBlocks) lines.push('- No candidate changes found.');
  r.notes.push(`${label}: dry run found ${changedBlocks} candidate block(s) on ${page}.`);
  return { page, changedBlocks, lines };
}

export async function normalizeProperties(r: Result): Promise<void> {
  const plan = await collectCurrentPageChanges(r, normalizePropertyContent, 'Normalize properties');
  if (!plan) return;
  await writeMigrationPlan(r, 'Normalize properties', plan.lines);
  r.notes.push('Dry run only. Review the LSS Migrations report before applying any alias normalization manually.');
}

export async function convertTextRelationships(r: Result): Promise<void> {
  const plan = await collectCurrentPageChanges(r, convertRelationshipContent, 'Convert text relationships to node references');
  if (!plan) return;
  await writeMigrationPlan(r, 'Convert text relationships', plan.lines);
  r.notes.push('Dry run only. Relationship conversion needs user review because plain text can be ambiguous.');
}

export async function migrateNamespacedObjects(r: Result): Promise<void> {
  const page = await currentPageName();
  if (!page) {
    r.errors.push('No current page detected. Open a namespaced object page and rerun.');
    return;
  }
  const candidates = allObjects().filter((o) => String(o.nodeKind ?? '').includes('page'));
  const match = candidates.find(
    (o) =>
      page.startsWith(`${o.name}/`) ||
      page.startsWith(`${safeTag(o.tag)}/`) ||
      page.startsWith(`${o.name} - `) ||
      page.startsWith(`${safeTag(o.tag)} - `),
  );
  if (!match) {
    r.notes.push(`No namespaced object pattern detected for current page: ${page}.`);
    return;
  }
  const prefixes = [`${match.name}/`, `${safeTag(match.tag)}/`, `${match.name} - `, `${safeTag(match.tag)} - `];
  let target = page;
  for (const prefix of prefixes) {
    if (target.startsWith(prefix)) target = target.slice(prefix.length);
  }
  target = target.trim();
  if (!target) {
    r.errors.push(`Could not compute clean target page for ${page}.`);
    return;
  }
  const lines = [
    `Scope: [[${safePageName(page)}]]`,
    '',
    `- Candidate rename: [[${safePageName(page)}]] -> [[${safePageName(target)}]]`,
    `- Candidate tag: #${safeTag(match.tag)}`,
    `- Object type: ${match.name}`,
    '- Required preflight before apply:',
    `  - Confirm [[${safePageName(target)}]] does not already exist with conflicting content.`,
    '  - Confirm backlinks and aliases should be preserved.',
    '  - Confirm the target tag is correct.',
  ];
  await writeMigrationPlan(
    r,
    'Migrate namespaced object',
    lines,
  );
  r.notes.push(`Dry run only. Computed clean page target: ${target} #${safeTag(match.tag)}.`);
}
