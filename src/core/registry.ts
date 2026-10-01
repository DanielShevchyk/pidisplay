// Discovers widgets: every src/widgets/<name>/index.ts is bundled automatically.
// Folders starting with "_" are ignored, so they can hold templates or WIP.
import type { WidgetDefinition } from './types';

const modules = import.meta.glob<{ default: WidgetDefinition<any> }>(
  ['../widgets/*/index.ts', '!../widgets/_*/index.ts'],
  { eager: true },
);

const registry = new Map<string, WidgetDefinition<any>>();
for (const [file, mod] of Object.entries(modules)) {
  const def = mod.default;
  if (!def?.type || typeof def.mount !== 'function') {
    console.warn(`Skipping ${file}: default export is not a widget definition`);
    continue;
  }
  if (registry.has(def.type)) console.warn(`Duplicate widget type "${def.type}" in ${file}`);
  registry.set(def.type, def);
}

export function getWidget(type: string): WidgetDefinition<any> | undefined {
  return registry.get(type);
}

export function allWidgets(): WidgetDefinition<any>[] {
  return [...registry.values()].sort((a, b) => a.name.localeCompare(b.name));
}
