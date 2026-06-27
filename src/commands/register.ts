import { TITLE, VERSION } from '../config';
import { run } from '../core/runner';
import { registryCreationCommands } from './registry-create';
import { auditCurrentPage, auditGraph } from '../modules/audit';
import {
  insertRegistryFormBlock,
  insertActionItem,
  insertDashboardSection,
  insertDecision,
  insertIdea,
  insertInsight,
  insertInteraction,
  insertNote,
  insertQuestion,
  insertReview,
  insertWordExtender,
  newRegistryPage,
  newCondition,
  newDocument,
  newFunction,
  newOrganisation,
  newPerson,
  newProject,
  newPursuit,
  newSubject,
  newVenture,
  newWorkStream,
} from '../modules/create';
import {
  insertAreaDashboard,
  insertProjectDashboard,
  insertVentureDashboard,
} from '../modules/dashboard';
import { expandAbbreviation, exportCurrentPageReport, generateWeeklyReview, snapshotDashboard } from '../modules/export';
import { convertTextRelationships, migrateNamespacedObjects, normalizeProperties } from '../modules/migration';
import {
  addLayerLinksToHome,
  createCommandListPage,
  createHelpPage,
  createLayerHomePages,
  createSimplePageTreePage,
} from '../modules/navigation';
import { diagnoseCurrentPage } from '../modules/diagnose';
import {
  isAutoRepairEnabled,
  registerAutoRepairHooks,
  registerAutoRepairSettings,
  scheduleCurrentPageAutoRepair,
} from '../modules/auto-repair';
import { repairCurrentPage } from '../modules/repair';
import {
  maintInitializeSchema,
  maintVerifySchema,
  repairRelatedToDisplayOrder,
  resetRelatedToNativeProperty,
  resetStaleNativeNodeProperties,
  resetVentureNativeProperty,
  setupAll,
  step1,
  step10db,
  step2,
  step3,
  step4,
  step5,
  step6,
  step7,
  step8,
  step9,
  stepPageTree,
  stepVerify,
} from '../modules/setup';
import { cleanNativeTagSchemaProperties } from '../modules/native-tag-cleanup';

type Handler = (r: import('../core/types').Result) => Promise<void>;

const registeredLabels = new Set<string>();

function register(label: string, fn: Handler): void {
  if (registeredLabels.has(label)) return;
  registeredLabels.add(label);
  logseq.Editor.registerSlashCommand(label, () => run(label, fn));
}

function registerAlias(alias: string, numberedLabel: string, fn: Handler): void {
  register(numberedLabel, fn);
  register(alias, fn);
}

function registerAliases(labels: string[], fn: Handler): void {
  for (const label of labels) register(label, fn);
}

function registerCommandAliases(canonicalLabel: string, aliases: string[], fn: Handler): void {
  const wrapped = (result: import('../core/types').Result) => {
    result.command = canonicalLabel;
    return fn(result);
  };
  register(canonicalLabel, fn);
  for (const alias of aliases) register(alias, wrapped);
}

function registerRegistryCreationCommands(): void {
  for (const command of registryCreationCommands()) {
    const handler =
      command.kind === 'form'
        ? insertRegistryFormBlock(command.objectName)
        : newRegistryPage(command.objectName);
    registerAliases(command.labels, handler);
  }
}

export function registerCommands(): void {
  registerAlias('LSS: Initialize Schema', 'lss: 1setup-all', setupAll);
  register('lss: 2setup-bootstrap', step1);
  register('lss: 3setup-areas', step2);
  register('lss: 4setup-schema-pages', step3);
  register('lss: 5setup-db-tags', step4);
  register('lss: 6setup-tag-properties', step5);
  register('lss: 7setup-relationships', step6);
  register('lss: 8setup-templates', step7);
  register('lss: 9setup-dashboards', step8);
  register('lss: 10setup-word-extenders', step9);
  register('lss: 11setup-db-native-config', step10db);
  register('lss: 12setup-page-tree', stepPageTree);
  registerAlias('LSS: Verify Schema', 'lss: 13verify-schema', stepVerify);

  register('lss: 14new-venture', newVenture);
  register('lss: 15new-project', newProject);
  register('lss: 16new-workstream', newWorkStream);
  register('lss: 17new-person', newPerson);
  register('lss: 18new-organisation', newOrganisation);
  register('lss: 19new-document', newDocument);
  register('lss: 20new-condition', newCondition);
  register('lss: 21new-subject', newSubject);
  register('lss: 22new-pursuit', newPursuit);
  register('lss: 23insert-action-item', insertActionItem);
  register('lss: 24insert-decision', insertDecision);
  register('lss: 25insert-interaction', insertInteraction);
  register('lss: 26insert-question', insertQuestion);
  register('lss: 27insert-insight', insertInsight);
  register('lss: 28insert-idea', insertIdea);
  register('lss: 29insert-note', insertNote);
  register('lss: 30insert-review', insertReview);
  register('lss: 31insert-word-extender', insertWordExtender);
  register('lss: 32insert-dashboard-section', insertDashboardSection);

  registerAlias('LSS: Audit Current Page', 'lss: 33audit-current-page', auditCurrentPage);
  registerAlias('LSS: Audit Graph', 'lss: 34audit-graph', auditGraph);
  registerAlias('LSS: Insert Venture Dashboard', 'lss: 35insert-venture-dashboard', insertVentureDashboard);
  registerAlias('LSS: Insert Project Dashboard', 'lss: 36insert-project-dashboard', insertProjectDashboard);
  registerAlias('LSS: Insert Area Dashboard', 'lss: 37insert-area-dashboard', insertAreaDashboard);
  registerAlias('LSS: Normalize Properties', 'lss: 38normalize-properties', normalizeProperties);
  registerAlias(
    'LSS: Convert Text Relationships to Node References',
    'lss: 39convert-text-relationships',
    convertTextRelationships,
  );
  registerAlias('LSS: Migrate Namespaced Objects to Tags', 'lss: 40migrate-namespaced-objects', migrateNamespacedObjects);
  registerAlias('LSS: Snapshot Dashboard', 'lss: 41snapshot-dashboard', snapshotDashboard);
  registerAlias('LSS: Export Current Page Report', 'lss: 42export-current-page-report', exportCurrentPageReport);
  registerAlias('LSS: Generate Weekly Review', 'lss: 43generate-weekly-review', generateWeeklyReview);
  registerAlias('LSS: Expand Abbreviation', 'lss: 44expand-abbreviation', expandAbbreviation);
  register('lss: 45help', createHelpPage);

  register('lss: 46create-simple-page-tree-page', createSimplePageTreePage);
  register('lss: 47create-command-list-page', createCommandListPage);
  register('lss: 48create-layer-home-pages', createLayerHomePages);
  register('lss: 49add-layer-links-to-home', addLayerLinksToHome);
  registerCommandAliases(
    'lss: materialise page',
    ['lss: materialise', 'lss materialise page', 'lss materialise', 'LSS: Materialise Page'],
    repairCurrentPage,
  );
  register('lss: 51diagnose-current-page', diagnoseCurrentPage);
  registerAlias('LSS: New Function', 'lss: 52new-function', newFunction);
  registerAliases(
    [
      'lss: 53reset-venture-property',
      'lss:53reset-venture-property',
      'lss53',
      'lss 53',
      'LSS: Reset Venture Property',
    ],
    resetVentureNativeProperty,
  );
  registerAliases(
    [
      'lss: 54clean-native-tag-schema-properties',
      'lss:54clean-native-tag-schema-properties',
      'lss54',
      'lss 54',
      'LSS: Clean Native Tag Schema Properties',
    ],
    cleanNativeTagSchemaProperties,
  );
  registerAliases(
    [
      'lss: 55reset-related-to-property-order',
      'lss:55reset-related-to-property-order',
      'lss55',
      'lss 55',
      'LSS: Reset Related-To Property Order',
    ],
    resetRelatedToNativeProperty,
  );
  registerAliases(
    [
      'lss: 56reset-stale-node-properties',
      'lss:56reset-stale-node-properties',
      'lss56',
      'lss 56',
      'LSS: Reset Stale Node Properties',
    ],
    resetStaleNativeNodeProperties,
  );
  registerAliases(
    [
      'lss: 57repair-related-to-display-order',
      'lss:57repair-related-to-display-order',
      'lss57',
      'lss 57',
      'LSS: Repair Related-To Display Order',
    ],
    repairRelatedToDisplayOrder,
  );

  // Additional spec aliases that map to existing handlers
  register('LSS: Initialize Schema (step-by-step)', maintInitializeSchema);
  register('LSS: Verify Schema (report only)', maintVerifySchema);
  registerRegistryCreationCommands();

  registerAutoRepairSettings();
  registerAutoRepairHooks();
  for (const delayMs of [1200, 3000, 6000, 10000, 15000]) {
    setTimeout(() => {
      void scheduleCurrentPageAutoRepair();
    }, delayMs);
  }

  logseq.UI.showMsg(
    `${TITLE} plugin ${VERSION} loaded. Auto-sync ${isAutoRepairEnabled() ? 'enabled' : 'disabled'}; manual repair is available.`,
    'success',
  );
}
