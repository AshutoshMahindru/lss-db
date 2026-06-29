import { getBlocks, getPage, resolvePageFromIdentity } from '../core/editor';
import { safePageName, safeTag, visiblePageLabel } from '../core/names';

export function isProtectedMaterialisePage(pageName: string, props: Map<string, string> = new Map()): boolean {
  const label = safePageName(visiblePageLabel(pageName));
  if (!label) return true;
  if (props.has('lss-kind') || props.has(':plugin.property.logseq-lss-db-final-plugin/lss-kind')) return true;
  if (/^(NATIVE SECTIONS|RELATED ENTITIES|GENERIC ENTITIES|FORMS|REVIEWS|DATES)$/i.test(label)) return true;
  if (/^(LSS(?:\b| - )|Entity-Page|DB Tag|Tag Properties|Template|Dashboard|Word Extender|LSS Reports|Area|Relationship|Property Reference|Tag Reference)(?:\b| - |:)/i.test(label)) return true;
  return /Entity Schema Page|Naming Rule|Template Reference|Tag Properties:|^LSS Placeholder(?:\b| - )/i.test(label);
}

function addRepairPageCandidate(out: unknown[], value: unknown): void {
  const raw = String(value ?? '').trim();
  if (!raw) return;
  const decoded = decodeURIComponent(raw).trim();
  const pageRouteMatch = decoded.match(/\/page\/([^/?#&]+)/i);
  if (pageRouteMatch?.[1]) addRepairPageCandidate(out, pageRouteMatch[1]);
  const namedPageMatch = decoded.match(/[?&](?:page|name)=([^&#]+)/i);
  if (namedPageMatch?.[1]) addRepairPageCandidate(out, namedPageMatch[1]);
  out.push(raw);
  out.push(safePageName(raw));
  out.push(safeTag(raw));
  out.push(raw.toLowerCase());
  out.push(safePageName(raw).toLowerCase());
}

export function repairPageCandidates(pageName: string, page?: any): Array<string | number> {
  const out: unknown[] = [];
  addRepairPageCandidate(out, pageName);
  for (const value of [
    page?.id,
    page?.uuid,
    page?.name,
    page?.originalName,
    page?.title,
    page?.fullTitle,
    page?.[':db/id'],
    page?.['db/id'],
    page?.[':block/uuid'],
    page?.['block/uuid'],
    page?.[':block/name'],
    page?.['block/name'],
    page?.[':block/original-name'],
    page?.['block/original-name'],
    page?.[':block/title'],
    page?.['block/title'],
  ]) {
    addRepairPageCandidate(out, value);
  }
  const seen = new Set<string>();
  const candidates: Array<string | number> = [];
  for (const value of out) {
    const raw = String(value ?? '').trim();
    if (!raw || seen.has(raw)) continue;
    seen.add(raw);
    candidates.push(/^\d+$/.test(raw) ? Number(raw) : raw);
  }
  return candidates;
}

export async function resolveRepairPage(pageName: string): Promise<any | null> {
  for (const candidate of repairPageCandidates(pageName)) {
    const page =
      (await resolvePageFromIdentity(candidate).catch(() => null)) ||
      (typeof candidate === 'string' ? await getPage(candidate) : null);
    if (page) return page;
  }
  return null;
}

export async function readRepairPageBlocks(pageName: string, page: any): Promise<any[]> {
  for (const candidate of repairPageCandidates(pageName, page)) {
    const blocks = await getBlocks(candidate);
    if (!blocks?.length) continue;
    return blocks;
  }
  return [];
}
