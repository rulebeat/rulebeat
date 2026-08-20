'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Tag, Plus, Check, X, Lock, Sparkles } from 'lucide-react';

export interface LockedTag {
  label: string;
  icon?: 'lock' | 'sparkles';
}

interface TagPickerProps {
  tags: string[];
  allTags: string[];
  onChange: (tags: string[]) => void;
  disabled?: boolean;
  /** System-provided tags (source/pack) — displayed as regular tag chips, but locked: no remove, not searchable/creatable. Rendered first. */
  lockedTags?: LockedTag[];
}

export function TagPicker({ tags, allTags, onChange, disabled, lockedTags }: TagPickerProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [style, setStyle] = useState<React.CSSProperties>({});
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const reposition = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = 224;
    const left = Math.min(rect.left, Math.max(8, window.innerWidth - width - 8));
    const spaceBelow = window.innerHeight - rect.bottom - 8;
    const spaceAbove = rect.top - 8;
    const openAbove = spaceBelow < 220 && spaceAbove > spaceBelow;
    setStyle({
      position: 'fixed',
      ...(openAbove ? { bottom: window.innerHeight - rect.top + 4 } : { top: rect.bottom + 4 }),
      left,
      width,
      maxHeight: Math.min(openAbove ? spaceAbove : spaceBelow, 280),
      display: 'flex',
      flexDirection: 'column',
      zIndex: 9999,
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    reposition();
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    const onDown = (e: MouseEvent) => {
      if (!triggerRef.current?.contains(e.target as Node) && !popRef.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
      document.removeEventListener('mousedown', onDown);
      clearTimeout(t);
    };
  }, [open, reposition]);

  const toggle = (t: string) => {
    onChange(tags.includes(t) ? tags.filter(x => x !== t) : [...tags, t]);
  };

  const remove = (t: string) => onChange(tags.filter(x => x !== t));

  const create = () => {
    const name = search.trim();
    if (!name) return;
    if (!tags.includes(name)) onChange([...tags, name]);
    setSearch('');
  };

  const suggestions = allTags.filter(t => !search.trim() || t.toLowerCase().includes(search.trim().toLowerCase()));
  const showCreate = Boolean(search.trim()) && !allTags.some(t => t.toLowerCase() === search.trim().toLowerCase());

  return (
    <div className="flex items-center gap-1 flex-wrap">
      {lockedTags?.map(lt => (
        <span
          key={`locked-${lt.label}`}
          title="System tag, not editable"
          className="inline-flex items-center gap-1 bg-surface-sunken px-1.5 py-0.5 text-xs font-medium text-ink-faint"
        >
          {lt.icon === 'sparkles' ? <Sparkles className="size-2.5 shrink-0" /> : <Lock className="size-2.5 shrink-0" />}
          {lt.label}
        </span>
      ))}
      {tags.map(t => (
        <span key={t} className="inline-flex items-center gap-1 bg-surface-sunken px-1.5 py-0.5 text-xs font-medium text-ink">
          {t}
          {!disabled && (
            <button onClick={() => remove(t)} className="text-ink-muted transition-colors hover:text-ink" title={`Remove "${t}"`}>
              <X className="size-2.5" />
            </button>
          )}
        </span>
      ))}
      {!disabled && (
        <button
          ref={triggerRef}
          onClick={() => setOpen(o => !o)}
          className="inline-flex items-center gap-1 border border-border px-1.5 py-0.5 text-xs font-medium text-ink-2 transition-colors hover:border-rule-strong hover:text-ink"
        >
          <Plus className="size-2.5" />
          Tag
        </button>
      )}

      {open && createPortal(
        <div ref={popRef} style={style} className="overflow-hidden border border-rule-strong bg-surface shadow-overlay">
          <div className="p-2 border-b border-border shrink-0">
            <input
              ref={inputRef}
              value={search}
              onChange={e => setSearch(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') create(); if (e.key === 'Escape') setOpen(false); }}
              placeholder="Search or create tag…"
              className="h-7 w-full border border-border bg-surface px-2 text-xs text-ink placeholder:text-ink-faint focus:outline-2 focus:outline-offset-[-1px] focus:outline-ink"
            />
          </div>
          <div className="flex-1 overflow-y-auto min-h-0 py-1">
            {suggestions.map(t => (
              <button
                key={t}
                onClick={() => toggle(t)}
                className="w-full flex items-center gap-2 px-3 py-2 text-xs text-left transition-colors hover:bg-surface-hover"
              >
                <Tag className="size-3 shrink-0 text-ink-muted" />
                <span className="flex-1 truncate">{t}</span>
                {tags.includes(t) && <Check className="size-3 shrink-0 text-ink" />}
              </button>
            ))}
            {showCreate && (
              <button
                onClick={create}
                className="flex w-full items-center gap-2 px-3 py-2 text-xs font-medium text-ink transition-colors hover:bg-surface-hover"
              >
                <Plus className="size-3 shrink-0" />
                Create &ldquo;{search.trim()}&rdquo;
              </button>
            )}
            {!suggestions.length && !showCreate && (
              <p className="px-3 py-4 text-center text-xs text-ink-muted">
                Type a name to create a tag
              </p>
            )}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
