import {
  canonicalPropertyKey,
  ensureNativeProperty,
  nativePropertyResetReasonForSpec,
  pluginPropertyIdent,
} from '../core/db-properties';
import { formatError, sleep } from '../core/runner';
import type { Result } from '../core/types';
import { propertySpec } from '../registry';
import type { RegistryObject } from '../registry/types';
import { uniqueObjectProps } from './templates';

const nativeEnsureCache = new Set<string>();

type CapturedNativeNodeValue = {
  entity: number;
  value: number;
  title: string;
};

async function captureNativeNodeValues(shortKey: string): Promise<CapturedNativeNodeValue[]> {
  if (!logseq.DB?.datascriptQuery) return [];
  const attr = pluginPropertyIdent(shortKey);
  const rows = await logseq.DB.datascriptQuery(
    `[:find ?entity ?value ?title ?name
 :where
 [?entity ${attr} ?value]
 [(get-else $ ?value :block/title "") ?title]
 [(get-else $ ?value :block/name "") ?name]]`,
  );
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row) => {
      const entity = Number(row?.[0]);
      const value = Number(row?.[1]);
      const title = String(row?.[2] || row?.[3] || '').trim();
      return Number.isFinite(entity) && Number.isFinite(value) ? { entity, value, title } : null;
    })
    .filter((row): row is CapturedNativeNodeValue => Boolean(row));
}

async function repairStaleNativeNodeProperty(result: Result, shortKey: string): Promise<boolean> {
  const spec = propertySpec(shortKey);
  if (!spec || String(spec.type ?? '').toLowerCase() !== 'node') return false;
  if (!logseq.Editor.removeBlockProperty || !logseq.Editor.upsertBlockProperty) {
    result.notes.push(`Native property ${shortKey}: stale schema repair skipped; property write APIs unavailable.`);
    return false;
  }
  const captured = await captureNativeNodeValues(shortKey);
  const valid = captured.filter((item) => item.title);
  for (const entity of [...new Set(captured.map((item) => item.entity))]) {
    try {
      await logseq.Editor.removeBlockProperty(entity, shortKey);
    } catch (error) {
      result.errors.push(`Native property ${shortKey}: failed clearing stale value on ${entity}: ${formatError(error)}`);
      return false;
    }
  }
  await sleep(25);
  const remaining = await captureNativeNodeValues(shortKey);
  if (remaining.length) {
    result.errors.push(`Native property ${shortKey}: stale schema repair aborted; ${remaining.length} value(s) still remain after clearing.`);
    return false;
  }
  const ensured = await ensureNativeProperty(spec, { refreshExistingSchema: true });
  if (!ensured || ensured.skipped) {
    result.errors.push(`Native property ${shortKey}: stale schema repair could not refresh schema${ensured?.note ? `: ${ensured.note}` : ''}.`);
    return false;
  }
  const byEntity = new Map<number, number[]>();
  for (const item of valid) byEntity.set(item.entity, [...(byEntity.get(item.entity) ?? []), item.value]);
  const many = String((spec as { cardinality?: string }).cardinality ?? '').toLowerCase() === 'many';
  for (const [entity, values] of byEntity.entries()) {
    const unique = [...new Set(values)];
    await logseq.Editor.upsertBlockProperty(entity, shortKey, many ? unique : unique[0], { reset: true });
  }
  result.actions.push(
    `REPAIRED stale native node property ${shortKey}: restored ${valid.length}/${captured.length} page value(s), dropped ${captured.length - valid.length} invalid value(s).`,
  );
  return true;
}

async function ensureCachedNativeProperty(result: Result, key: string): Promise<void> {
  const shortKey = canonicalPropertyKey(key);
  if (!shortKey || nativeEnsureCache.has(shortKey)) return;
  const spec = propertySpec(shortKey);
  if (!spec) return;
  const resetReason = await nativePropertyResetReasonForSpec(spec);
  if (resetReason) {
    if (String(spec.type ?? '').toLowerCase() === 'node' && (await repairStaleNativeNodeProperty(result, shortKey))) {
      nativeEnsureCache.add(shortKey);
      return;
    }
    result.notes.push(
      `Native property ${shortKey}: stale schema detected (${resetReason}); auto/materialise left schema unchanged. Re-run setup after clearing stale values when ready for an explicit maintenance pass.`,
    );
    nativeEnsureCache.add(shortKey);
    return;
  }
  const ensured = await ensureNativeProperty(spec, { refreshExistingSchema: false });
  if (ensured?.created) result.actions.push(`ENSURE native property for materialise: ${shortKey}`);
  else if (ensured?.note) result.notes.push(`Native property ${shortKey}: ${ensured.note}`);
  nativeEnsureCache.add(shortKey);
}

export async function ensureMaterialiseNativeProperties(result: Result, obj: RegistryObject): Promise<void> {
  for (const key of uniqueObjectProps(obj)) await ensureCachedNativeProperty(result, key);
  const lssObjectTypeKey = 'lss-object-type';
  if (!nativeEnsureCache.has(lssObjectTypeKey)) {
    await ensureNativeProperty({ name: lssObjectTypeKey, type: 'default', cardinality: 'one' }, { refreshExistingSchema: false });
    nativeEnsureCache.add(lssObjectTypeKey);
  }
}
