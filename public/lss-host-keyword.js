// Runs in Logseq host scope (via Experiments.loadScripts).
// Plugin IPC cannot pass cljs keywords; this helper keeps to_keyword + upsert in-host.
(function () {
  if (typeof window.__lssUpsertKeywordProperty === 'function') return;
  window.__lssUpsertKeywordProperty = function (blockId, key, keywordName) {
    const toKw = logseq.sdk.utils.to_keyword;
    const upsert = logseq.api.upsert_block_property;
    const raw = String(keywordName ?? '').trim().replace(/^:/, '');
    if (!raw) throw new Error('empty keyword name');
    return upsert(blockId, key, toKw(raw));
  };
})();