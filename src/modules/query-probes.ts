import { pluginPropertyIdent, resolvePropertyQueryName } from '../core/db-properties';

type DatascriptProbeAttempt = {
  label: string;
  query: string;
  inputs: unknown[];
};

async function runDatascriptProbe(attempt: DatascriptProbeAttempt): Promise<unknown[]> {
  if (!logseq.DB?.datascriptQuery) return [];
  try {
    const results = await logseq.DB.datascriptQuery(attempt.query, ...attempt.inputs);
    return Array.isArray(results) ? results : [];
  } catch {
    return [];
  }
}

function ventureDatascriptAttempts(
  venturePageId: number,
  venturePageName: string,
  objectTypeValue: string,
  ventureAttrs: string[],
  typeAttrs: string[],
): DatascriptProbeAttempt[] {
  const pageName = venturePageName.trim().toLowerCase();
  const typeValues = [...new Set([objectTypeValue, objectTypeValue.toLowerCase()])];
  const attempts: DatascriptProbeAttempt[] = [];

  const add = (label: string, where: string, inputs: unknown[] = []) => {
    const inVars = inputs.map((_, i) => `?in${i}`).join(' ');
    const inClause = inVars ? ` $ ${inVars}` : ' $';
    attempts.push({
      label,
      query: `[:find (pull ?b [:block/uuid :block/title :block/name :block/original-name])
 :in${inClause}
 :where
 ${where}]`,
      inputs,
    });
  };

  for (const ventureAttr of ventureAttrs) {
    add(
      `tag-${objectTypeValue}+entity-id:${ventureAttr}`,
      `[?b :block/tags ?tag]
 [?tag :block/title ${JSON.stringify(objectTypeValue)}]
 [?b ${ventureAttr} ?in0]`,
      [venturePageId],
    );
    if (pageName) {
      add(
        `tag-${objectTypeValue}+page-name:${ventureAttr}`,
        `[?b :block/tags ?tag]
 [?tag :block/title ${JSON.stringify(objectTypeValue)}]
 [?b ${ventureAttr} ?val]
 [?val :block/name ?in0]`,
        [pageName],
      );
    }
    for (const typeAttr of typeAttrs) {
      for (const typeVal of typeValues) {
        add(
          `entity-id+type:${ventureAttr}/${typeAttr}/${typeVal}`,
          `[?b ${ventureAttr} ?in0]
 [?b ${typeAttr} ${JSON.stringify(typeVal)}]`,
          [venturePageId],
        );
        if (pageName) {
          add(
            `page-name+type:${ventureAttr}/${typeAttr}/${typeVal}`,
            `[?ftv :block/name ?in0]
 [?b ${ventureAttr} ?ftv]
 [?b ${typeAttr} ${JSON.stringify(typeVal)}]`,
            [pageName],
          );
          add(
            `ref-name+type:${ventureAttr}/${typeAttr}/${typeVal}`,
            `[?b ${ventureAttr} ?val]
 [?val :block/name ?in0]
 [?b ${typeAttr} ${JSON.stringify(typeVal)}]`,
            [pageName],
          );
          add(
            `ref-title+type:${ventureAttr}/${typeAttr}/${typeVal}`,
            `[?b ${ventureAttr} ?val]
 [?val :block/title ?in0]
 [?b ${typeAttr} ${JSON.stringify(typeVal)}]`,
            [pageName],
          );
        }
      }
    }
    add(`entity-id-only:${ventureAttr}`, `[?b ${ventureAttr} ?in0]`, [venturePageId]);
    if (pageName) {
      add(
        `page-name-only:${ventureAttr}`,
        `[?ftv :block/name ?in0]
 [?b ${ventureAttr} ?ftv]`,
        [pageName],
      );
      add(
        `ref-name-only:${ventureAttr}`,
        `[?b ${ventureAttr} ?val]
 [?val :block/name ?in0]`,
        [pageName],
      );
    }
  }

  for (const typeVal of typeValues) {
    for (const typeAttr of typeAttrs) {
      add(
        `type-only:${typeAttr}/${typeVal}`,
        `[?b ${typeAttr} ${JSON.stringify(typeVal)}]`,
        [],
      );
    }
    add(
      `tag-function+type:${typeVal}`,
      `[?b :block/tags ?tag]
 [?tag :block/title "Function"]
 [?b ${typeAttrs[0]} ${JSON.stringify(typeVal)}]`,
      [],
    );
  }

  add(
    'tag-function-only',
    `[?b :block/tags ?tag]
 [?tag :block/title "Function"]`,
    [],
  );

  return attempts;
}

export async function datascriptVentureChildProbe(
  venturePageId: number,
  objectTypeValue: string,
  venturePageName = '',
): Promise<unknown[]> {
  const report = await datascriptVentureProbeReport(venturePageId, objectTypeValue, venturePageName);
  return report.hits;
}

export async function datascriptVentureProbeReport(
  venturePageId: number,
  objectTypeValue: string,
  venturePageName = '',
): Promise<{ hits: unknown[]; matchedLabel: string | null; attempts: Array<{ label: string; count: number }> }> {
  if (!logseq.DB?.datascriptQuery) {
    return { hits: [], matchedLabel: null, attempts: [] };
  }
  const ventureAttrs = [
    ...new Set([
      await resolvePropertyQueryName('venture'),
      pluginPropertyIdent('venture'),
    ]),
  ];
  const typeAttrs = [
    ...new Set([
      await resolvePropertyQueryName('lss-object-type'),
      pluginPropertyIdent('lss-object-type'),
    ]),
  ];
  const attempts = ventureDatascriptAttempts(
    venturePageId,
    venturePageName,
    objectTypeValue,
    ventureAttrs,
    typeAttrs,
  );
  const counts: Array<{ label: string; count: number }> = [];

  for (const attempt of attempts) {
    const hits = await runDatascriptProbe(attempt);
    counts.push({ label: attempt.label, count: hits.length });
    if (hits.length) {
      return { hits, matchedLabel: attempt.label, attempts: counts };
    }
  }

  return { hits: [], matchedLabel: null, attempts: counts };
}

export async function datascriptInspectBlock(uuid: string): Promise<Record<string, unknown> | null> {
  if (!logseq.DB?.datascriptQuery || !uuid) return null;
  const query = `[:find (pull ?b [*])
 :in $ ?buuid
 :where
 [?b :block/uuid ?buuid]]`;
  try {
    const results = await logseq.DB.datascriptQuery(query, `#uuid "${uuid}"`);
    const row = Array.isArray(results) ? results[0] : null;
    if (!row) return null;
    return (Array.isArray(row) ? row[0] : row) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function datascriptInspectEntityId(
  entityId: number | string,
): Promise<Record<string, unknown> | null> {
  if (!logseq.DB?.datascriptQuery) return null;
  const id = Number(entityId);
  if (!Number.isFinite(id) || id <= 0) return null;
  const query = `[:find (pull ?b [*])
 :in $ ?eid
 :where
 [?b :db/id ?eid]]`;
  try {
    const results = await logseq.DB.datascriptQuery(query, id);
    const row = Array.isArray(results) ? results[0] : null;
    if (!row) return null;
    return (Array.isArray(row) ? row[0] : row) as Record<string, unknown>;
  } catch {
    return null;
  }
}
