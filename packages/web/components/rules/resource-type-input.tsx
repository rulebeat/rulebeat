'use client';

import { useState, useEffect } from 'react';
import { X } from 'lucide-react';
import { FieldCombobox } from './field-combobox';

import { fieldBase } from '@/components/ui/input';

const inputCls = `${fieldBase} h-8 w-full px-3 text-xs`;

interface ResourceTypeInputProps {
  value: string;   // comma-separated, e.g. "microsoft.compute/virtualmachines, microsoft.storage/storageaccounts"
  onChange: (value: string) => void;
  readOnly?: boolean;
}

export function ResourceTypeInput({ value, onChange, readOnly }: ResourceTypeInputProps) {
  const [options, setOptions] = useState<string[]>([]);
  const [inputVal, setInputVal] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const selected = value.split(',').map(t => t.trim()).filter(Boolean);

  useEffect(() => {
    if (readOnly) return; // display-only — no need to load the picker options
    fetch('/api/resources/types')
      .then(async r => {
        const data = await r.json().catch(() => null) as { types?: string[]; error?: string } | null;
        if (!r.ok) {
          setLoadError(data?.error ?? 'Could not load resource types.');
          return;
        }
        if (data?.types) {
          // Microsoft types first (have ARM aliases), then third-party alphabetically
          const sorted = [...data.types].sort((a, b) => {
            const aMs = a.startsWith('microsoft.');
            const bMs = b.startsWith('microsoft.');
            if (aMs !== bMs) return aMs ? -1 : 1;
            return a.localeCompare(b);
          });
          setOptions(sorted);
        }
      })
      .catch(() => setLoadError('Could not load resource types.'))
      .finally(() => setLoading(false));
  }, [readOnly]);

  function add(type: string) {
    const t = type.trim().toLowerCase();
    if (!t) return;
    if (selected.map(s => s.toLowerCase()).includes(t)) return;
    onChange([...selected, t].join(', '));
    setInputVal('');
  }

  function remove(type: string) {
    const next = selected.filter(t => t !== type);
    onChange(next.length > 0 ? next.join(', ') : '*');
  }

  const availableOptions = options.filter(
    o => !selected.some(s => s.toLowerCase() === o.toLowerCase()),
  );

  return (
    <div className="space-y-2">
      {/* Selected badges */}
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selected.map(type => (
            <span
              key={type}
              className="inline-flex items-center gap-1 bg-surface-sunken px-2 py-0.5 font-mono text-xs text-ink"
            >
              {type === '*' ? 'all types (*)' : type}
              {!readOnly && (
                <button
                  type="button"
                  onClick={() => remove(type)}
                  className="ml-0.5 text-ink-muted transition-colors hover:text-ink"
                  aria-label={`Remove ${type}`}
                >
                  <X className="size-3" />
                </button>
              )}
            </span>
          ))}
        </div>
      )}

      {/* Search + add */}
      {!readOnly && (
        <>
          {loadError && (
            <p className="text-xs text-destructive">{loadError}</p>
          )}
          <FieldCombobox
            value={inputVal}
            onChange={setInputVal}
            onSelect={add}
            options={availableOptions}
            placeholder={
              loading
                ? 'Loading resource types…'
                : selected.length === 0
                  ? 'Search and add resource type (or type * for all)…'
                  : 'Add another resource type…'
            }
            className={inputCls}
          />
          {options.length > 0 && (
            <p className="text-xs text-ink-muted">
              {options.length.toLocaleString()} types available · type to filter · press Enter or click to add
            </p>
          )}
        </>
      )}
    </div>
  );
}
