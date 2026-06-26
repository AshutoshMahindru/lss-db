// Runs in Logseq host scope (via Experiments.loadScripts).
// Configures native DB query blocks by tagging the block as Query and storing
// the EDN query string in Logseq's query value/code child. The parent
// logseq.property/query value must point at that child by db id.
(function () {
  var QUERY_CLASS = 'logseq.class/Query';
  var QUERY_PROP = 'logseq.property/query';
  var QUERY_PROP_UUID = '00000002-9741-4126-0000-000000000000';
  var CREATED_FROM_PROP = 'logseq.property/created-from-property';
  var DISPLAY_TYPE = 'logseq.property.node/display-type';
  var CODE_LANG = 'logseq.property.code/lang';
  var COLLAPSED = 'block/collapsed?';
  var HOST_TIMEOUT = 900;

  async function withTimeout(value, label, ms) {
    var timer = null;
    try {
      return await Promise.race([
        Promise.resolve(value),
        new Promise(resolve => {
          timer = setTimeout(() => resolve(undefined), ms || HOST_TIMEOUT);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function toKw(name) {
    var utils = logseq.sdk && logseq.sdk.utils;
    var fn = (utils && (utils.to_keyword || utils.toKeyword)) || null;
    if (!fn) throw new Error('logseq.sdk.utils.to_keyword unavailable');
    return fn(String(name ?? '').trim().replace(/^:/, ''));
  }

  function blockUuid(ent) {
    if (!ent || typeof ent !== 'object') return null;
    var raw = ent[':block/uuid'] ?? ent.uuid ?? ent.blockUuid ?? null;
    return raw != null ? String(raw) : null;
  }

  async function upsertDisplayTypeCode(childEnt, childId) {
    var childUuid = blockUuid(childEnt);
    var target = childUuid || childId;
    if (typeof window.__lssUpsertKeywordProperty === 'function') {
      return await withTimeout(
        window.__lssUpsertKeywordProperty(target, DISPLAY_TYPE, 'code'),
        'display-type upsert',
      );
    }
    return await upsertProp(target, DISPLAY_TYPE, toKw('code'));
  }

  async function upsertCreatedFromQuery(childEnt, childId) {
    var childUuid = blockUuid(childEnt);
    var target = childUuid || childId;
    var values = [toKw(QUERY_PROP), QUERY_PROP, QUERY_PROP_UUID, 48];
    var lastError = null;
    for (var i = 0; i < values.length; i++) {
      try {
        return await upsertProp(target, CREATED_FROM_PROP, values[i]);
      } catch (e) {
        lastError = e;
      }
    }
    if (lastError) throw lastError;
  }

  function entityId(ent) {
    if (ent == null) return null;
    if (typeof ent === 'number') return ent;
    if (typeof ent === 'string' && /^\d+$/.test(ent.trim())) return Number(ent);
    if (typeof ent === 'object') return ent.id ?? ent.dbId ?? ent[':db/id'] ?? null;
    return null;
  }

  async function upsertProp(blockId, key, value) {
    if (!logseq.api || !logseq.api.upsert_block_property) {
      throw new Error('logseq.api.upsert_block_property unavailable');
    }
    return await withTimeout(
      logseq.api.upsert_block_property(blockId, key, value),
      key + ' upsert',
    );
  }

  async function getBlock(uuidOrId) {
    if (logseq.api && logseq.api.get_block) {
      try {
        return await logseq.api.get_block(uuidOrId);
      } catch (_e) {
        /* try next */
      }
    }
    if (logseq.api && logseq.api.datascript_query && typeof uuidOrId === 'string' && uuidOrId.length >= 32) {
      var q =
        '[:find (pull ?b [*]) :in $ ?buuid :where [?b :block/uuid ?buuid]]';
      var rows = await logseq.api.datascript_query(q, '#uuid "' + uuidOrId + '"');
      if (rows && rows[0] && rows[0][0]) return rows[0][0];
    }
    return null;
  }

  async function updateBlockTitle(blockId, title) {
    if (logseq.api && logseq.api.update_block) {
      return await withTimeout(logseq.api.update_block(blockId, title), 'update block');
    }
    if (logseq.api && logseq.api.edit_block) {
      return await withTimeout(logseq.api.edit_block(blockId, title), 'edit block');
    }
    throw new Error('logseq.api.update_block/edit_block unavailable');
  }

  async function expandBlock(blockId) {
    if (logseq.api && logseq.api.set_block_collapsed) {
      await withTimeout(logseq.api.set_block_collapsed(blockId, false), 'expand block');
      return true;
    }
    return false;
  }

  async function insertQueryChild(parentRef, parentId, edn) {
    if (!logseq.api || !logseq.api.insert_block) return { childEnt: null, childId: null };
    var inserted = await withTimeout(
      logseq.api.insert_block(parentRef, edn, { sibling: false, before: false, end: true }),
      'insert query child',
      1500,
    );
    await new Promise(r => setTimeout(r, 120));
    var childEnt = inserted && typeof inserted === 'object' ? inserted : null;
    var childId = entityId(childEnt);
    if (childId == null && logseq.api.datascript_query) {
      try {
        var rows = await logseq.api.datascript_query(
          '[:find (pull ?c [*]) :in $ ?p ?title :where [?c :block/parent ?p] [?c :block/title ?title]]',
          parentId,
          edn,
        );
        childEnt = rows && rows[0] && rows[0][0] ? rows[0][0] : null;
        childId = entityId(childEnt);
      } catch (_e) {}
    }
    return { childEnt: childEnt, childId: childId };
  }

  function readQueryChild(parent) {
    if (!parent) return null;
    return parent[QUERY_PROP] ?? parent[':' + QUERY_PROP] ?? null;
  }

  function looksUuid(value) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value ?? '').trim());
  }

  function createdFromIsQuery(value) {
    if (value == null) return false;
    if (Array.isArray(value)) return value.some(createdFromIsQuery);
    if (typeof value === 'object') {
      var id = value.id ?? value.dbId ?? value[':db/id'] ?? value['db/id'];
      if (Number(id) === 48) return true;
      var ident = String(value.ident ?? value[':db/ident'] ?? value['db/ident'] ?? '').replace(/^:/, '');
      if (ident === QUERY_PROP) return true;
      var title = String(value.title ?? value[':block/title'] ?? value['block/title'] ?? '').trim().toLowerCase();
      return title === 'query';
    }
    var raw = String(value).trim().replace(/^:/, '');
    return raw === QUERY_PROP || raw === QUERY_PROP_UUID || raw === '48' || raw.toLowerCase() === 'query';
  }

  async function resolveQueryChild(raw) {
    var id = entityId(raw);
    if (id == null) return { childEnt: null, childId: null };
    var ent = (await getBlock(id)) || raw;
    var text = String((ent && (ent[':block/content'] ?? ent.content ?? ent.title)) ?? '').trim();
    if (/^\s*\{[\s\S]*:query\s+(?:\[:find|\()/i.test(text)) {
      return { childEnt: ent, childId: id };
    }
    if (looksUuid(text) || /^\d+$/.test(text)) {
      var actual = await getBlock(text);
      if (actual) return { childEnt: actual, childId: entityId(actual) ?? text };
      return { childEnt: null, childId: null };
    }
    return { childEnt: ent, childId: entityId(ent) ?? id };
  }

  function codeChildIsExecutable(ent) {
    var text = String((ent && (ent[':block/content'] ?? ent.content ?? ent.title)) ?? '').trim();
    var display = ent && (ent[DISPLAY_TYPE] ?? ent[':' + DISPLAY_TYPE]);
    var lang = ent && (ent[CODE_LANG] ?? ent[':' + CODE_LANG]);
    return /^\s*\{[\s\S]*:query\s+(?:\[:find|\()/i.test(text) &&
      String(display ?? '').replace(/^:/, '').toLowerCase() === 'code' &&
      String(lang ?? '').toLowerCase() === 'clojure';
  }

  async function activeQueryValueIds(parent) {
    var keep = {};
    var raw = readQueryChild(parent);
    var current = raw;
    for (var i = 0; i < 6; i++) {
      var id = entityId(current);
      var ent = id != null ? ((await getBlock(id)) || current) : current;
      var entId = entityId(ent) ?? id;
      var entUuid = blockUuid(ent);
      if (entId != null) keep[String(entId)] = true;
      if (entUuid) keep[String(entUuid)] = true;
      var text = String((ent && (ent[':block/content'] ?? ent.content ?? ent.title)) ?? current ?? '').trim();
      if (!(looksUuid(text) || /^\d+$/.test(text))) break;
      var next = await getBlock(text);
      if (!next) break;
      current = next;
    }
    return keep;
  }

  async function removeObsoleteQueryValueChildren(parentId, keepIds) {
    if (!logseq.api || !logseq.api.datascript_query || !logseq.api.remove_block) return;
    var q = '[:find (pull ?c [*]) :in $ ?p :where [?c :block/parent ?p] [?c :logseq.property/created-from-property ?prop]]';
    var rows = [];
    try { rows = await logseq.api.datascript_query(q, parentId); } catch (_e) { return; }
    for (var i = 0; i < rows.length; i++) {
      var ent = rows[i] && rows[i][0];
      if (!ent) continue;
      var createdFrom = ent[CREATED_FROM_PROP] ?? ent[':' + CREATED_FROM_PROP] ?? ent[':logseq.property/created-from-property'];
      if (!createdFromIsQuery(createdFrom)) continue;
      var id = blockUuid(ent) || entityId(ent);
      var entityKey = entityId(ent);
      var uuidKey = blockUuid(ent);
      if ((entityKey != null && keepIds[String(entityKey)]) || (uuidKey && keepIds[String(uuidKey)])) continue;
      if (id != null) {
        try { await withTimeout(logseq.api.remove_block(id), 'remove obsolete query child'); } catch (_removeError) {}
      }
    }
  }

  function rawQueryParentContent(parent) {
    var text = String((parent && (parent[':block/content'] ?? parent.content ?? parent.title)) ?? '').trim();
    return /^\s*\{[\s\S]*:query\s+(?:\[:find|\()/i.test(text) || /#\+BEGIN_QUERY/i.test(text);
  }

  async function waitForChild(pId, pUuid, maxTries = 6) {
    for (let i = 0; i < maxTries; i++) {
      await new Promise(r => setTimeout(r, 80));
      var p = await getBlock(pUuid);
      var c = readQueryChild(p);
      var resolved = await resolveQueryChild(c);
      var cid = resolved.childId;
      if (cid != null) return { parent: p, childEnt: resolved.childEnt, childId: cid };
    }
    return null;
  }

  window.__lssConfigureDbAdvancedQuery = async function (parentUuid, ednContent) {
    var edn = String(ednContent ?? '').trim();
    if (!edn) throw new Error('empty EDN');

    var parent = await getBlock(parentUuid);
    if (!parent) throw new Error('parent block not found: ' + parentUuid);
    var parentId = entityId(parent);
    if (parentId == null) throw new Error('parent block has no entity id');

    var parentRef = blockUuid(parent) || parentId;
    await upsertProp(parentRef, 'block/tags', toKw(QUERY_CLASS));
    var resolved = await resolveQueryChild(readQueryChild(parent));
    var childEnt = resolved.childEnt;
    var childId = resolved.childId;
    if (childId == null) {
      var created = await insertQueryChild(parentRef, parentId, edn);
      childEnt = created.childEnt;
      childId = created.childId;
    }
    if (childId == null) {
      throw new Error('query child block could not be inserted');
    }
    childEnt = (await getBlock(childId)) || childEnt;
    var childRef = blockUuid(childEnt) || childId;
    await updateBlockTitle(childRef, edn);
    await upsertCreatedFromQuery(childEnt, childRef);
    await upsertDisplayTypeCode(childEnt, childRef);
    await upsertProp(childRef, CODE_LANG, 'clojure');
    var childDbId = entityId(childEnt) ?? entityId(await getBlock(childId)) ?? childId;
    await upsertProp(parentRef, QUERY_PROP, childDbId);
    await expandBlock(parentRef);
    var keepIds = await activeQueryValueIds(await getBlock(parentRef) || parent);
    keepIds[String(childId)] = true;
    keepIds[String(childDbId)] = true;
    keepIds[String(childRef)] = true;
    var childUuid = blockUuid(childEnt);
    if (childUuid) keepIds[String(childUuid)] = true;
    await removeObsoleteQueryValueChildren(parentId, keepIds);

    return { ok: true, parentId: parentId, childId: childDbId, childUuid: childUuid || null };
  };

  var _origSetup = window.__lssConfigureDbAdvancedQuery;
  window.__lssConfigureDbAdvancedQuery = async function (parentUuid, ednContent) {
    var result = await _origSetup(parentUuid, ednContent);
    try {
      var updated = await getBlock(parentUuid);
      if (updated) {
        var keepIds = await activeQueryValueIds(updated);
        if (result && result.childId != null) keepIds[String(result.childId)] = true;
        if (result && result.childUuid) keepIds[String(result.childUuid)] = true;
        await removeObsoleteQueryValueChildren(entityId(updated), keepIds);
      }
    } catch (_e) {}
    return result;
  };
})();
