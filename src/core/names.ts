export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function safePageName(name: string): string {
  return String(name ?? '')
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean)
    .join(' - ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function safeRef(name: string): string {
  return `[[${safePageName(name)}]]`;
}

/** Normalize a page name for query refs (Logseq page titles are case-insensitive). */
export function normalizePageRefName(name: string): string {
  return String(name ?? '')
    .replace(/^\[\[/, '')
    .replace(/\]\]$/, '')
    .trim()
    .toLowerCase();
}

function looksLikeDbPageEntityId(raw: string): boolean {
  return /^\d+$/.test(raw) && Number(raw) < 1e9;
}

/** DB venture filters should use numeric page ids (like area:: [465]), not wiki-link casing. */
export function queryPageRef(
  pageName: string,
  page?: { id?: number | string; originalName?: string; name?: string } | null,
): string {
  const pageId = (page as Record<string, unknown> | null)?.id;
  if (pageId != null && looksLikeDbPageEntityId(String(pageId))) return String(pageId);
  const fromPage = page?.originalName ?? page?.name;
  const raw = normalizePageRefName(String(fromPage ?? pageName ?? ''));
  return raw ? `[[${raw}]]` : '[[]]';
}

export function looksLikeUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    String(value ?? '').trim(),
  );
}

export function tagObjectLabel(entity: Record<string, unknown> | null | undefined): string {
  if (!entity) return '';
  return visiblePageLabel(
    String(entity.originalName ?? entity.name ?? entity.title ?? entity.fullTitle ?? entity.content ?? ''),
  );
}

export function visiblePageLabel(name: string): string {
  let raw = String(name ?? '').trim();
  for (let i = 0; i < 5; i++) {
    const wiki = raw.match(/^\[\[([\s\S]*)\]\]$/);
    if (!wiki?.[1]) break;
    raw = wiki[1].trim();
  }
  return raw;
}

export function safeTag(tag: string): string {
  return String(tag ?? '')
    .replace(/^#/, '')
    .replace(/[\s\)\]\}]+$/g, '')
    .replace(/\)+$/g, '')
    .trim();
}

/** Fix (#Tag) prose that Logseq misreads as a phantom #Tag) tag. */
export function fixPhantomTagParenSyntax(content: string): { content: string; changes: string[] } {
  const changes: string[] = [];
  const out = String(content ?? '').replace(/\(#([A-Za-z0-9_-]+)\)/g, (_m, tag) => {
    const clean = safeTag(tag);
    changes.push(`(#${clean}) -> · #${clean}`);
    return `· #${clean}`;
  });
  return { content: out, changes };
}

export function safeMarkdownRefs(markdown: string): string {
  return String(markdown ?? '').replace(/\[\[([^\]]+)\]\]/g, (_m, name) => `[[${safePageName(name)}]]`);
}

export function pageForCanonical(canonical: string): string {
  return safePageName(canonical);
}

export function tsKey(): string {
  return new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
}

export function todayRef(): string {
  return `[[${new Date().toISOString().slice(0, 10)}]]`;
}

export function escapeRegExp(s: string): string {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
