import { MODE } from '../config';
import {
  canonicalPropertyKey,
  ensureNativeProperty,
  entityIdentity,
  getCanonicalProp,
  isPluginPropertyOwnershipError,
  nativePropertyResetReasonForSpec,
  pluginPropertyIdent,
  resolveUpsertPropertyValue,
} from '../core/db-properties';
import {
  appendManagedBlock,
  blockId,
  ensurePage,
  getPage,
  pageVisibleName,
  resolvePageFromIdentity,
} from '../core/editor';
import { formatError, sleep } from '../core/runner';
import { safeTag } from '../core/names';
import type { Result } from '../core/types';
import {
  allObjects,
  allPropertySpecs,
  allRelationships,
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
    `properties:: ${allPropertySpecs().length}`,
    `relationships:: ${allRelationships().length}`,
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
  for (const rel of allRelationships()) {
    const prop = String(rel.property ?? 'unknown');
    await ensurePage(r, `Relationship/${prop}`);
    await appendManagedBlock(r, `Relationship/${prop}`, `${MODE}-rel-${prop}`, relationshipContract(rel));
  }
}

type SetupTemplateOptions = {
  nativeTemplateQueries?: boolean;
};

export async function step7(r: Result, options: SetupTemplateOptions = {}): Promise<void> {
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
    const nativeTemplateQueries = options.nativeTemplateQueries !== false;
    await installNativeTemplates(r, {
      includeQueryBlocks: nativeTemplateQueries,
      finalizeQueryBlocks: nativeTemplateQueries,
    });
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
    ...allPropertySpecs(),
    { name: 'lss-object-type', type: 'default', cardinality: 'one' },
  ];
  const staleNativeNodeProperties = new Set<string>();
  for (const p of nativeProperties) {
    const name = String(p.name ?? (p as { property?: unknown }).property ?? (p as { key?: unknown }).key ?? '').trim();
    if (!name) continue;
    const isNodeProperty = String((p as { type?: unknown }).type ?? '').toLowerCase() === 'node';
    if (isNodeProperty) {
      const resetReason = await nativePropertyResetReasonForSpec(p);
      if (resetReason) {
        r.notes.push(`SKIP native property ${name}: stale schema detected (${resetReason}); setup left it unchanged.`);
        staleNativeNodeProperties.add(canonicalPropertyKey(name));
        continue;
      }
    }
    try {
      const ensured = await ensureNativeProperty(p, { refreshExistingSchema: false });
      if (ensured?.created) {
        r.actions.push(`CREATE native property: ${name}${ensured.note ? ` (${ensured.note})` : ''}`);
      } else if (ensured?.skipped) {
        r.notes.push(`SKIP native property ${name}: ${ensured.note ?? 'already exists'}`);
        if (
          isNodeProperty &&
          /schema left unchanged|can't be changed|existing data|cannot be changed/i.test(ensured.note ?? '')
        ) {
          staleNativeNodeProperties.add(canonicalPropertyKey(name));
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
          staleNativeNodeProperties.add(canonicalPropertyKey(name));
        }
      } else {
        r.errors.push(`native-property ${name}: ${message}`);
      }
    }
  }
  for (const propertyName of staleNativeNodeProperties) {
    r.notes.push(
      `Detected stale native ${propertyName} property schema; setup left it unchanged. Run an explicit reset/repair command only after confirming non-LSS values are backed up.`,
    );
  }
  await ensurePrimaryDisplayPropertyOrder(r);
  await ensureRelatedToPropertyOrder(r);
  await ensureRelatedToBeforeTrailingAdminProperties(r);
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
    const propertyValue =
      record.value ??
      record['logseq.property/value'] ??
      record[':logseq.property/value'];
    if (propertyValue != null) return propertyValueToRestoreString(propertyValue);
    const createdFrom = record['logseq.property/created-from-property'] ?? record[':logseq.property/created-from-property'];
    const title = record.title ?? record['block/title'] ?? record[':block/title'];
    if (createdFrom != null && title != null) return String(title).trim();
    const id = record.id ?? record[':db/id'] ?? record['db/id'];
    if (id != null) return String(id);
    const name = pageVisibleName(record);
    if (name) return `[[${name}]]`;
    return '';
  }
  return String(value ?? '').trim();
}

function entityIdFromValue(value: unknown): string | number | null {
  if (typeof value === 'string' || typeof value === 'number') return value;
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  return (
    (record.id as string | number | undefined) ??
    (record[':db/id'] as string | number | undefined) ??
    (record['db/id'] as string | number | undefined) ??
    null
  );
}

async function readPropertyValueEntityValue(value: unknown): Promise<unknown> {
  const id = entityIdFromValue(value);
  if (id == null || !logseq.DB?.datascriptQuery) return undefined;
  try {
    const rows = await logseq.DB.datascriptQuery(
      `[:find ?value
 :in $ ?e
 :where [?e :logseq.property/value ?value]]`,
      Number.isFinite(Number(id)) ? Number(id) : id,
    );
    const first = Array.isArray(rows) ? rows[0] : null;
    return Array.isArray(first) ? first[0] : undefined;
  } catch {
    return undefined;
  }
}

async function readPropertyValueEntityTitle(value: unknown): Promise<unknown> {
  const id = entityIdFromValue(value);
  if (id == null || !logseq.DB?.datascriptQuery) return undefined;
  try {
    const rows = await logseq.DB.datascriptQuery(
      `[:find ?title
 :in $ ?e
 :where
 [?e :logseq.property/created-from-property ?property]
 [?e :block/title ?title]]`,
      Number.isFinite(Number(id)) ? Number(id) : id,
    );
    const first = Array.isArray(rows) ? rows[0] : null;
    return Array.isArray(first) ? first[0] : undefined;
  } catch {
    return undefined;
  }
}

async function propertyValueToRestoreStringAsync(value: unknown): Promise<string> {
  if (value == null) return '';
  if (Array.isArray(value)) {
    const parts = await Promise.all(value.map((item) => propertyValueToRestoreStringAsync(item)));
    return parts.filter(Boolean).join(', ');
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const propertyValue =
      record.value ??
      record['logseq.property/value'] ??
      record[':logseq.property/value'];
    if (propertyValue != null) return propertyValueToRestoreStringAsync(propertyValue);
  }
  const propertyEntityValue = await readPropertyValueEntityValue(value);
  if (propertyEntityValue != null) return propertyValueToRestoreStringAsync(propertyEntityValue);
  const propertyEntityTitle = await readPropertyValueEntityTitle(value);
  if (propertyEntityTitle != null) return propertyValueToRestoreStringAsync(propertyEntityTitle);
  return propertyValueToRestoreString(value);
}

function specPropertyName(spec: Record<string, unknown>): string {
  return String(spec.name ?? spec.property ?? spec.key ?? '').trim();
}

function orderFromRecord(source: Record<string, unknown> | null | undefined): string {
  if (!source) return '';
  return String(
    source.order ??
      source['block/order'] ??
      source[':block/order'] ??
      source.blockOrder ??
      '',
  ).trim();
}

async function nativePropertyOrder(name: string): Promise<string> {
  if (logseq.Editor.getProperty) {
    const prop = (await logseq.Editor.getProperty(name).catch(() => null)) as Record<string, unknown> | null;
    const direct = orderFromRecord(prop);
    if (direct) return direct;
    const identity = prop?.uuid ?? prop?.id ?? prop?.[':block/uuid'] ?? prop?.['block/uuid'] ?? prop?.[':db/id'] ?? prop?.['db/id'];
    if (identity != null && logseq.Editor.getBlock) {
      const block = (await logseq.Editor.getBlock(identity as any).catch(() => null)) as Record<string, unknown> | null;
      const blockOrder = orderFromRecord(block);
      if (blockOrder) return blockOrder;
    }
    if (identity != null && logseq.Editor.getBlockProperties) {
      const blockProps = (await logseq.Editor.getBlockProperties(identity as any).catch(() => null)) as
        | Record<string, unknown>
        | null;
      const propOrder = orderFromRecord(blockProps);
      if (propOrder) return propOrder;
    }
  }
  if (!logseq.DB?.datascriptQuery) return '';
  try {
    const rows = await logseq.DB.datascriptQuery(
      `[:find ?order
 :in $ ?title ?name
 :where
 (or [?p :block/title ?title]
     [?p :block/name ?name])
 [?p :block/order ?order]]`,
      name,
      name.toLowerCase(),
    );
    if (!Array.isArray(rows)) return '';
    const first = rows[0];
    if (Array.isArray(first)) return String(first[0] ?? '').trim();
    if (first && typeof first === 'object') {
      const recordOrder = orderFromRecord(first as Record<string, unknown>);
      if (recordOrder) return recordOrder;
      const value = Object.values(first as Record<string, unknown>)[0];
      return String(value ?? '').trim();
    }
    return String(first ?? '').trim();
  } catch {
    return '';
  }
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
    if (
      property !== 'lss-object-type' &&
      !uniqueObjectProps(object).some((prop) => canonicalPropertyKey(prop) === property)
    ) {
      continue;
    }
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

function safePluginPropertyIdentForQuery(property: string): string {
  const ident = pluginPropertyIdent(canonicalPropertyKey(property));
  return /^:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(ident) ? ident : '';
}

async function capturePropertyValuesViaDatascript(property: string): Promise<Array<{ blockId: string; value: unknown }>> {
  if (!logseq.DB?.datascriptQuery) return [];
  const ident = safePluginPropertyIdentForQuery(property);
  if (!ident) return [];
  try {
    const rows = await logseq.DB.datascriptQuery(
      `[:find ?entity ?value
 :where
 [?entity ${ident} ?value]
 (not [?entity :logseq.property/deleted-at ?deleted])
 (not [?entity :db/ident ?entityIdent])]`,
    );
    const grouped = new Map<string, unknown[]>();
    for (const row of (rows ?? []) as Array<[unknown, unknown]>) {
      const id = entityIdentity(row?.[0]) ?? row?.[0];
      if (id == null) continue;
      const block = String(id).trim();
      if (!block) continue;
      const values = grouped.get(block) ?? [];
      values.push(row[1]);
      grouped.set(block, values);
    }
    return [...grouped.entries()].map(([blockId, values]) => ({
      blockId,
      value: values.length === 1 ? values[0] : values,
    }));
  } catch {
    return [];
  }
}

async function capturePropertyValuesForNativeProperty(property: string): Promise<Array<{ blockId: string; value: unknown }>> {
  const viaDatascript = await capturePropertyValuesViaDatascript(property);
  if (viaDatascript.length) return viaDatascript;
  return capturePropertyValuesForLssObjects(property);
}

async function activePropertyValueCount(property: string): Promise<number | null> {
  if (!logseq.DB?.datascriptQuery) return null;
  const ident = safePluginPropertyIdentForQuery(property);
  if (!ident) return null;
  try {
    const rows = await logseq.DB.datascriptQuery(
      `[:find (count ?entity)
 :where
 [?entity ${ident} ?value]
 (not [?entity :logseq.property/deleted-at ?deleted])
 (not [?entity :db/ident ?entityIdent])]`,
    );
    const first = Array.isArray(rows) ? rows[0] : null;
    const count = Array.isArray(first) ? Number(first[0] ?? 0) : 0;
    return Number.isFinite(count) ? count : null;
  } catch {
    return null;
  }
}

async function waitForPropertyValuesCleared(property: string): Promise<number | null> {
  for (let i = 0; i < 20; i++) {
    const count = await activePropertyValueCount(property);
    if (count == null) return null;
    if (count === 0) return 0;
    await sleep(250);
  }
  return activePropertyValueCount(property);
}

async function clearCapturedPropertyValues(
  r: Result,
  property: string,
  captured: Array<{ blockId: string; value: unknown }>,
): Promise<boolean> {
  if (!captured.length) return true;
  if (!logseq.Editor.removeBlockProperty) {
    r.errors.push(`removeBlockProperty API unavailable; cannot clear existing ${property} values before reset.`);
    return false;
  }
  const keys = [
    property,
    pluginPropertyIdent(property),
    pluginPropertyIdent(property).replace(/^:/, ''),
  ];
  let cleared = 0;
  let failed = 0;
  for (const item of captured) {
    const targets = await mutationTargetsForBlockId(item.blockId);
    let removed = false;
    let lastError = '';
    for (const target of targets) {
      for (const key of [...new Set(keys)]) {
        try {
          await logseq.Editor.removeBlockProperty(target, key);
          removed = true;
          await sleep(10);
        } catch (error) {
          lastError = formatError(error);
        }
      }
    }
    if (removed) {
      cleared++;
    } else {
      failed++;
      r.errors.push(`CLEAR ${property} on ${item.blockId} failed: ${lastError || 'unknown error'}`);
    }
  }
  r.actions.push(`CLEAR ${property} values before reset: ${cleared}/${captured.length}`);
  await sleep(150);
  return failed === 0;
}

async function mutationTargetsForBlockId(rawBlockId: string): Promise<string[]> {
  const targets = new Set<string>();
  const add = (value: unknown) => {
    const raw = String(value ?? '').trim();
    if (raw) targets.add(raw);
  };
  add(rawBlockId);
  const page = await resolvePageFromIdentity(rawBlockId).catch(() => null);
  add(blockId(page));
  const uuid = (page as Record<string, unknown> | null)?.uuid ?? (page as Record<string, unknown> | null)?.[':block/uuid'] ?? (page as Record<string, unknown> | null)?.['block/uuid'];
  add(uuid);
  if (logseq.Editor.getBlock) {
    const block = await logseq.Editor.getBlock(rawBlockId).catch(() => null);
    add(blockId(block));
    const blockRecord = block as Record<string, unknown> | null;
    add(blockRecord?.uuid ?? blockRecord?.[':block/uuid'] ?? blockRecord?.['block/uuid']);
  }
  return [...targets];
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

async function restoreCapturedPropertyValues(
  r: Result,
  spec: Record<string, unknown>,
  cleanName: string,
  captured: Array<{ blockId: string; value: unknown }>,
): Promise<void> {
  const isNode = String(spec.type ?? '').toLowerCase() === 'node';
  const isDate = String(spec.type ?? '').toLowerCase() === 'date';
  let restored = 0;
  let restoreFailed = 0;
  if (logseq.Editor.upsertBlockProperty) {
    for (const item of captured) {
      const targets = await mutationTargetsForBlockId(item.blockId);
      const targetBlockId = targets[0] ?? item.blockId;
      const raw = await propertyValueToRestoreStringAsync(item.value);
      if (!raw) continue;
      let upsertValue = await resolveUpsertPropertyValue(cleanName, raw);
      if (isDate && upsertValue == null && /^\d+$/.test(raw)) {
        const page = await resolvePageFromIdentity(raw).catch(() => null);
        const label = pageVisibleName(page as Record<string, unknown> | null);
        if (label) upsertValue = await resolveUpsertPropertyValue(cleanName, label);
      }
      if (isNode && typeof upsertValue === 'string' && /^\d+(?:\s*,\s*\d+)*$/.test(raw)) {
        const ids = raw.split(',').map((value) => Number(value.trim())).filter((value) => Number.isFinite(value));
        const cardinality = String((spec as { cardinality?: string }).cardinality ?? '').toLowerCase();
        if (ids.length) upsertValue = cardinality === 'many' ? ids : ids[0];
      }
      if (upsertValue == null || (isNode && typeof upsertValue === 'string')) {
        r.notes.push(`SKIP restore ${cleanName} on ${item.blockId}: could not resolve ${raw} to a target page id`);
        continue;
      }
      try {
        await logseq.Editor.upsertBlockProperty(targetBlockId, cleanName, upsertValue, { reset: true });
        restored++;
      } catch (error) {
        restoreFailed++;
        r.errors.push(`RESTORE ${cleanName} on ${targetBlockId} failed: ${formatError(error)}`);
      }
    }
  }
  r.actions.push(`RESTORE ${cleanName} values after schema repair: ${restored}/${captured.length}`);
  if (restoreFailed) r.notes.push(`Restore failures for ${cleanName}: ${restoreFailed}.`);
}

async function ensureNativeNodePropertyTargets(r: Result, spec: Record<string, unknown>, cleanName: string): Promise<boolean> {
  if (String(spec.type ?? '').toLowerCase() !== 'node') return true;
  for (const target of (((spec as { targets?: unknown[] }).targets ?? [])).map(String).filter(Boolean)) {
    const tag =
      (await logseq.Editor.getTag?.(target).catch(() => null)) ||
      (await logseq.Editor.createTag?.(target).catch(() => null));
    if (!tag) {
      r.errors.push(`Could not resolve/create native #${target} tag; ${cleanName} schema repair aborted.`);
      return false;
    }
    r.actions.push(`ENSURE native tag: #${target}`);
  }
  return true;
}

export async function repairNativeNodePropertySchemaInPlace(r: Result, spec: Record<string, unknown>): Promise<void> {
  const cleanName = canonicalPropertyKey(specPropertyName(spec));
  if (MODE !== 'db') {
    r.notes.push(`repair-${cleanName}-schema applies only to DB graphs.`);
    return;
  }
  if (!cleanName || String(spec.type ?? '').toLowerCase() !== 'node') return;
  if (!(await ensureNativeNodePropertyTargets(r, spec, cleanName))) return;

  const captured = await capturePropertyValuesForNativeProperty(cleanName);
  const beforeOrder = await nativePropertyOrder(cleanName);
  r.notes.push(`Repairing native ${cleanName} schema in place; captured ${captured.length} value(s).`);
  if (!(await clearCapturedPropertyValues(r, cleanName, captured))) {
    r.notes.push(`Native ${cleanName} schema repair aborted before schema refresh because value clearing failed.`);
    return;
  }
  const remaining = await waitForPropertyValuesCleared(cleanName);
  if (remaining != null && remaining > 0) {
    r.errors.push(
      `Native ${cleanName} schema repair aborted: ${remaining} active value(s) still exist after clearing; Logseq would reject the type change.`,
    );
    await restoreCapturedPropertyValues(r, spec, cleanName, captured);
    return;
  }

  const ensured = await ensureNativeProperty(spec);
  const note = ensured?.note ?? '';
  if (ensured?.created) {
    r.actions.push(`CREATE native property during schema repair: ${cleanName}${note ? ` (${note})` : ''}`);
  } else if (ensured?.skipped) {
    r.notes.push(`REFRESH native property schema ${cleanName}: ${note || 'property already existed'}`);
    if (/schema left unchanged|can't be changed|existing data|cannot be changed/i.test(note)) {
      r.errors.push(`Native ${cleanName} schema refresh did not complete: ${note}`);
    }
  } else {
    r.errors.push(`Failed to refresh native property schema: ${cleanName}`);
  }

  const afterOrder = await nativePropertyOrder(cleanName);
  if (beforeOrder && afterOrder && beforeOrder !== afterOrder) {
    r.errors.push(`Native ${cleanName} schema repair changed property order from ${beforeOrder} to ${afterOrder}.`);
  }
  await restoreCapturedPropertyValues(r, spec, cleanName, captured);
  r.notes.push(`After in-place schema repair: ${await nativePropertySnapshot(cleanName)}`);
}

async function resetNativePropertyDefinition(r: Result, spec: Record<string, unknown>): Promise<void> {
  const cleanName = canonicalPropertyKey(specPropertyName(spec));
  if (MODE !== 'db') {
    r.notes.push(`reset-${cleanName}-property applies only to DB graphs.`);
    return;
  }
  if (!cleanName) {
    r.errors.push('Native property reset aborted: missing property name.');
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

  const isNode = String(spec.type ?? '').toLowerCase() === 'node';
  if (isNode && !(await ensureNativeNodePropertyTargets(r, spec, cleanName))) return;

  const captured = await capturePropertyValuesForNativeProperty(cleanName);
  r.notes.push(`Captured ${captured.length} existing ${cleanName} value(s) before native property reset.`);
  if (!(await clearCapturedPropertyValues(r, cleanName, captured))) {
    r.notes.push(`Reset ${cleanName} aborted before removing the native property definition because value clearing failed.`);
    return;
  }

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

  await restoreCapturedPropertyValues(r, spec, cleanName, captured);
  if (isNode) r.notes.push(`After reload, ${cleanName} should open as a DB node picker filtered to its target tag(s).`);
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
  const spec = propertySpec(cleanName);
  if (!spec || String(spec.type ?? '').toLowerCase() !== 'node') {
    r.errors.push(`Registry node property spec missing: ${cleanName}`);
    return;
  }
  await resetNativePropertyDefinition(r, spec);
}

export async function resetVentureNativeProperty(r: Result): Promise<void> {
  await resetNativeNodeProperty(r, 'venture');
}

export async function resetRelatedToNativeProperty(r: Result): Promise<void> {
  await resetNativeNodeProperty(r, 'related-to');
}

const PRIMARY_DISPLAY_PROPERTIES = new Set(['status', 'Status', 'area', 'areas', 'date']);

function specForDisplayProperty(name: string): Record<string, unknown> | null {
  if (name === 'lss-object-type') return { name: 'lss-object-type', type: 'default', cardinality: 'one' };
  return (propertySpec(name) as Record<string, unknown> | undefined) ?? null;
}

function displayPropertyBeforeRelatedTo(name: string, spec = specForDisplayProperty(name)): boolean {
  const clean = canonicalPropertyKey(name);
  if (!clean || clean === 'related-to') return false;
  if (PRIMARY_DISPLAY_PROPERTIES.has(clean) || clean === 'owner') return false;
  if (clean.startsWith('related-')) return true;
  return String(spec?.type ?? '').toLowerCase() === 'node';
}

function afterPrimaryDisplayPropertySpecs(): Array<Record<string, unknown>> {
  const afterPrimary = new Set<string>();
  for (const object of allObjects()) {
    for (const name of uniqueObjectProps(object).map(canonicalPropertyKey)) {
      if (!name || PRIMARY_DISPLAY_PROPERTIES.has(name)) continue;
      afterPrimary.add(name);
    }
  }
  afterPrimary.add('lss-object-type');
  return [...afterPrimary].map(specForDisplayProperty).filter((spec): spec is Record<string, unknown> => Boolean(spec));
}

function relatedToTrailingDisplayPropertySpecs(): Array<Record<string, unknown>> {
  const trailing = new Set<string>();
  for (const object of allObjects()) {
    const props = uniqueObjectProps(object).map(canonicalPropertyKey);
    const relatedToIndex = props.indexOf('related-to');
    if (relatedToIndex < 0) continue;
    for (const name of props.slice(relatedToIndex + 1)) {
      if (name && !name.startsWith('related-')) trailing.add(name);
    }
  }
  trailing.add('lss-object-type');

  return [...trailing].map(specForDisplayProperty).filter((spec): spec is Record<string, unknown> => Boolean(spec));
}

async function propertiesBeforePrimaryDisplayFields(): Promise<string[]> {
  const primaryOrders = [];
  for (const name of PRIMARY_DISPLAY_PROPERTIES) {
    const order = await nativePropertyOrder(name);
    if (order) primaryOrders.push(order);
  }
  if (!primaryOrders.length) return [];
  primaryOrders.sort();
  const latestPrimaryOrder = primaryOrders[primaryOrders.length - 1];
  if (!latestPrimaryOrder) return [];

  const beforePrimary = [];
  for (const spec of afterPrimaryDisplayPropertySpecs()) {
    const name = specPropertyName(spec);
    const order = await nativePropertyOrder(name);
    if (order && order < latestPrimaryOrder) beforePrimary.push(name);
  }
  return beforePrimary;
}

async function relatedPropertiesAfterRelatedTo(): Promise<string[]> {
  const relatedToOrder = await nativePropertyOrder('related-to');
  if (!relatedToOrder) return [];
  const laterSpecific: string[] = [];
  for (const spec of allPropertySpecs()) {
    const name = specPropertyName(spec);
    if (!displayPropertyBeforeRelatedTo(name, spec)) continue;
    const order = await nativePropertyOrder(name);
    if (order && order > relatedToOrder) laterSpecific.push(name);
  }
  return laterSpecific;
}

async function repairStaleNativeNodePropertySchemas(r: Result): Promise<string[]> {
  const staleProperties: Array<{ name: string; spec: Record<string, unknown> }> = [];
  for (const spec of allPropertySpecs()) {
    const name = specPropertyName(spec);
    if (!name || String(spec.type ?? '').toLowerCase() !== 'node') continue;
    const resetReason = await nativePropertyResetReasonForSpec(spec);
    if (resetReason) staleProperties.push({ name, spec });
  }
  if (!staleProperties.length) {
    r.notes.push('No stale native node property schemas found.');
    return [];
  }
  r.notes.push(`Repairing stale native node property schema(s) in place: ${staleProperties.map((p) => p.name).join(', ')}.`);
  for (const { spec } of staleProperties) {
    await repairNativeNodePropertySchemaInPlace(r, spec);
    await sleep(75);
  }
  return staleProperties.map((p) => p.name);
}

export async function repairRelatedToDisplayOrder(r: Result): Promise<void> {
  if (MODE !== 'db') {
    r.notes.push('repair-related-to-display-order applies only to DB graphs.');
    return;
  }
  await repairStaleNativeNodePropertySchemas(r);
  const initialRelatedToOrder = await nativePropertyOrder('related-to');
  if (!initialRelatedToOrder) {
    const spec = propertySpec('related-to');
    if (!spec) {
      r.errors.push('Registry node property spec missing: related-to');
      return;
    }
    await resetNativePropertyDefinition(r, spec);
  }

  const beforePrimary = await propertiesBeforePrimaryDisplayFields();
  if (beforePrimary.length) {
    r.notes.push(`Repairing canonical display order after primary field(s): ${beforePrimary.join(', ')}.`);
    for (const spec of afterPrimaryDisplayPropertySpecs()) {
      const name = specPropertyName(spec);
      if (!beforePrimary.includes(name)) continue;
      await resetNativePropertyDefinition(r, spec);
      await sleep(150);
    }
  }

  const laterSpecific = await relatedPropertiesAfterRelatedTo();
  if (laterSpecific.length) {
    r.notes.push(`Repairing related-to order after specific related field(s): ${laterSpecific.join(', ')}.`);
    await resetRelatedToNativeProperty(r);
    await sleep(150);
  }

  for (const spec of relatedToTrailingDisplayPropertySpecs()) {
    const name = specPropertyName(spec);
    const relatedToOrder = await nativePropertyOrder('related-to');
    const order = await nativePropertyOrder(name);
    if (!relatedToOrder || !order || order > relatedToOrder) continue;
    r.notes.push(`Repairing ${name} display order so it renders after related-to.`);
    await resetNativePropertyDefinition(r, spec);
    await sleep(150);
  }

  await ensureRelatedToPropertyOrder(r);
  await ensureRelatedToBeforeTrailingAdminProperties(r);
  await ensurePrimaryDisplayPropertyOrder(r);
}

export async function resetStaleNativeNodeProperties(r: Result): Promise<void> {
  if (MODE !== 'db') {
    r.notes.push('reset-stale-node-properties applies only to DB graphs.');
    return;
  }
  const staleProperties = await repairStaleNativeNodePropertySchemas(r);
  if (staleProperties.length) r.notes.push(`Resetting stale native node property schema(s): ${staleProperties.join(', ')}.`);
}

export async function ensureRelatedToPropertyOrder(r: Result): Promise<void> {
  const relatedToOrder = await nativePropertyOrder('related-to');
  if (!relatedToOrder) {
    r.notes.push('related-to property order check skipped: property order unavailable from Logseq APIs.');
    return;
  }
  const laterSpecific = [];
  for (const spec of allPropertySpecs()) {
    const name = specPropertyName(spec);
    if (!displayPropertyBeforeRelatedTo(name, spec)) continue;
    const order = await nativePropertyOrder(name);
    if (order && order > relatedToOrder) laterSpecific.push(name);
  }
  if (!laterSpecific.length) return;
  r.notes.push(
    `related-to property order is before specific related field(s): ${laterSpecific.join(', ')}; setup left native property definitions unchanged.`,
  );
}

export async function ensurePrimaryDisplayPropertyOrder(r: Result): Promise<void> {
  const beforePrimary = await propertiesBeforePrimaryDisplayFields();
  if (!beforePrimary.length) return;
  r.notes.push(
    `primary display field order is after canonical field(s): ${beforePrimary.join(', ')}; setup left native property definitions unchanged.`,
  );
}

export async function ensureRelatedToBeforeTrailingAdminProperties(r: Result): Promise<void> {
  const relatedToOrder = await nativePropertyOrder('related-to');
  if (!relatedToOrder) return;
  const trailingBeforeRelatedTo = [];
  for (const spec of relatedToTrailingDisplayPropertySpecs()) {
    const name = specPropertyName(spec);
    const order = await nativePropertyOrder(name);
    if (order && order < relatedToOrder) trailingBeforeRelatedTo.push(name);
  }
  if (!trailingBeforeRelatedTo.length) return;
  r.notes.push(
    `related-to property order is after trailing canonical field(s): ${trailingBeforeRelatedTo.join(', ')}; setup left native property definitions unchanged.`,
  );
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
  for (const rel of allRelationships()) await checkPage(missing, `Relationship/${rel.property}`);
  for (const t of registry.templates ?? []) await checkPage(missing, t.name);
  for (const d of registry.dashboardDefinitions ?? []) await checkPage(missing, d.page);
  for (const e of starterWordEntries()) await checkPage(missing, e.page);
  r.notes.push(`Checked pages: ${missing.length ? 'missing pages found' : 'all expected visible pages present'}.`);
  if (missing.length) for (const m of missing) r.errors.push(`missing page: ${m}`);
}

export async function setupAll(r: Result): Promise<void> {
  r.notes.push('Runs the full setup sequence. Native template query UI finalization is skipped here; use lss: 8setup-templates separately if needed.');
  await step1(r);
  await step2(r);
  await step3(r);
  await step4(r);
  await step5(r);
  await step6(r);
  await step7(r, { nativeTemplateQueries: false });
  await step8(r);
  await step9(r);
  if (MODE === 'db') await step10db(r);
  await stepPageTree(r);
  await stepVerify(r);
}

export async function maintInitializeSchema(r: Result): Promise<void> {
  r.notes.push('One-shot initialize runs all scaffold layers. Native template query UI finalization is skipped here; use lss: 8setup-templates separately if needed.');
  await step1(r);
  await step2(r);
  await step3(r);
  await step4(r);
  await step5(r);
  await step6(r);
  await step7(r, { nativeTemplateQueries: false });
  await step8(r);
  await step9(r);
  if (MODE === 'db') await step10db(r);
  await stepVerify(r);
}

export async function maintVerifySchema(r: Result): Promise<void> {
  await stepVerify(r);
}
