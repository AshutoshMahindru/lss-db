import { currentPageName, getBlocks, insertAtCursor } from '../core/editor';
import { todayRef } from '../core/names';
import { formatError, sleep } from '../core/runner';
import type { Result } from '../core/types';
import { registry } from '../registry';
import { viewsForDashboardKind } from './queries';
import { repairDashboardQueries } from './repair';
import { scheduleAutoRepair } from './auto-repair';

export function dashboardBody(kind: string): string {
  const definition = (registry.dashboardDefinitions ?? []).find((d) =>
    String(d.page ?? '').toLowerCase().includes(String(kind).toLowerCase()),
  );
  const sections = (definition?.sections ?? ['Projects', 'Action-Items', 'Decisions', 'Interactions', 'Documents', 'Files']).map(
    (s: string | { title?: string; id?: string }) => (typeof s === 'string' ? s : s.title ?? s.id ?? 'Section'),
  );
  const views = viewsForDashboardKind(kind);
  const viewBySection = new Map<string, (typeof views)[number]>();
  for (const view of views) {
    const section = String(view.section ?? '').trim();
    if (section && !viewBySection.has(section)) viewBySection.set(section, view);
  }

  const lines = [`- LSS ${kind} Dashboard`, `  dashboard-type:: ${kind}`, `  generated-on:: ${todayRef()}`];
  for (const section of sections) {
    lines.push(`  - ${section}`);
    const view = viewBySection.get(section);
    // Do not embed query expressions here. On DB graphs the correct form is a native advanced
    // query block (configured via host script + :title in EDN). Post-insert setup installs working queries.
    if (!view) {
      lines.push(`    - Query intent: show ${section} related to the current page.`);
    }
    // queries added under section by setup/repair with proper title from view.section
  }
  return lines.join('\n');
}

export async function insertDashboard(r: Result, kind: string): Promise<void> {
  await insertAtCursor(r, dashboardBody(kind), `${kind} dashboard`);
  // Proactively install working advanced query blocks for DB graphs.
  // Uses tag-based clauses + proper #Query + :code child structure.
  // Multiple attempts + auto-repair backup means manual lss:50 is rarely required.
  try {
    await sleep(150);
    const pageName = await currentPageName();
    if (pageName) {
      let blocks = await getBlocks(pageName);
      let installed = await repairDashboardQueries(r, pageName, blocks ?? [], kind);
      // Extra attempts for stubborn DB query child cases (display-type :code etc.)
      for (let attempt = 1; attempt <= 2 && installed === 0; attempt++) {
        await sleep(200);
        blocks = await getBlocks(pageName);
        installed = await repairDashboardQueries(r, pageName, blocks ?? [], kind);
        if (installed > 0) break;
      }
      // Schedule auto-repair as final safety net
      if (installed === 0) {
        try { scheduleAutoRepair(pageName); } catch {}
      }
    }
  } catch (e) {
    r.notes.push(`post-insert dashboard query setup skipped: ${formatError(e)}`);
  }
}

export async function insertVentureDashboard(r: Result): Promise<void> {
  await insertDashboard(r, 'Venture');
}

export async function insertProjectDashboard(r: Result): Promise<void> {
  await insertDashboard(r, 'Project');
}

export async function insertAreaDashboard(r: Result): Promise<void> {
  await insertDashboard(r, 'Area');
}