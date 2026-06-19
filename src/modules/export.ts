import { MODE } from '../config';
import {
  appendManagedBlock,
  currentPageName,
  ensurePage,
  flattenBlockText,
  getBlocks,
  insertAtCursor,
} from '../core/editor';
import { safePageName, todayRef, tsKey } from '../core/names';
import type { Result } from '../core/types';

export async function exportCurrentPageReport(r: Result): Promise<void> {
  const page = await currentPageName();
  if (!page) {
    r.errors.push('No current page detected. Open a page and rerun.');
    return;
  }
  const blocks = await getBlocks(page);
  const text = flattenBlockText(blocks);
  const exportPage = `LSS Export - ${safePageName(page)} - ${tsKey()}`;
  await ensurePage(r, exportPage, { 'source-page': page, 'exported-at': new Date().toISOString() });
  await appendManagedBlock(
    r,
    exportPage,
    `${MODE}-export-${tsKey()}`,
    ['Export of ' + page, '', '```markdown', text || '(No blocks found)', '```'].join('\n'),
  );
}

export async function snapshotDashboard(r: Result): Promise<void> {
  const page = await currentPageName();
  if (!page) {
    r.errors.push('No current page detected. Open a dashboard/page and rerun.');
    return;
  }
  const text = flattenBlockText(await getBlocks(page));
  const snap = `LSS Snapshot - ${safePageName(page)} - ${tsKey()}`;
  await ensurePage(r, snap, { 'snapshot-source': page, 'snapshot-at': new Date().toISOString() });
  await appendManagedBlock(r, snap, `${MODE}-snapshot-${tsKey()}`, [`Snapshot of ${page}`, '', text || '(No blocks found)'].join('\n'));
}

export async function generateWeeklyReview(r: Result): Promise<void> {
  const title = `Weekly Review - ${new Date().toISOString().slice(0, 10)}`;
  await ensurePage(r, title, { 'lss-object-type': 'WeeklyReview', 'lss-object-tag': '#WeeklyReview' });
  const body = [
    `${title} #WeeklyReview`,
    `review-period:: week`,
    `review-date:: ${todayRef()}`,
    'status:: draft',
    '',
    'Highlights:',
    '- ',
    'Open loops:',
    '- ',
    'Decisions:',
    '- ',
    'Action Items:',
    '- ',
    'Risks / blockers:',
    '- ',
    'Next week focus:',
    '- ',
  ].join('\n');
  await appendManagedBlock(r, title, `${MODE}-weekly-review-${tsKey()}`, body);
}

export async function expandAbbreviation(r: Result): Promise<void> {
  const body = ['related-project:: ', 'venture:: ', 'owner:: ', 'status:: active', 'review-date:: '].join('\n');
  await insertAtCursor(r, body, 'common LSS abbreviation expansion');
  r.notes.push(
    'Inserted common LSS property expansion. Full abbreviation detection should be handled after stable editor-state access is confirmed.',
  );
}