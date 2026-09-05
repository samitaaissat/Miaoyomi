'use client';
import { setExcludableValue, type NovelFilterDefinition } from '@/lib/novels/filters';
import type { EngineSource } from '@/lib/novels/types';

export function NovelFilters({ definitions, values, onChange, sources, sourceIds, onSourcesChange, searching }: {
  definitions: NovelFilterDefinition[];
  values: Record<string, unknown>;
  onChange: (values: Record<string, unknown>) => void;
  sources: EngineSource[];
  sourceIds: string[];
  onSourcesChange: (sourceIds: string[]) => void;
  searching: boolean;
}) {
  const set = (key: string, value: unknown) => onChange({ ...values, [key]: value });
  return (
    <details className="card my-5 p-4">
      <summary className="cursor-pointer list-none text-sm font-semibold text-fog-200">Filters <span className="ms-1 text-fog-500">· {sourceIds.length ? `${sourceIds.length} source${sourceIds.length === 1 ? '' : 's'}` : 'All sources'}</span></summary>
      <fieldset className="mt-4">
        <legend className="mb-2 text-xs font-medium text-fog-400">Sources</legend>
        <button type="button" className={`chip mb-3 text-xs ${sourceIds.length ? '' : 'chip-active'}`} aria-pressed={!sourceIds.length} onClick={() => onSourcesChange([])}>All sources</button>
        <p className="mb-3 text-xs text-fog-500">Choose sources to narrow your results.</p>
        <div className="grid max-h-56 gap-2 overflow-y-auto sm:grid-cols-2 xl:grid-cols-3">
          {sources.map((source) => <label key={source.id} className="flex min-w-0 cursor-pointer items-center gap-3 rounded-xl border border-ink-700 px-3 py-2.5 text-sm text-fog-200">
            <input type="checkbox" aria-label={`Source ${source.name}`} className="h-4 w-4 shrink-0 accent-accent" checked={sourceIds.includes(source.id)}
              onChange={(event) => onSourcesChange(event.target.checked ? [...sourceIds, source.id].sort() : sourceIds.filter((id) => id !== source.id))} />
            <span className="min-w-0 truncate">{source.name}</span><span className="ms-auto shrink-0 text-xs uppercase text-fog-500">{source.lang}</span>
          </label>)}
        </div>
      </fieldset>
      {!searching && sourceIds.length !== 1 && <p className="mt-4 text-xs text-fog-500">Select one source to use its specific browse filters.</p>}
      {!searching && definitions.length > 0 && <>
      <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {definitions.map((filter) => {
          const value = values[filter.key] ?? filter.value;
          if (filter.type === 'Picker') return (
            <label key={filter.key} className="text-xs font-medium text-fog-400">
              {filter.label}
              <select className="field mt-1" value={String(value ?? '')} onChange={(event) => set(filter.key, event.target.value)}>
                {filter.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>
          );
          if (filter.type === 'Switch') return (
            <label key={filter.key} className="flex items-center justify-between gap-4 rounded-xl border border-ink-700 px-3 py-2.5 text-sm text-fog-200">
              {filter.label}
              <input type="checkbox" className="h-4 w-4 accent-accent" checked={Boolean(value)} onChange={(event) => set(filter.key, event.target.checked)} />
            </label>
          );
          if (filter.type === 'XCheckbox' || filter.type === 'Checkbox') {
            const selected = value && typeof value === 'object' ? value as { include?: string[]; exclude?: string[] } : {};
            return (
              <fieldset key={filter.key} className="md:col-span-2 xl:col-span-3">
                <legend className="mb-2 text-xs font-medium text-fog-400">{filter.label}</legend>
                <div className="flex max-h-48 flex-wrap gap-2 overflow-y-auto rounded-2xl border border-ink-700 p-3">
                  {filter.options.map((option) => {
                    const included = selected.include?.includes(option.value);
                    const excluded = selected.exclude?.includes(option.value);
                    const mode = included ? 'include' : excluded ? 'exclude' : 'ignore';
                    return (
                      <button key={option.value} type="button"
                        onClick={() => set(filter.key, setExcludableValue(value, option.value, mode === 'ignore' ? 'include' : mode === 'include' && filter.type === 'XCheckbox' ? 'exclude' : 'ignore'))}
                        className={`chip text-xs ${included ? 'chip-active' : excluded ? 'border-red-400/40 bg-red-400/10 text-red-300 line-through' : ''}`}
                        title={filter.type === 'XCheckbox' ? 'Tap to include, exclude, then clear' : 'Tap to include or clear'}>
                        {included ? '+ ' : excluded ? '− ' : ''}{option.label}
                      </button>
                    );
                  })}
                </div>
              </fieldset>
            );
          }
          return (
            <label key={filter.key} className="text-xs font-medium text-fog-400">
              {filter.label}
              <input className="field mt-1" value={String(value ?? '')} onChange={(event) => set(filter.key, event.target.value)} />
            </label>
          );
        })}
      </div>
      <button type="button" className="mt-4 text-xs font-medium text-accent" onClick={() => onChange(Object.fromEntries(definitions.map((filter) => [filter.key, structuredClone(filter.value)])))}>
        Reset source filters
      </button>
      </>}
    </details>
  );
}
