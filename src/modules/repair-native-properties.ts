import {
  canonicalPropertyKey,
  ensureNativeProperty,
  nativePropertyResetReasonForSpec,
} from '../core/db-properties';
import type { Result } from '../core/types';
import { propertySpec } from '../registry';
import type { RegistryObject } from '../registry/types';
import { resetNativeNodeProperty } from './setup';
import { uniqueObjectProps } from './templates';

const nativeEnsureCache = new Set<string>();

async function ensureCachedNativeProperty(result: Result, key: string): Promise<void> {
  const shortKey = canonicalPropertyKey(key);
  if (!shortKey || nativeEnsureCache.has(shortKey)) return;
  const spec = propertySpec(shortKey);
  if (!spec) return;
  const resetReason = await nativePropertyResetReasonForSpec(spec);
  if (resetReason) {
    result.notes.push(`Native property ${shortKey}: stale schema detected (${resetReason}).`);
    result.notes.push(`Materialise detected stale native ${shortKey} schema; resetting before page property writes.`);
    await resetNativeNodeProperty(result, shortKey);
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
