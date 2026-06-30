import { canonicalPropertyKey } from '../core/db-properties';
import { safePageName, visiblePageLabel } from '../core/names';
import type { Result } from '../core/types';
import { propertySpec } from '../registry';
import { relationshipPropertyNames } from './queries';
import { isPlaceholderNodeDefault } from './repair-user-properties';

const RELATIONSHIP_PROPERTIES = new Set(relationshipPropertyNames());

const RELATED_TO_ARTIFACT_NAMES = new Set([
  'tag',
  'tags',
  'page',
  'pages',
  'block',
  'blocks',
  'property',
  'properties',
  'template',
  'query',
  'status',
  'area',
  'areas',
  'owner',
  'lss-object-type',
  'lss-object-tag',
]);

function pageRefsFromValue(value: string): string[] {
  const refs: string[] = [];
  const re = /\[\[([^\]]+)\]\]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(String(value ?? '')))) {
    if (match[1]) refs.push(visiblePageLabel(match[1]).trim());
  }
  return refs.filter(Boolean);
}

function relationshipNamesFromValue(value: string): string[] {
  const text = String(value ?? '').trim();
  if (!text) return [];
  const refs = pageRefsFromValue(text);
  if (refs.length) return refs;
  if (text.includes('#') || /^https?:/i.test(text)) return [];
  return text
    .replace(/^\[+/, '')
    .replace(/\]+$/, '')
    .split(',')
    .map((item) => visiblePageLabel(item.trim().replace(/^"|"$/g, '')))
    .filter(Boolean);
}

function relationshipRefText(value: string): string {
  const label = safePageName(visiblePageLabel(value));
  return label ? `[[${label}]]` : '';
}

function normalizedRelationshipNameKey(value: string): string {
  return safePageName(visiblePageLabel(value)).trim().toLowerCase();
}

function isRelatedToArtifactName(name: string, pageName: string): boolean {
  const label = safePageName(visiblePageLabel(name));
  const lower = label.toLowerCase();
  if (!label) return true;
  if (lower === safePageName(pageName).toLowerCase()) return true;
  if (isPlaceholderNodeDefault(label)) return true;
  if (lower.startsWith('lss placeholder')) return true;
  if (lower.startsWith('area - ') || lower.startsWith('area/')) return true;
  if (RELATED_TO_ARTIFACT_NAMES.has(lower)) return true;
  const propertyKey = canonicalPropertyKey(label);
  return Boolean(propertySpec(propertyKey) || RELATIONSHIP_PROPERTIES.has(propertyKey));
}

function collectSpecificRelationshipNames(props: Map<string, string>): Set<string> {
  const names = new Set<string>();
  for (const [key, value] of props.entries()) {
    const shortKey = canonicalPropertyKey(key);
    if (!shortKey || shortKey === 'related-to') continue;
    if (!RELATIONSHIP_PROPERTIES.has(shortKey) && String(propertySpec(shortKey)?.type ?? '').toLowerCase() !== 'node') continue;
    for (const name of relationshipNamesFromValue(value)) {
      const normalized = normalizedRelationshipNameKey(name);
      if (normalized) names.add(normalized);
    }
  }
  return names;
}

export function sanitizeGenericRelatedToForRepair(result: Result, props: Map<string, string>, pageName: string): void {
  const raw = String(props.get('related-to') ?? '').trim();
  if (!raw) return;
  const names = relationshipNamesFromValue(raw);
  if (!names.length) return;
  const specificNames = collectSpecificRelationshipNames(props);
  const kept: string[] = [];
  const removed: string[] = [];
  for (const name of names) {
    const normalized = normalizedRelationshipNameKey(name);
    if (!normalized || isRelatedToArtifactName(name, pageName) || specificNames.has(normalized)) {
      removed.push(name);
    } else {
      kept.push(name);
    }
  }
  if (!removed.length) return;
  props.set('related-to', kept.map(relationshipRefText).filter(Boolean).join(', '));
  result.actions.push(
    `SANITIZED related-to on ${pageName}: removed ${removed.map(relationshipRefText).filter(Boolean).join(', ') || removed.join(', ')}`,
  );
}
