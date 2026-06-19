import { MODE, THROTTLE_MS } from '../config';
import {
  appendManagedBlock,
  currentPageName,
  ensurePage,
  getBlocks,
  updateBlockContent,
  walkBlocks,
} from '../core/editor';
import { escapeRegExp, fixPhantomTagParenSyntax, safePageName, safeTag, tsKey } from '../core/names';
import { formatError, sleep } from '../core/runner';
import type { Result } from '../core/types';
import { allObjects, registry } from '../registry';
import { relationshipPropertyNames } from './queries';
import { repairCurrentPage } from './repair';

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

async function updateCurrentPageBlocks(
  r: Result,
  transform: (content: string) => { content: string; changes: string[] },
  label: string,
): Promise<void> {
  const page = await currentPageName();
  if (!page) {
    r.errors.push('No current page detected. Open a page and rerun.');
    return;
  }
  const blocks = walkBlocks(await getBlocks(page));
  let changedBlocks = 0;
  for (const block of blocks) {
    const before = String(block?.content ?? '');
    const after = transform(before);
    if (after.content !== before) {
      changedBlocks += 1;
      await updateBlockContent(r, block, after.content, `${label} on ${page}`);
      for (const c of after.changes.slice(0, 8)) r.notes.push(c);
    }
  }
  r.notes.push(`${label}: changed ${changedBlocks} block(s) on ${page}.`);
}

export async function normalizeProperties(r: Result): Promise<void> {
  await updateCurrentPageBlocks(r, normalizePropertyContent, 'Normalize properties');
  await repairCurrentPage(r);
}

export async function convertTextRelationships(r: Result): Promise<void> {
  await updateCurrentPageBlocks(r, convertRelationshipContent, 'Convert text relationships to node references');
  await repairCurrentPage(r);
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
  r.notes.push(`Computed clean page target: ${target} #${safeTag(match.tag)}.`);
  try {
    if (logseq.Editor.renamePage) {
      await logseq.Editor.renamePage(page, target);
      r.actions.push(`RENAME page: ${page} -> ${target}`);
      await sleep(THROTTLE_MS);
    } else {
      r.notes.push('renamePage API not available; writing migration note only.');
    }
  } catch (e) {
    r.errors.push(`rename-page ${page}->${target}: ${formatError(e)}`);
  }
  await ensurePage(r, target, {
    'lss-object-type': match.name,
    'lss-object-tag': `#${safeTag(match.tag)}`,
  });
  await appendManagedBlock(
    r,
    target,
    `${MODE}-migration-note-${tsKey()}`,
    [
      'Migration note',
      `from:: [[${safePageName(page)}]]`,
      `target-tag:: #${safeTag(match.tag)}`,
      'status:: review-required',
    ].join('\n'),
  );
}