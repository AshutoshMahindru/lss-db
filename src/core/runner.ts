import { MAX_REPORT_LINES, MODE } from '../config';
import { ensurePage } from './editor';
import { pageForCanonical } from '../registry';
import type { Result } from './types';

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    if (typeof record.message === 'string' && record.message.trim()) return record.message;
    if (typeof record.error === 'string' && record.error.trim()) return record.error;
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error);
}

export function newResult(command: string): Result {
  return { command, startedAt: new Date().toISOString(), actions: [], errors: [], notes: [] };
}

export async function writeReport(result: Result): Promise<void> {
  result.finishedAt = new Date().toISOString();
  const status = result.errors.length ? 'partial' : 'ok';
  const page = pageForCanonical(
    `LSS Reports/${result.command.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '')}`,
  );
  const lines: string[] = [];
  lines.push(`# ${result.command}`);
  lines.push('');
  lines.push(`status:: ${status}`);
  lines.push(`mode:: ${MODE}`);
  lines.push(`started-at:: ${result.startedAt}`);
  lines.push(`finished-at:: ${result.finishedAt}`);
  lines.push('');
  lines.push('## Notes');
  if (!result.notes.length) lines.push('- None');
  for (const n of result.notes) lines.push(`- ${n}`);
  lines.push('');
  lines.push('## Actions');
  const actions = result.actions.slice(0, MAX_REPORT_LINES);
  if (!actions.length) lines.push('- None');
  for (const a of actions) lines.push(`- ${a}`);
  if (result.actions.length > MAX_REPORT_LINES) {
    lines.push(`- ... ${result.actions.length - MAX_REPORT_LINES} more actions omitted from report page`);
  }
  lines.push('');
  lines.push('## Errors');
  if (!result.errors.length) lines.push('- None');
  for (const e of result.errors) lines.push(`- ${e}`);
  try {
    await ensurePage(result, 'LSS Reports');
    await ensurePage(result, page);
    await logseq.Editor.appendBlockInPage(page, lines.join('\n'));
  } catch (e) {
    console.error('[LSS] failed to write report', e);
  }
  logseq.UI.showMsg(
    `${result.command}: ${status}. Actions ${result.actions.length}. Errors ${result.errors.length}.`,
    result.errors.length ? 'warning' : 'success',
  );
}

export async function run(command: string, fn: (r: Result) => Promise<void>): Promise<void> {
  const result = newResult(command);
  try {
    await fn(result);
  } catch (e) {
    result.errors.push(formatError(e));
  }
  await writeReport(result);
}