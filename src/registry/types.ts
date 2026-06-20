export interface RegistryArea {
  name: string;
  page: string;
  tag?: string;
  icon?: string;
  description?: string;
  displayName?: string;
  aliases?: string[];
  modelGroup?: string;
}

/**
 * RegistryObject (selected via #tag or lss-object-type on instances) defines
 * an object's canonical properties (requiredProperties + properties union).
 *
 * Tags act as the primary class/type on DB graphs (e.g. (tags "Function")).
 * The plugin uses objectByName + uniqueObjectProps(obj) everywhere to derive
 * the property schema. Creation, repair, and template enrichment materialize
 * these properties onto entity pages, not native tag property lists.
 *
 * Do NOT duplicate "prop::" declarations into template bodies; body is for
 * layout/requiredSections + dashboard query sections only.
 */
export interface RegistryObject {
  name: string;
  tag: string;
  schemaPage: string;
  displayName?: string;
  aliases?: string[];
  description?: string;
  modelGroup?: string;
  area?: string;
  nodeKind?: string;
  extends?: string[];
  template?: string;
  dashboardSection?: string;
  requiredProperties?: string[];
  properties?: string[];
  defaultValues?: Record<string, unknown>;
}

export interface RegistryRelationship {
  property: string;
  type?: string;
  targets?: string[];
  allowedTargets?: string[];
  targetTags?: string[];
  cardinality?: string;
  bidirectional?: boolean;
  inverseLabel?: string;
  inverse?: string;
  auditSeverity?: string;
  requiredBy?: string[] | string;
  optionalBy?: string[] | string;
}

export interface ViewDefinition {
  id?: string;
  title?: string;
  name?: string;
  dashboard?: string;
  section?: string;
  sourceTags?: string[];
  filters?: Array<{
    operator?: string;
    property?: string;
    propertyAny?: string[];
    value?: unknown[];
  }>;
  queryIntent?: string;
  intent?: string;
  viewType?: string;
  nativeQueryStatus?: string;
  exportPolicy?: string;
}

/**
 * RegistryTemplate describes the structural skeleton (title + requiredSections
 * + any dashboard sub-section headings) for native DB templates.
 *
 * IMPORTANT: RegistryTemplate.body MUST NOT contain property declarations
 * (foo:: bar). Bodies are layout only. Canonical properties are injected at
 * runtime onto entity pages from the matching RegistryObject; native tag
 * properties are not the instance schema source.
 */
export interface RegistryTemplate {
  name: string;
  appliesTo?: string[];
  nodeKind?: string;
  status?: string;
  body?: string;
  requiredSections?: string[];
  views?: string[];
  applyTemplateToTagsRecommended?: boolean;
  schemaVersion?: string;
}

export interface LssRegistry {
  schemaVersion: string;
  areas?: RegistryArea[];
  baseTags?: Array<{
    name?: string;
    tag?: string;
    extends?: string[];
    properties?: string[];
    displayName?: string;
    aliases?: string[];
    description?: string;
    modelGroup?: string;
  }>;
  entityTypes?: RegistryObject[];
  formTypes?: RegistryObject[];
  wordExtenderTypes?: RegistryObject[];
  propertyRegistry?: Array<{
    name?: string;
    property?: string;
    key?: string;
    type?: string;
    kind?: string;
    sensitivity?: string;
  }>;
  relationshipRegistry?: RegistryRelationship[];
  propertyAliases?: Array<{ alias?: string; deprecated?: string; canonical?: string; scope?: string }>;
  dashboardDefinitions?: Array<{
    page: string;
    name?: string;
    status?: string;
    sections?: Array<string | { title?: string; id?: string }>;
    views?: string[];
  }>;
  viewDefinitions?: ViewDefinition[];
  templates?: RegistryTemplate[];
  rootPages?: string[];
  auditRules?: Array<{ id: string; title?: string; severity?: string; scope?: string }>;
  decisions?: Record<string, unknown>;
}

export type AuditFinding = {
  ruleId: string;
  severity: 'ERROR' | 'WARNING' | 'INFO' | 'MIGRATION' | 'PRIVACY';
  message: string;
  suggestedFix?: string;
  property?: string;
};
