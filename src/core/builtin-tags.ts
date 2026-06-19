import { safeTag } from './names';

/** Logseq DB reserved class tags — must not be created via Editor.createTag. */
const LOGSEQ_BUILTIN_TAGS = new Set(
  [
    'Tag',
    'Template',
    'Task',
    'Query',
    'Asset',
    'Page',
    'Block',
    'Property',
    'Class',
    'Todo',
    'Doing',
    'Done',
    'Canceled',
    'Cancelled',
  ].map((tag) => safeTag(tag).toLowerCase()),
);

export function isLogseqBuiltinTag(tag: string): boolean {
  const clean = safeTag(tag).toLowerCase();
  return clean ? LOGSEQ_BUILTIN_TAGS.has(clean) : false;
}