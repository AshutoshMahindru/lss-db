import { registry } from '../registry';
import type { RegistryObject } from '../registry/types';

export type RegistryCreationKind = 'entity' | 'form' | 'word-extender';

export type RegistryCreationCommand = {
  kind: RegistryCreationKind;
  objectName: string;
  label: string;
  labels: string[];
  description: string;
};

export function commandSlug(value: string): string {
  return String(value ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}

function displayName(o: RegistryObject): string {
  return String(o.displayName ?? o.name);
}

function labelCandidates(o: RegistryObject): string[] {
  return [
    o.name,
    displayName(o),
    ...(o.aliases ?? []),
  ]
    .map((label) => String(label ?? '').trim())
    .filter(Boolean);
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function pageCommand(o: RegistryObject, kind: RegistryCreationKind): RegistryCreationCommand {
  const labels = unique(
    labelCandidates(o).flatMap((label) => [
      `lss: new-${commandSlug(label)}`,
      `LSS: New ${label}`,
    ]),
  );
  const noun = displayName(o);
  return {
    kind,
    objectName: o.name,
    label: labels[0],
    labels,
    description:
      kind === 'word-extender'
        ? `Create a placeholder ${noun} word-extender page from the registry.`
        : `Create a placeholder ${noun} page from the registry.`,
  };
}

function formCommand(o: RegistryObject): RegistryCreationCommand {
  const labels = unique(
    labelCandidates(o).flatMap((label) => [
      `lss: insert-${commandSlug(label)}`,
      `LSS: Insert ${label}`,
    ]),
  );
  return {
    kind: 'form',
    objectName: o.name,
    label: labels[0],
    labels,
    description: `Insert a ${displayName(o)} block at the cursor from the registry.`,
  };
}

export function registryCreationCommands(): RegistryCreationCommand[] {
  return [
    ...(registry.entityTypes ?? []).map((object) => pageCommand(object, 'entity')),
    ...(registry.wordExtenderTypes ?? []).map((object) => pageCommand(object, 'word-extender')),
    ...(registry.formTypes ?? []).map(formCommand),
  ];
}
