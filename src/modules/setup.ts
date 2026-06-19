import { MODE } from '../config';
import {
  ensureNativeProperty,
  entityIdentity,
  isPluginPropertyOwnershipError,
} from '../core/db-properties';
import {
  appendManagedBlock,
  ensurePage,
  getPage,
} from '../core/editor';
import { formatError, sleep } from '../core/runner';
import { safeTag } from '../core/names';
import type { Result } from '../core/types';
import {
  allObjects,
  allTags,
  nativeDbClassTags,
  layerPages,
  pageForCanonical,
  registry,
  rootPages,
} from '../registry';
import {
  areaContract,
  dashboardContract,
  objectContract,
  pageTreeText,
  relationshipContract,
  starterWordEntries,
  tagContract,
  tagPropertiesContract,
  templateReference,
  wordEntryContract,
} from './contracts';
import { installLegacyTemplates, installNativeTemplates } from './templates';

async function checkPage(missing: string[], canonical: string): Promise<void> {
  const p = pageForCanonical(canonical);
  if (!(await getPage(p))) missing.push(p);
}

export async function step1(r: Result): Promise<void> {
  for (const page of rootPages()) await ensurePage(r, page);
  for (const p of layerPages()) await ensurePage(r, p);
  await appendManagedBlock(r, 'Home', `${MODE}-home-index-v1`, [
    `LSS ${MODE.toUpperCase()} Final Command Center`,
    `Run commands in order: lss: 1setup-all through lss: 13verify-schema.`,
    'This page uses flat-safe scaffold page names to avoid namespace-parent failures.',
    '',
    'Core roots:',
    ...rootPages().map((p) => `- ${pageForCanonical(p)}`),
    '',
    'Layer pages:',
    ...layerPages().map((p) => `- ${p}`),
  ].join('\n'));
  await appendManagedBlock(r, 'LSS Schema', `${MODE}-schema-index-v1`, [
    `LSS ${MODE.toUpperCase()} schema registry`,
    `schema-version:: ${registry.schemaVersion}`,
    `areas:: ${(registry.areas ?? []).length}`,
    `entities:: ${(registry.entityTypes ?? []).length}`,
    `forms:: ${(registry.formTypes ?? []).length}`,
    `word-extender-types:: ${(registry.wordExtenderTypes ?? []).length}`,
    `properties:: ${(registry.propertyRegistry ?? []).length}`,
    `relationships:: ${(registry.relationshipRegistry ?? []).length}`,
    `templates:: ${(registry.templates ?? []).length}`,
  ].join('\n'));
}

export async function step2(r: Result): Promise<void> {
  for (const a of registry.areas ?? []) {
    await ensurePage(r, a.page, { status: 'active', description: a.description });
    await appendManagedBlock(r, a.page, `${MODE}-area-v2-${a.name}`, areaContract(a));
  }
}

export async function step3(r: Result): Promise<void> {
  for (const o of registry.entityTypes ?? []) {
    await ensurePage(r, o.schemaPage);
    await appendManagedBlock(r, o.schemaPage, `${MODE}-schema-${o.name}`, objectContract(o, 'Entity Schema Page'));
  }
  for (const o of registry.formTypes ?? []) {
    await ensurePage(r, o.schemaPage);
    await appendManagedBlock(r, o.schemaPage, `${MODE}-schema-${o.name}`, objectContract(o, 'Form Schema Page'));
  }
  for (const o of registry.wordExtenderTypes ?? []) {
    await ensurePage(r, o.schemaPage);
    await appendManagedBlock(r, o.schemaPage, `${MODE}-schema-${o.name}`, objectContract(o, 'Word Extender Schema Page'));
  }
}

export async function step4(r: Result): Promise<void> {
  const family = MODE === 'db' ? 'DB Tag' : 'Tag Reference';
  for (const tag of allTags()) {
    const page = `${family}/${tag}`;
    await ensurePage(r, page);
    await appendManagedBlock(r, page, `${MODE}-tag-${tag}`, tagContract(tag));
  }
}

export async function step5(r: Result): Promise<void> {
  const family = MODE === 'db' ? 'Tag Properties' : 'Property Reference';
  for (const tag of allTags()) {
    const page = `${family}/${tag}`;
    await ensurePage(r, page);
    await appendManagedBlock(r, page, `${MODE}-tag-props-${tag}`, tagPropertiesContract(tag));
  }
}

export async function step6(r: Result): Promise<void> {
  for (const rel of registry.relationshipRegistry ?? []) {
    const prop = String(rel.property ?? 'unknown');
    await ensurePage(r, `Relationship/${prop}`);
    await appendManagedBlock(r, `Relationship/${prop}`, `${MODE}-rel-${prop}`, relationshipContract(rel));
  }
}

export async function step7(r: Result): Promise<void> {
  for (const t of registry.templates ?? []) {
    await ensurePage(r, t.name);
    await appendManagedBlock(
      r,
      t.name,
      `${MODE}-template-ref-${String(t.name).replace(/[^a-zA-Z0-9]/g, '-')}`,
      templateReference(t),
    );
  }
  if (MODE === 'db') {
    await installNativeTemplates(r);
  } else {
    await installLegacyTemplates(r);
  }
}

export async function step8(r: Result): Promise<void> {
  for (const d of registry.dashboardDefinitions ?? []) {
    await ensurePage(r, d.page);
    await appendManagedBlock(
      r,
      d.page,
      `${MODE}-dashboard-${String(d.page).replace(/[^a-zA-Z0-9]/g, '-')}`,
      dashboardContract(d),
    );
  }
}

export async function step9(r: Result): Promise<void> {
  for (const e of starterWordEntries()) {
    await ensurePage(r, e.page);
    await appendManagedBlock(
      r,
      e.page,
      `${MODE}-word-${pageForCanonical(e.page).replace(/[^a-zA-Z0-9]/g, '-')}`,
      wordEntryContract(e.page, e.tag, e.body, e.props),
    );
  }
}

export async function step10db(r: Result): Promise<void> {
  if (MODE !== 'db') return;
  r.notes.push('Best-effort DB native configuration. Failures are recorded but do not invalidate visible scaffold pages.');
  const tagCache = new Map<string, any>();
  for (const tag of nativeDbClassTags()) {
    try {
      let obj = await logseq.Editor.getTag(tag).catch(() => null);
      if (!obj) obj = await logseq.Editor.createTag(tag);
      if (!obj) {
        r.errors.push(`native-tag #${tag}: could not resolve or create class tag`);
        continue;
      }
      tagCache.set(tag, obj);
      r.actions.push(`ENSURE native tag: #${tag}`);
      await sleep(75);
    } catch (e) {
      r.errors.push(`native-tag #${tag}: ${formatError(e)}`);
    }
  }
  const skippedBuiltins = allTags().filter((tag) => !nativeDbClassTags().includes(tag));
  if (skippedBuiltins.length) {
    r.notes.push(
      `Skipped native createTag for Logseq built-in tags: ${skippedBuiltins.map((t) => `#${t}`).join(', ')}.`,
    );
  }
  const propertyCache = new Set<string>();
  const nativeProperties = [
    ...(registry.propertyRegistry ?? []),
    { name: 'lss-object-type', type: 'default', cardinality: 'one' },
  ];
  for (const p of nativeProperties) {
    const name = p.name ?? (p as { property?: string }).property ?? (p as { key?: string }).key;
    if (!name) continue;
    try {
      const ensured = await ensureNativeProperty(p);
      if (ensured?.name) propertyCache.add(ensured.name);
      if (ensured?.created) {
        r.actions.push(`CREATE native property: ${name}`);
      } else if (ensured?.skipped) {
        r.notes.push(`SKIP native property ${name}: ${ensured.note ?? 'already exists'}`);
      } else if (!ensured) {
        r.errors.push(`native-property ${name}: could not register property`);
      }
      await sleep(20);
    } catch (e) {
      const message = formatError(e);
      if (
        /can't be changed|existing data|cannot be changed/i.test(message) ||
        isPluginPropertyOwnershipError(message)
      ) {
        r.notes.push(`SKIP native property ${name}: ${message}`);
        propertyCache.add(name);
      } else {
        r.errors.push(`native-property ${name}: ${message}`);
      }
    }
  }
  for (const o of allObjects()) {
    const tag = safeTag(o.tag);
    const tagObj = tagCache.get(tag);
    const tagId = tagObj ? entityIdentity(tagObj) : null;
    if (!tagId) continue;
    for (const parent of o.extends ?? []) {
      try {
        await logseq.Editor.addTagExtends(tagId, parent);
        r.actions.push(`#${tag} extends #${parent}`);
        await sleep(20);
      } catch (e) {
        r.errors.push(`tag-extends #${tag}->#${parent}: ${formatError(e)}`);
      }
    }
    for (const prop of o.properties ?? []) {
      if (!propertyCache.has(prop)) {
        r.notes.push(`SKIP tag-property #${tag}.${prop}: native property ${prop} was not registered.`);
        continue;
      }
      try {
        await logseq.Editor.addTagProperty(tagId, prop);
        r.actions.push(`#${tag} property ${prop}`);
        await sleep(20);
      } catch (e) {
        r.errors.push(`tag-property #${tag}.${prop}: ${formatError(e)}`);
      }
    }
  }
}

export async function stepPageTree(r: Result): Promise<void> {
  await ensurePage(r, 'LSS Page Tree');
  await appendManagedBlock(r, 'LSS Page Tree', `${MODE}-page-tree-v1`, pageTreeText());
}

export async function stepVerify(r: Result): Promise<void> {
  const missing: string[] = [];
  for (const page of rootPages()) await checkPage(missing, page);
  for (const a of registry.areas ?? []) await checkPage(missing, a.page);
  for (const o of allObjects()) await checkPage(missing, o.schemaPage);
  for (const tag of allTags()) {
    await checkPage(missing, `${MODE === 'db' ? 'DB Tag' : 'Tag Reference'}/${tag}`);
    await checkPage(missing, `${MODE === 'db' ? 'Tag Properties' : 'Property Reference'}/${tag}`);
  }
  for (const rel of registry.relationshipRegistry ?? []) await checkPage(missing, `Relationship/${rel.property}`);
  for (const t of registry.templates ?? []) await checkPage(missing, t.name);
  for (const d of registry.dashboardDefinitions ?? []) await checkPage(missing, d.page);
  for (const e of starterWordEntries()) await checkPage(missing, e.page);
  r.notes.push(`Checked pages: ${missing.length ? 'missing pages found' : 'all expected visible pages present'}.`);
  if (missing.length) for (const m of missing) r.errors.push(`missing page: ${m}`);
}

export async function setupAll(r: Result): Promise<void> {
  r.notes.push('Runs the full setup sequence. If Logseq slows down, use commands 2-13 step by step instead.');
  await step1(r);
  await step2(r);
  await step3(r);
  await step4(r);
  await step5(r);
  await step6(r);
  await step7(r);
  await step8(r);
  await step9(r);
  if (MODE === 'db') await step10db(r);
  await stepPageTree(r);
  await stepVerify(r);
}

export async function maintInitializeSchema(r: Result): Promise<void> {
  r.notes.push('One-shot initialize runs all scaffold layers. Step-by-step commands remain safer for large graphs.');
  await step1(r);
  await step2(r);
  await step3(r);
  await step4(r);
  await step5(r);
  await step6(r);
  await step7(r);
  await step8(r);
  await step9(r);
  if (MODE === 'db') await step10db(r);
  await stepVerify(r);
}

export async function maintVerifySchema(r: Result): Promise<void> {
  await stepVerify(r);
}
