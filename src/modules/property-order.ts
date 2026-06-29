import { canonicalPropertyKey } from '../core/db-properties';
import { safeTag } from '../core/names';
import { normalizeAreaRef, propertySpec, registry } from '../registry';
import type { RegistryObject } from '../registry/types';

const AREA_PROPERTIES = new Set(['area', 'areas']);
const STATUS_PROPERTIES = new Set(['status']);

function propertyTargets(property: string): string[] {
  const spec = propertySpec(property) as { targets?: unknown[]; type?: unknown } | undefined;
  if (String(spec?.type ?? '').toLowerCase() !== 'node') return [];
  return (spec?.targets ?? []).map((target) => safeTag(String(target))).filter(Boolean);
}

function areaRelationRank(property: string, object?: RegistryObject): number | null {
  const targets = new Set(propertyTargets(property));
  if (!targets.size) return null;
  const objectArea = object ? normalizeAreaRef(object.area) : '';
  for (let index = 0; index < (registry.entityTypes ?? []).length; index++) {
    const target = registry.entityTypes![index];
    const targetTag = safeTag(target.tag || target.name);
    if (!targets.has(targetTag)) continue;
    if (objectArea && normalizeAreaRef(target.area) !== objectArea) continue;
    if (!objectArea && !property.startsWith('related-')) continue;
    return index;
  }
  return null;
}

function pagePropertyOrderRank(property: string, object?: RegistryObject): [number, number] {
  const clean = canonicalPropertyKey(property);
  if (clean === 'lss-object-type') return [0, 0];
  if (AREA_PROPERTIES.has(clean)) return [1, clean === 'area' ? 0 : 1];
  const relationRank = areaRelationRank(clean, object);
  if (relationRank != null) return [2, relationRank];
  if (clean.startsWith('related-') && clean !== 'related-to') return [2, 10000];
  if (clean === 'related-to') return [3, 0];
  if (STATUS_PROPERTIES.has(clean)) return [5, 0];
  return [4, 0];
}

export function orderedPagePropertyNames(properties: Iterable<string>, object?: RegistryObject): string[] {
  const seen = new Set<string>();
  const indexed: Array<{ property: string; index: number; rank: [number, number] }> = [];
  for (const property of properties) {
    const clean = canonicalPropertyKey(property);
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    indexed.push({ property: clean, index: indexed.length, rank: pagePropertyOrderRank(clean, object) });
  }
  return indexed
    .sort((a, b) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1] || a.index - b.index)
    .map((item) => item.property);
}

export function pagePropertyComesBeforeRelatedTo(property: string, object?: RegistryObject): boolean {
  const clean = canonicalPropertyKey(property);
  if (!clean || clean === 'related-to') return false;
  return pagePropertyOrderRank(clean, object)[0] < pagePropertyOrderRank('related-to', object)[0];
}
