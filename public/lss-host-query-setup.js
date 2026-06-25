// Runs in Logseq host scope (via Experiments.loadScripts).
// Mirrors /Advanced Query slash steps from commands.cljs:
//   block/tags Query, logseq.property/query "", child display-type :code, code/lang clojure.
(function () {
  if (typeof window.__lssConfigureDbAdvancedQuery === 'function') return;

  var QUERY_CLASS = 'logseq.class/Query';
  var QUERY_PROP = 'logseq.property/query';
  var DISPLAY_TYPE = 'logseq.property.node/display-type';
  var CODE_LANG = 'logseq.property.code/lang';
  var COLLAPSED = 'block/collapsed?';

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
      return await window.__lssUpsertKeywordProperty(
        target,
        DISPLAY_TYPE,
        'code',
      );
    }
    return await upsertProp(target, DISPLAY_TYPE, toKw('code'));
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
    return await logseq.api.upsert_block_property(blockId, key, value);
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
      return await logseq.api.update_block(blockId, title);
    }
    if (logseq.api && logseq.api.edit_block) {
      return await logseq.api.edit_block(blockId, title);
    }
    throw new Error('logseq.api.update_block/edit_block unavailable');
  }

  function readQueryChild(parent) {
    if (!parent) return null;
    return parent[QUERY_PROP] ?? parent[':' + QUERY_PROP] ?? null;
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
      var cid = entityId(c);
      if (cid != null) return { parent: p, childEnt: c, childId: cid };
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

    await upsertProp(parentId, 'block/tags', toKw(QUERY_CLASS));

    var childEnt = readQueryChild(parent);
    var childId = entityId(childEnt);
    if (childId == null) {
      await upsertProp(parentId, QUERY_PROP, '');
      var waited = await waitForChild(parentId, parentUuid);
      if (waited) {
        parent = waited.parent;
        childEnt = waited.childEnt;
        childId = waited.childId;
      }
    }
    if (childId == null && logseq.api && logseq.api.insert_block) {
      try {
        var inserted = await logseq.api.insert_block(parentId, '', { sibling: false, before: false, end: true });
        childId = entityId(inserted);
        childEnt = inserted;
      } catch (_e) {}
    }
    if (childId == null) {
      throw new Error('logseq.property/query child was not created');
    }

    childEnt = (await getBlock(childId)) || childEnt;
    var childRef = blockUuid(childEnt) || childId;
    var parentRef = blockUuid(parent) || parentId;
    await upsertProp(childRef, CODE_LANG, 'clojure');
    await upsertProp(parentRef, QUERY_PROP, childId);
    try {
      await updateBlockTitle(childRef, edn);
      if (rawQueryParentContent(parent)) await updateBlockTitle(parentRef, '');
    } catch (titleError) {
      /* title may already be set by plugin IPC; display-type is the critical UI field */
    }
    // Set display :code late, after titles (more reliable for DB graphs)
    await upsertDisplayTypeCode(childEnt, childId);
    await new Promise(r => setTimeout(r, 60));
    await upsertDisplayTypeCode(childEnt, childId);
    await new Promise(r => setTimeout(r, 60));
    await upsertDisplayTypeCode(childEnt, childId);
    await upsertProp(parentRef, COLLAPSED, false);

    return { ok: true, parentId: parentId, childId: childId, childUuid: blockUuid(childEnt) };
  };
})();
