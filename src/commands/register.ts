import { TITLE, VERSION } from '../config';
import { run } from '../core/runner';
import { registryCreationCommands } from './registry-create';
import { auditCurrentPage, auditGraph } from '../modules/audit';
import {
  insertRegistryFormBlock,
  newRegistryPage,
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

type Handler = (r: import('../core/types').Result, context?: import('../core/types').CommandContext) => Promise<void>;

const registeredLabels = new Set<string>();

function register(label: string, fn: Handler): void {
  if (registeredLabels.has(label)) return;
  registeredLabels.add(label);
  logseq.Editor.registerSlashCommand(label, (context) => run(label, fn, context));
}

function registerPalette(label: string, key: string, fn: Handler): void {
  logseq.App.registerCommandPalette({ key, label }, (context) => run(label, fn, context));
}

function registerPageMenu(label: string, fn: Handler): void {
  logseq.App.registerPageMenuItem(label, (context) => run(label, fn, context));
}

function registerRegistryCreationCommands(): void {
  for (const command of registryCreationCommands()) {
    const handler =
      command.kind === 'form'
        ? insertRegistryFormBlock(command.objectName)
        : newRegistryPage(command.objectName);
    register(command.label, handler);
  }
}

export function registerCommands(): void {
  register('lss: 1setup-all', setupAll);
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
  register('lss: 13verify-schema', stepVerify);

  register('lss: 33audit-current-page', auditCurrentPage);
  register('lss: 34audit-graph', auditGraph);
  register('lss: 35insert-venture-dashboard', insertVentureDashboard);
  register('lss: 36insert-project-dashboard', insertProjectDashboard);
  register('lss: 37insert-area-dashboard', insertAreaDashboard);
  register('lss: 38normalize-properties', normalizeProperties);
  register('lss: 39convert-text-relationships', convertTextRelationships);
  register('lss: 40migrate-namespaced-objects', migrateNamespacedObjects);
  register('lss: 41snapshot-dashboard', snapshotDashboard);
  register('lss: 42export-current-page-report', exportCurrentPageReport);
  register('lss: 43generate-weekly-review', generateWeeklyReview);
  register('lss: 44expand-abbreviation', expandAbbreviation);
  register('lss: 45help', createHelpPage);

  register('lss: 46create-simple-page-tree-page', createSimplePageTreePage);
  register('lss: 47create-command-list-page', createCommandListPage);
  register('lss: 48create-layer-home-pages', createLayerHomePages);
  register('lss: 49add-layer-links-to-home', addLayerLinksToHome);
  register('lss: materialise page', repairCurrentPage);
  registerPalette('lss: materialise page', 'lss-materialise-page', repairCurrentPage);
  registerPageMenu('lss: materialise page', repairCurrentPage);
  register('lss: 51diagnose-current-page', diagnoseCurrentPage);
  register('lss: 53reset-venture-property', resetVentureNativeProperty);
  register('lss: 54clean-native-tag-schema-properties', cleanNativeTagSchemaProperties);
  register('lss: 55reset-related-to-property-order', resetRelatedToNativeProperty);
  register('lss: 56reset-stale-node-properties', resetStaleNativeNodeProperties);
  register('lss: 57repair-related-to-display-order', repairRelatedToDisplayOrder);

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
