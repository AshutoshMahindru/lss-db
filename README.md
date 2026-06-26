# LSS DB Final Plugin v2.0.15

Modular TypeScript rewrite of the LSS DB Final plugin. The monolithic `index.ts` has been split into focused modules under `src/` while keeping the full `registry.json` build-pack unchanged.

LSS DB turns Logseq DB pages into a typed knowledge graph. The current operating model is tag-first: create or open a page, add one primary LSS type tag, and let the plugin render the page properties, native sections, and query sections from the registry. `lss: materialise page` remains the explicit repair/sync command for stale pages, legacy journal captures, and incomplete query blocks.

## Architecture

```text
src/
  config.ts              MODE, VERSION, THROTTLE_MS
  registry/              registry.json helpers + types
  core/                  Result type, names, editor, runner
  modules/
    contracts.ts         schema contract text generators
    setup.ts             commands 1-13
    create.ts            commands 14-32 plus lss:52 Function page creation
    queries.ts           public facade re-exporting the split query modules
    query-builders.ts    dashboard/simple/advanced query builders with current-page fallbacks and Datalog DB relationship filters
    query-edn.ts         query content normalization, equivalence, and repair drift checks
    query-probes.ts      Datascript probe helpers for dashboard/query diagnostics
    dashboard-query-repair.ts query-block discovery, content reads, scoring, and canonical selection
    dashboard-query-views.ts registry/template view derivation for dashboard sections
    advanced-query-blocks.ts Logseq DB #Query adapter: host-scope setup, query child inspection, structure repair
    repair.ts            repair tagged pages, materialize journal entity blocks, promote page tags/properties
    repair-dashboard.ts  dashboard query repair runner and linked parent dashboard refresh
    diagnose.ts          current-page diagnostic report assembly
    diagnose-journal.ts  journal materialization status diagnostics
    diagnose-native-tags.ts native tag schema pollution diagnostics
    diagnose-query-probes.ts live query and Datascript probe helpers for diagnostics
    native-tag-cleanup.ts dedicated native tag schema cleanup command
    audit.ts             structured page audit (ERROR/WARNING/INFO) using RegistryObject required props
    migration.ts         dry-run normalize, relationship conversion, and namespaced migration plans
    dashboard.ts         insert dashboards with DB advanced-query blocks
    export.ts            snapshot, export, weekly review
    navigation.ts        commands 45-49, help, command list, layer homes
  commands/register.ts   numbered lss: commands + LSS: spec aliases
  index.ts               thin entry point
```

## Command principles

- Setup/install commands come first (1-13).
- Creation and insertion commands come next (14-32), with `lss: 52new-function` added for the missing Function page entity.
- Registry-backed creation aliases cover every `entityTypes`, `formTypes`, and `wordExtenderTypes` entry without renumbering the stable command set:
  - `lss: new-regime`, `lss: new-financial-asset`, `lss: new-term`, etc. create placeholder pages.
  - `lss: insert-event`, `lss: insert-weekly-review`, `lss: insert-work-stream-update`, etc. insert form blocks at the cursor.
- Maintenance/update commands come last (33-57), plus the explicit materialization/repair command.
- Numbered `lss:` commands and human-readable `LSS:` aliases map to the same handlers.
- Scaffold/control pages use flat-safe names (`Area/Cross-Cutting` → `Area - Cross-Cutting`) and store canonical slash names as metadata.

## Key v2.0 fixes

1. DB dashboard and entity-page queries use native Logseq DB query blocks: a visible `#Query` parent, a `logseq.property/query` child, and EDN query payloads.
2. Multi-tag and multi-property dashboard views use `or` semantics, so sections like Outputs and People do not require every possible tag/property at once.
3. `lss: 38normalize-properties`, `lss: 39convert-text-relationships`, and `lss: 40migrate-namespaced-objects` now write dry-run plans to `LSS Migrations` instead of mutating content immediately.
4. Relationship query filters on DB graphs use Datalog for node-reference properties because the Logseq DSL `property` operator is unreliable for DB node props.
5. `lss: materialise page` repairs/syncs tagged LSS pages or journal captures, ensures page-root properties from the RegistryObject tag, and repairs native query block structure.
6. Managed entity page sections are grouped as `NATIVE SECTIONS`, `RELATED ENTITIES`, `GENERIC ENTITIES`, `FORMS`, `REVIEWS`, and `DATES`.
7. Same-family relationship queries include parent, child, and sibling entity types, while generic entity and form queries are generated separately and deduped.

## Runtime safety

- Auto-repair is disabled by default. Enable the plugin setting **Enable LSS auto-repair** only if you want background sync after graph changes.
- Manual materialization and auto-repair should not race. Manual repair clears pending auto-repair for the current page, and auto-repair defers while manual repair is active.
- Migration-style commands are dry-run by default and produce review-required reports.
- The graph remains the source of truth; the plugin assists with setup, repair, audit, migration planning, and export.

## White paper

The detailed operating model is documented in [docs/LSS_DB_WHITE_PAPER.md](docs/LSS_DB_WHITE_PAPER.md). It covers the typed graph model, tag-first page rendering, placeholder policy, page-section contract, native DB query architecture, journal materialization, setup commands, and troubleshooting guidance.

## Property schema source of truth (RegistryObject / entity page)

**RegistryObject defines canonical properties, and entity pages are where those properties are rendered or repaired.**

- `requiredProperties` + `properties` on an object type in `src/registry/data.json` define the schema.
- Creation (`new-venture`, `new-function`, etc.), tag-driven rendering, materialization (`lss: materialise page`), and native template installation all call `uniqueObjectProps(obj)` and `defaultPropertyValue(...)` sourced **only** from the matching RegistryObject.
- `lss-object-type::` is still written for compatibility/fallback detection, but the authoritative classifier on DB graphs is the class **#tag** (e.g. `#Function`, `(tags "Function")`).
- **Templates never contribute property schema.** `RegistryTemplate.body` contains only:
  - The root title line
  - Structural section headings (for requiredSections + dashboard query insertion)
- Any `foo::` lines that used to live inside template bodies have been stripped. The data.json `decisions` record this rule explicitly (`tagIsSolePropertySchemaSource`, `templateBodyIsLayoutAndSectionsOnly`).
- Native Logseq tag properties are not used for LSS entity schema fields. Setup removes entity schema properties from native tags so tagging a journal block does not display schema fields on the journal page.
- Old instances get the full set of properties ensured on next tag-driven repair/materialization, and polluted journal capture blocks can be materialized and cleaned by `lss: materialise page`.
- Repair writes schema values as native page properties and cleans visible schema property lines from page/block bodies instead of maintaining duplicate `prop::` mirror blocks.
- Node-valued relationship fields use managed placeholder refs such as `[[LSS Placeholder - Venture]]` when no real target is known. Placeholders are intentional selector anchors and are removed by explicitly unchecking them after selecting real entities.

Rationale: avoids duplication, keeps tags as class labels, keeps templates as pure "layout + query" scaffolds, and prevents native tag properties from appearing on journal capture blocks.

## Recommended setup sequence

Run either:

```text
lss: 1setup-all
```

or, for safer step-by-step setup:

```text
lss: 2setup-bootstrap
lss: 3setup-areas
lss: 4setup-schema-pages
lss: 5setup-db-tags
lss: 6setup-tag-properties
lss: 7setup-relationships
lss: 8setup-templates
lss: 9setup-dashboards
lss: 10setup-word-extenders
lss: 11setup-db-native-config
lss: 12setup-page-tree
lss: 13verify-schema
```

Optional navigation helpers after setup:

```text
lss: 46create-simple-page-tree-page
lss: 47create-command-list-page
lss: 48create-layer-home-pages
lss: 49add-layer-links-to-home
```

`lss: 46create-simple-page-tree-page` also creates `LSS Area Model`, a generated navigation page that renders the Area → Entity/Form/Word Extender model, contextual tag families, templates, DB tags, and tag-property contract pages.

## Spec aliases (examples)

- `LSS: Initialize Schema` → `lss: 1setup-all`
- `LSS: Verify Schema` → `lss: 13verify-schema`
- `LSS: Audit Current Page` → `lss: 33audit-current-page`
- `LSS: Insert Venture Dashboard` → `lss: 35insert-venture-dashboard`
- `LSS: Normalize Properties` → `lss: 38normalize-properties`
- `LSS: Materialise Page` → `lss: materialise page`
- `LSS: New Function` → `lss: 52new-function`
- `LSS: Clean Native Tag Schema Properties` → `lss: 54clean-native-tag-schema-properties`
- `lss: 57repair-related-to-display-order` repairs native property order so specific relationship fields render before generic `related-to`.

## Template note

Templates are layout-only: ordinary note sections stay under `NATIVE SECTIONS`, while view-backed sections materialize as direct titled query blocks under `RELATED ENTITIES`, `GENERIC ENTITIES`, `FORMS`, `REVIEWS`, and `DATES`. The obsolete body section `PROPERTIES` is not rendered because Logseq DB already displays page properties in the native property panel.

`Apply template to tags` is disabled for DB entity templates so tagging a journal block does not make that journal block the entity. Properties are injected onto the entity page root from the RegistryObject that matches the `appliesTo` tag.

For template setup, open `LSS Native Templates`, create an empty block, click inside it, and run `lss: 8setup-templates`. Re-run to remove old tag-applied template settings and re-sync missing structure/query blocks. If an entity was tagged on a journal page, run `lss: materialise page` on that journal; it will create/update the entity page and replace the journal tag block with a page link.

## Query note

DB query sections should be native Logseq query blocks, not ordinary code blocks and not raw EDN stored on the parent. A healthy query has:

```text
visible query block with #Query tag
logseq.property/query -> query child
query child contains EDN
query child created-from-property = query
query child display-type = :code
query child code/lang = clojure
```

For relationship filters, generated DB queries prefer Datalog and page ids/current-page inputs. This is what makes a page like `T32 Function` appear in `BGG Venture` after `T32.venture` is set to `BGG`.

## Build

The repo includes a public-registry `package-lock.json` and `.npmrc`.

```bash
npm ci
npm run build
npm run package   # optional zip of the root plugin contents
```

Load the plugin from `/Users/ashutoshmahindru/Documents/LSS-DB` in Logseq (Developer mode → Load unpacked plugin). The repo root is the plugin folder; `release/` is only for an optional zip artifact.

## Build status

v2.0.15 query stability pass — DB query blocks remain visible page-level `#Query` blocks, carry EDN in the native query child, use Datalog for node-reference relationship filters, preserve titles, and avoid destructive rebuilds once renderable query structure exists.
