import { MAX_REPORT_LINES, MODE, VERSION } from '../config';
import { appendBlockInPageVerified, ensureExactPage, ensurePage } from './editor';
import type { CommandContext, Result } from './types';

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

function reportPageForCommand(command: string): { slug: string; page: string } {
  const slug = command.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '');
  return { slug, page: `LSS Reports/${slug}` };
}

export async function writeReport(result: Result): Promise<void> {
  result.finishedAt = new Date().toISOString();
  const { slug, page } = reportPageForCommand(result.command);
  const reportId = `lss-report:${slug}:${result.startedAt}`;
  const initialStatus = result.errors.length ? 'partial' : 'ok';
  const lines: string[] = [];
  lines.push(`# ${result.command}`);
  lines.push('');
  lines.push(`report-id:: ${reportId}`);
  lines.push(`status:: ${initialStatus}`);
  lines.push(`mode:: ${MODE}`);
  lines.push(`plugin-version:: ${VERSION}`);
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
  let reportWritten = false;
  let reportWriteError = '';
  try {
    await ensurePage(result, 'LSS Reports');
    await ensureExactPage(result, page);
    const beforeErrorCount = result.errors.length;
    reportWritten = await appendBlockInPageVerified(result, page, lines.join('\n'), page, reportId);
    reportWriteError = result.errors.slice(beforeErrorCount).join('; ');
  } catch (e) {
    reportWriteError = formatError(e);
    result.errors.push(`write-report ${page}: ${reportWriteError}`);
    console.error('[LSS] failed to write report', e);
  }
  const status = result.errors.length ? 'partial' : 'ok';
  const reportText = reportWritten ? ` Report: ${page}.` : ` Report write failed: ${reportWriteError || page}.`;
  logseq.UI.showMsg(
    `${result.command}: ${status}. Actions ${result.actions.length}. Errors ${result.errors.length}.${reportText}`,
    result.errors.length || !reportWritten ? 'warning' : 'success',
    { timeout: result.errors.length || !reportWritten ? 8000 : 4000 },
  );
}

async function runWithTimeout(
  fn: (r: Result, context?: CommandContext) => Promise<void>,
  result: Result,
  context?: CommandContext,
): Promise<void> {
  const command = String(result.command ?? '');
  const timeoutMs =
    command === 'lss: materialise page'
      ? 90000
      : /(?:^lss:\s*1setup-all$|initialize schema|setup-all)/i.test(command)
        ? 600000
        : 180000;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      fn(result, context),
      new Promise<void>((resolve) => {
        timeoutId = setTimeout(() => {
          result.errors.push(`Command timed out after ${Math.round(timeoutMs / 1000)}s before completion.`);
          resolve();
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

export async function run(
  command: string,
  fn: (r: Result, context?: CommandContext) => Promise<void>,
  context?: CommandContext,
): Promise<void> {
  const result = newResult(command);
  if (command === 'lss: materialise page') {
    await logseq.UI.showMsg(`lss: materialise page invoked v${VERSION}`, 'info', { timeout: 2500 }).catch(() => null);
  }
  try {
    await runWithTimeout(fn, result, context);
  } catch (e) {
    result.errors.push(formatError(e));
  }
  await writeReport(result);
}
