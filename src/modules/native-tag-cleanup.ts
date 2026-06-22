import { MODE } from '../config';
import { entityIdentity } from '../core/db-properties';
import { safeTag } from '../core/names';
import { formatError, sleep } from '../core/runner';
import type { Result } from '../core/types';
import { allObjects } from '../registry';
import { readNativeTagSchemaFindings, type NativeTagSchemaFinding } from './diagnose-native-tags';
import { uniqueObjectProps } from './templates';

type CleanupTarget = {
  tag: string;
  objectTypes: string[];
  properties: string[];
};

function cleanupTargets(): CleanupTarget[] {
  const byTag = new Map<string, { objectTypes: Set<string>; properties: Set<string> }>();
  for (const object of allObjects()) {
    const tag = safeTag(object.tag);
    if (!tag) continue;
    const entry = byTag.get(tag) ?? { objectTypes: new Set<string>(), properties: new Set<string>() };
    entry.objectTypes.add(object.name);
    for (const prop of [...uniqueObjectProps(object), 'lss-object-type', 'lss-object-tag']) {
      if (prop) entry.properties.add(prop);
    }
    byTag.set(tag, entry);
  }
  return [...byTag.entries()]
    .map(([tag, entry]) => ({
      tag,
      objectTypes: [...entry.objectTypes].sort((a, b) => a.localeCompare(b)),
      properties: [...entry.properties].sort((a, b) => a.localeCompare(b)),
    }))
    .sort((a, b) => a.tag.localeCompare(b.tag));
}

async function resolveTagIdentity(tag: string): Promise<string | number | null> {
  const primary = logseq.Editor.getTag ? await logseq.Editor.getTag(tag).catch(() => null) : null;
  if (primary) return entityIdentity(primary);
  if (logseq.Editor.getTagsByName) {
    const matches = await logseq.Editor.getTagsByName(tag).catch(() => null);
    for (const match of matches ?? []) {
      const identity = entityIdentity(match);
      if (identity != null) return identity;
    }
  }
  return null;
}

function findingSummary(findings: NativeTagSchemaFinding[]): string {
  if (!findings.length) return 'none';
  return findings
    .slice(0, 12)
    .map((finding) => `#${finding.tag}: ${finding.properties.join(', ')}`)
    .join('; ');
}

function isMissingPropertyError(message: string): boolean {
  return /not found|missing|does not exist|not .*property/i.test(message);
}

export async function cleanNativeTagSchemaProperties(result: Result): Promise<void> {
  if (MODE !== 'db') {
    result.notes.push('Native tag schema cleanup applies only to DB graphs.');
    return;
  }
  if (!logseq.Editor.removeTagProperty) {
    result.errors.push('removeTagProperty API unavailable; cannot clean native tag schema properties.');
    return;
  }

  const before = await readNativeTagSchemaFindings();
  if (!before.available) {
    result.notes.push('Native tag schema inspection unavailable before cleanup; cleanup will still remove known registry schema properties.');
  } else {
    result.notes.push(`Native tag schema pollution before cleanup: ${before.findings.length} tag(s).`);
    if (before.findings.length) result.notes.push(`Polluted tags before cleanup: ${findingSummary(before.findings)}.`);
  }

  let tagsScanned = 0;
  let missingTags = 0;
  let removeCalls = 0;
  let alreadyMissing = 0;
  let failures = 0;

  for (const target of cleanupTargets()) {
    const tagIdentity = await resolveTagIdentity(target.tag);
    if (tagIdentity == null) {
      missingTags++;
      continue;
    }
    tagsScanned++;
    for (const prop of target.properties) {
      try {
        await logseq.Editor.removeTagProperty(tagIdentity, prop);
        removeCalls++;
        await sleep(10);
      } catch (error) {
        const message = formatError(error);
        if (isMissingPropertyError(message)) {
          alreadyMissing++;
          continue;
        }
        failures++;
        result.errors.push(`native tag cleanup #${target.tag}.${prop}: ${message}`);
      }
    }
  }

  result.actions.push(
    `CLEAN native tag schema properties: scanned ${tagsScanned} tag(s), ${removeCalls} remove call(s) succeeded, ${alreadyMissing} already absent, ${missingTags} tag(s) missing, ${failures} failure(s).`,
  );

  const after = await readNativeTagSchemaFindings();
  if (!after.available) {
    result.notes.push('Native tag schema inspection unavailable after cleanup; rerun lss:51 on a DB graph to inspect.');
    return;
  }
  if (!after.findings.length) {
    result.actions.push('VERIFY native tag schema cleanup: no inspected LSS native tags expose registry schema properties.');
  } else {
    result.notes.push(`Native tag schema pollution after cleanup: ${after.findings.length} tag(s).`);
    result.notes.push(`Remaining polluted tags: ${findingSummary(after.findings)}.`);
  }
}
