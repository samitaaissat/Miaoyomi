export interface NovelFilterOption { label: string; value: string }
export interface NovelFilterDefinition {
  key: string;
  label: string;
  type: string;
  value: unknown;
  options: NovelFilterOption[];
}

export function normalizeFilters(raw: unknown): NovelFilterDefinition[] {
  if (!raw || typeof raw !== 'object') return [];
  return Object.entries(raw as Record<string, unknown>).flatMap(([key, unknownDefinition]) => {
    if (!unknownDefinition || typeof unknownDefinition !== 'object') return [];
    const definition = unknownDefinition as Record<string, unknown>;
    if (typeof definition.type !== 'string') return [];
    const options = Array.isArray(definition.options)
      ? definition.options.flatMap((option) => {
        if (!option || typeof option !== 'object') return [];
        const item = option as Record<string, unknown>;
        return typeof item.value === 'string' || typeof item.value === 'number'
          ? [{ label: String(item.label ?? item.value), value: String(item.value) }]
          : [];
      })
      : [];
    return [{
      key,
      label: typeof definition.label === 'string' ? definition.label : key,
      type: definition.type,
      value: structuredClone(definition.value),
      options,
    }];
  });
}

export function serializeFilters(
  definitions: NovelFilterDefinition[],
  values: Record<string, unknown>,
): Record<string, { type: string; value: unknown }> {
  return Object.fromEntries(definitions.map((definition) => [
    definition.key,
    { type: definition.type, value: structuredClone(values[definition.key] ?? definition.value) },
  ]));
}

export function setExcludableValue(
  value: unknown,
  option: string,
  mode: 'include' | 'exclude' | 'ignore' | string,
): { include: string[]; exclude: string[] } {
  const current = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const include = new Set(Array.isArray(current.include) ? current.include.map(String) : []);
  const exclude = new Set(Array.isArray(current.exclude) ? current.exclude.map(String) : []);
  include.delete(option);
  exclude.delete(option);
  if (mode === 'include') include.add(option);
  if (mode === 'exclude') exclude.add(option);
  return { include: [...include], exclude: [...exclude] };
}
