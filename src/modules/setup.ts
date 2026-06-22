import { MODE } from '../config';
import {
  canonicalPropertyKey,
  ensureNativeProperty,
  entityIdentity,
  getCanonicalProp,
  isPluginPropertyOwnershipError,
  resolveUpsertPropertyValue,
} from '../core/db-properties';
import {
  appendManagedBlock,
  blockId,
  ensurePage,
  getPage,
  pageVisibleName,
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
  propertySpec,
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
import { installLegacyTemplates, installNativeTemplates, uniqueObjectProps } from './templates';

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
      `Skipped native createTag for built-in or slash-context tags: ${skippedBuiltins.map((t) => `#${t}`).join(', ')}.`,
    );
  }
  const nativeProperties = [
    ...(registry.propertyRegistry ?? []),
    { name: 'lss-object-type', type: 'default', cardinality: 'one' },
  ];
  const nativeNodePropertiesToReset = new Set<string>();
  for (const p of nativeProperties) {
    const name = p.name ?? (p as { property?: string }).property ?? (p as { key?: string }).key;
    if (!name) continue;
    const isNodeProperty = String((p as { type?: unknown }).type ?? '').toLowerCase() === 'node';
    try {
      const ensured = await ensureNativeProperty(p);
      if (ensured?.created) {
        r.actions.push(`CREATE native property: ${name}${ensured.note ? ` (${ensured.note})` : ''}`);
      } else if (ensured?.skipped) {
        r.notes.push(`SKIP native property ${name}: ${ensured.note ?? 'already exists'}`);
        if (
          isNodeProperty &&
          /schema left unchanged|can't be changed|existing data|cannot be changed/i.test(ensured.note ?? '')
        ) {
          nativeNodePropertiesToReset.add(canonicalPropertyKey(name));
        }
      } else if (!ensured) {
        r.errors.push(`native-property ${name}: could not register property`);
      }
      await sleep(75);
    } catch (e) {
      const message = formatError(e);
      if (
        /can't be changed|existing data|cannot be changed/i.test(message) ||
        isPluginPropertyOwnershipError(message)
      ) {
        r.notes.push(`SKIP native property ${name}: ${message}`);
        if (isNodeProperty && !isPluginPropertyOwnershipError(message)) {
          nativeNodePropertiesToReset.add(canonicalPropertyKey(name));
        }
      } else {
        r.errors.push(`native-property ${name}: ${message}`);
      }
    }
  }
  for (const propertyName of nativeNodePropertiesToReset) {
    r.notes.push(`Detected stale native ${propertyName} property schema; resetting it to a DB node picker.`);
    await resetNativeNodeProperty(r, propertyName);
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
    await removeNativeTagSchemaProperties(r, tag, tagId);
  }
}

function propertyValueToRestoreString(value: unknown): string {
  if (value == null) return '';
  if (Array.isArray(value)) {
    return value.map(propertyValueToRestoreString).filter(Boolean).join(', ');
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const id = record.id ?? record[':db/id'] ?? record['db/id'];
    if (id != null) return String(id);
    const name = pageVisibleName(record);
    if (name) return `[[${name}]]`;
    return '';
  }
  return String(value ?? '').trim();
}

async function readAnyBlockProperty(blockIdentity: string, property: string): Promise<unknown> {
  if (logseq.Editor.getBlockProperty) {
    const direct = await logseq.Editor.getBlockProperty(blockIdentity, property).catch(() => null);
    if (direct != null) return direct;
  }
  if (logseq.Editor.getBlockProperties) {
    const props = await logseq.Editor.getBlockProperties(blockIdentity).catch(() => null);
    if (props) {
      const direct = getCanonicalProp(props as Record<string, unknown>, property);
      if (direct != null) return direct;
    }
  }
  if (logseq.Editor.getBlock) {
    const block = await logseq.Editor.getBlock(blockIdentity).catch(() => null);
    const props = (block as Record<string, unknown> | null)?.properties as Record<string, unknown> | undefined;
    const direct = props ? getCanonicalProp(props, property) : undefined;
    if (direct != null) return direct;
  }
  return undefined;
}

async function capturePropertyValuesForLssObjects(property: string): Promise<Array<{ blockId: string; value: unknown }>> {
  const captured: Array<{ blockId: string; value: unknown }> = [];
  const seen = new Set<string>();
  if (!logseq.Editor.getTagObjects) return captured;

  for (const object of allObjects()) {
    if (!uniqueObjectProps(object).some((prop) => canonicalPropertyKey(prop) === property)) continue;
    const tag = safeTag(object.tag);
    const objects = await logseq.Editor.getTagObjects(tag).catch(() => null);
    for (const item of objects ?? []) {
      const id = blockId(item);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const value = await readAnyBlockProperty(id, property);
      if (value != null && String(propertyValueToRestoreString(value)).trim()) captured.push({ blockId: id, value });
    }
  }
  return captured;
}

async function waitForNativePropertyRemoval(name: string): Promise<boolean> {
  if (!logseq.Editor.getProperty) return true;
  for (let i = 0; i < 10; i++) {
    const existing = await logseq.Editor.getProperty(name).catch(() => null);
    if (!existing) return true;
    await sleep(150);
  }
  return false;
}

async function nativePropertySnapshot(name: string): Promise<string> {
  if (!logseq.Editor.getProperty) return `${name}: getProperty unavailable`;
  const prop = (await logseq.Editor.getProperty(name).catch((error) => ({ error: formatError(error) }))) as
    | Record<string, unknown>
    | null;
  if (!prop) return `${name}: missing`;
  if (prop.error) return `${name}: getProperty error: ${String(prop.error)}`;
  const id = prop.id ?? prop[':db/id'] ?? prop['db/id'] ?? '(no id)';
  const uuid = prop.uuid ?? prop[':block/uuid'] ?? prop['block/uuid'] ?? '(no uuid)';
  const ident = prop.ident ?? prop[':db/ident'] ?? prop['db/ident'] ?? '(no ident)';
  const props = (prop.properties as Record<string, unknown> | undefined) ?? {};
  const blockProps =
    (prop.uuid || prop.id) && logseq.Editor.getBlockProperties
      ? ((await logseq.Editor.getBlockProperties((prop.uuid ?? prop.id) as any).catch(() => null)) as
          | Record<string, unknown>
          | null)
      : null;
  const interesting: Record<string, unknown> = {};
  for (const source of [prop, props, blockProps ?? {}]) {
    for (const key of [
      'type',
      'cardinality',
      ':logseq.property/type',
      'logseq.property/type',
      ':logseq.property/cardinality',
      'logseq.property/cardinality',
      ':logseq.property/node-tags',
      'logseq.property/node-tags',
      ':logseq.property/classes',
      'logseq.property/classes',
    ]) {
      if ((source as Record<string, unknown>)[key] != null && interesting[key] == null) {
        interesting[key] = (source as Record<string, unknown>)[key];
      }
    }
  }
  return `${name}: id=${String(id)} uuid=${String(uuid)} ident=${String(ident)} fields=${JSON.stringify(interesting)} propKeys=${Object.keys(props).sort().join(',') || '(none)'} blockPropKeys=${Object.keys(blockProps ?? {}).sort().join(',') || '(none)'}`;
}

async function removeNativePropertyDefinition(name: string, prop: Record<string, unknown>, r: Result): Promise<boolean> {
  if (!logseq.Editor.removeProperty) return false;
  const candidates = [
    name,
    prop.ident,
    prop[':db/ident'],
    prop['db/ident'],
    prop.uuid,
    prop[':block/uuid'],
    prop['block/uuid'],
    prop.id,
    prop[':db/id'],
    prop['db/id'],
  ]
    .map((value) => String(value ?? '').trim())
    .filter(Boolean);
  const unique = [...new Set(candidates)];
  let lastError = '';
  for (const candidate of unique) {
    try {
      await logseq.Editor.removeProperty(candidate);
      if (candidate !== name) r.actions.push(`REMOVE native property definition via identity: ${candidate}`);
      return true;
    } catch (error) {
      lastError = formatError(error);
    }
  }
  r.errors.push(`removeProperty ${name} failed for ${unique.join(', ')}: ${lastError || 'unknown error'}`);
  return false;
}

export async function resetNativeNodeProperty(r: Result, propertyName: string): Promise<void> {
  const cleanName = canonicalPropertyKey(propertyName);
  if (MODE !== 'db') {
    r.notes.push(`reset-${cleanName}-property applies only to DB graphs.`);
    return;
  }
  if (!logseq.Editor.removeProperty) {
    r.errors.push(`removeProperty API unavailable; cannot reset native ${cleanName} property.`);
    return;
  }

  r.notes.push(`Before reset: ${await nativePropertySnapshot(cleanName)}`);
  r.notes.push(
    `Native API availability: removeProperty=${logseq.Editor.removeProperty ? 'yes' : 'no'}, upsertProperty=${logseq.Editor.upsertProperty ? 'yes' : 'no'}, setPropertyNodeTags=${logseq.Editor.setPropertyNodeTags ? 'yes' : 'no'}`,
  );

  const spec = propertySpec(cleanName);
  if (!spec || String(spec.type ?? '').toLowerCase() !== 'node') {
    r.errors.push(`Registry node property spec missing: ${cleanName}`);
    return;
  }

  for (const target of (((spec as { targets?: unknown[] }).targets ?? [])).map(String).filter(Boolean)) {
    const tag =
      (await logseq.Editor.getTag?.(target).catch(() => null)) ||
      (await logseq.Editor.createTag?.(target).catch(() => null));
    if (!tag) {
      r.errors.push(`Could not resolve/create native #${target} tag; ${cleanName} reset aborted.`);
      return;
    }
    r.actions.push(`ENSURE native tag: #${target}`);
  }

  const captured = await capturePropertyValuesForLssObjects(cleanName);
  r.notes.push(`Captured ${captured.length} existing LSS ${cleanName} value(s) before native property reset.`);

  const existing = logseq.Editor.getProperty ? await logseq.Editor.getProperty(cleanName).catch(() => null) : null;
  if (existing) {
    const removedCallOk = await removeNativePropertyDefinition(cleanName, existing as Record<string, unknown>, r);
    if (!removedCallOk) {
      r.notes.push(`After failed remove: ${await nativePropertySnapshot(cleanName)}`);
      return;
    }
    r.actions.push(`REMOVE native property definition: ${cleanName}`);
    const removed = await waitForNativePropertyRemoval(cleanName);
    r.notes.push(`After remove wait: ${await nativePropertySnapshot(cleanName)}`);
    if (!removed) {
      r.errors.push(`Native property ${cleanName} still exists after removeProperty; reload Logseq and rerun setup/reset.`);
      return;
    }
  } else {
    r.notes.push(`Native property ${cleanName} did not exist before reset.`);
  }

  const ensured = await ensureNativeProperty(spec);
  r.notes.push(`After recreate: ${await nativePropertySnapshot(cleanName)}`);
  if (ensured?.created) {
    r.actions.push(`RECREATE native property: ${cleanName}${ensured.note ? ` (${ensured.note})` : ''}`);
  } else if (ensured?.skipped) {
    r.notes.push(`RECREATE native property ${cleanName}: ${ensured.note}`);
  } else {
    r.errors.push(`Failed to recreate native property: ${cleanName}`);
    return;
  }

  let restored = 0;
  if (logseq.Editor.upsertBlockProperty) {
    for (const item of captured) {
      const raw = propertyValueToRestoreString(item.value);
      if (!raw) continue;
      const upsertValue = await resolveUpsertPropertyValue(cleanName, raw);
      if (upsertValue == null || typeof upsertValue === 'string') {
        r.notes.push(`SKIP restore ${cleanName} on ${item.blockId}: could not resolve ${raw} to a target page id`);
        continue;
      }
      await logseq.Editor.upsertBlockProperty(item.blockId, cleanName, upsertValue, { reset: true });
      restored++;
    }
  }
  r.actions.push(`RESTORE ${cleanName} values after reset: ${restored}/${captured.length}`);
  r.notes.push(`After reload, ${cleanName} should open as a DB node picker filtered to its target tag(s).`);
}

export async function resetVentureNativeProperty(r: Result): Promise<void> {
  await resetNativeNodeProperty(r, 'venture');
}

export async function removeNativeTagSchemaProperties(
  r: Result,
  tag?: string,
  tagId?: string | number | null,
): Promise<void> {
  if (MODE !== 'db') return;
  const targets = tag
    ? allObjects().filter((o) => safeTag(o.tag) === safeTag(tag))
    : allObjects();
  if (!targets.length) return;
  if (!logseq.Editor.removeTagProperty) {
    r.notes.push('removeTagProperty API unavailable; cannot remove native tag schema properties.');
    return;
  }

  for (const o of targets) {
    const cleanTag = safeTag(o.tag);
    let resolvedTagId = tagId ?? null;
    if (resolvedTagId == null) {
      const tagObj = await logseq.Editor.getTag(cleanTag).catch(() => null);
      resolvedTagId = tagObj ? entityIdentity(tagObj) : null;
    }
    if (resolvedTagId == null) continue;

    for (const prop of [...new Set([...uniqueObjectProps(o), 'lss-object-type', 'lss-object-tag'])]) {
      try {
        await logseq.Editor.removeTagProperty(resolvedTagId, prop);
        r.actions.push(`REMOVE native tag property #${cleanTag}.${prop}`);
        await sleep(20);
      } catch (e) {
        const message = formatError(e);
        if (!/not found|missing|does not exist|not .*property/i.test(message)) {
          r.notes.push(`native tag property #${cleanTag}.${prop} not removed: ${message}`);
        }
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
