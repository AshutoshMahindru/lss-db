# LSS DB Final Plugin v2.0.0

Modular TypeScript rewrite of the LSS DB Final plugin. The monolithic `index.ts` has been split into focused modules under `src/` while keeping the full `registry.json` build-pack unchanged.

## Architecture

```text
src/
  config.ts              MODE, VERSION, THROTTLE_MS
  registry/              registry.json helpers + types
  core/                  Result type, names, editor, runner
  modules/
    contracts.ts         schema contract text generators
    setup.ts             commands 1-13
    create.ts            commands 14-32
    queries.ts           dashboard/advanced query builders (tag-based class match + hardcoded id for current page binding on DB)
    repair.ts            promote tags + properties (from RegistryObject only), dashboard query repair
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
- Creation and insertion commands come next (14-32).
- Maintenance/update commands come last (33-50).
- Numbered `lss:` commands and human-readable `LSS:` aliases map to the same handlers.
- Scaffold/control pages use flat-safe names (`Area/Cross-Cutting` → `Area - Cross-Cutting`) and store canonical slash names as metadata.

## Key v2.0 fixes

1. DB dashboard queries use native advanced-query blocks, DB tag clauses, current-page DB ids where available, and current Logseq DB property filters.
2. Multi-tag and multi-property dashboard views use `or` semantics, so sections like Outputs and People do not require every possible tag/property at once.
3. `lss: 38normalize-properties`, `lss: 39convert-text-relationships`, and `lss: 40migrate-namespaced-objects` now write dry-run plans to `LSS Migrations` instead of mutating content immediately.
4. `lss: 50repair-current-page` is now mainly a recovery tool. Property schema is ensured at creation time from the RegistryObject (tag). Dashboard queries are installed by insert commands and can be repaired manually with 50.

## Runtime safety

- Auto-repair is disabled by default. Enable the plugin setting **Enable LSS auto-repair** only if you want background sync after graph changes.
- Migration-style commands are dry-run by default and produce review-required reports.
- The graph remains the source of truth; the plugin assists with setup, repair, audit, migration planning, and export.

## Property schema source of truth (tag / RegistryObject)

**RegistryObject (via its `tag`) is the single source of canonical properties for all entities, forms, and word extenders.**

- `requiredProperties` + `properties` on an object type in `src/registry/data.json` define the schema.
- Creation (`new-venture` etc.), repair (`lss:50`), and native template installation all call `uniqueObjectProps(obj)` and `defaultPropertyValue(...)` sourced **only** from the matching RegistryObject.
- `lss-object-type::` is still written for compatibility/fallback detection, but the authoritative classifier on DB graphs is the class **#tag** (e.g. `#Function`, `(tags "Function")`).
- **Templates never contribute property schema.** `RegistryTemplate.body` contains only:
  - The root title line
  - Structural section headings (for requiredSections + dashboard query insertion)
- Any `foo::` lines that used to live inside template bodies have been stripped. The data.json `decisions` record this rule explicitly (`tagIsSolePropertySchemaSource`, `templateBodyIsLayoutAndSectionsOnly`).
- Old instances get the full set of properties ensured on next repair.

Rationale: avoids duplication, makes the tag the classifier+schema carrier (matching how Logseq DB tags work), and keeps templates as pure "layout + query" scaffolds.

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

## Spec aliases (examples)

- `LSS: Initialize Schema` → `lss: 1setup-all`
- `LSS: Verify Schema` → `lss: 13verify-schema`
- `LSS: Audit Current Page` → `lss: 33audit-current-page`
- `LSS: Insert Venture Dashboard` → `lss: 35insert-venture-dashboard`
- `LSS: Normalize Properties` → `lss: 38normalize-properties`
- `LSS: Repair Current Page` is available as `lss: 50repair-current-page`

## Template note

Templates are layout-only (sections + #Query children). Properties are injected from the RegistryObject that matches the `appliesTo` tag.

For template setup, open `LSS Native Templates`, create an empty block, click inside it, and run `lss: 8setup-templates`. This keeps Logseq indexing closer to manual paste behavior. Re-run to re-sync any missing canonical property lines under roots.

## Build

The repo includes a public-registry `package-lock.json` and `.npmrc`.

```bash
npm ci
npm run build
npm run package   # optional release zip
```

Load the plugin from the project directory in Logseq (Developer mode → Load unpacked plugin).

## Build status

v2.0.0 modular rewrite — TypeScript modules with registry-driven queries, audit, and repair.
