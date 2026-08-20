'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';

interface FieldComboboxProps {
  value: string;
  onChange: (value: string) => void;
  options: string[];
  placeholder?: string;
  className?: string;
  /** Called when user explicitly selects an option (click or Enter). If provided,
   *  the input value is NOT set to the selected option — the parent controls it. */
  onSelect?: (value: string) => void;
}

function Highlight({ text, query }: { text: string; query: string }) {
  if (!query.trim()) return <>{text}</>;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return <>{text}</>;
  return (
    <>
      <span className="text-ink-2">{text.slice(0, idx)}</span>
      <span className="font-semibold text-ink">{text.slice(idx, idx + query.length)}</span>
      <span className="text-ink-2">{text.slice(idx + query.length)}</span>
    </>
  );
}

export function FieldCombobox({ value, onChange, options, placeholder, className, onSelect }: FieldComboboxProps) {
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(-1);
  const [style, setStyle] = useState<React.CSSProperties>({});
  const [mounted, setMounted] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // Hydration-safe mount flag: must be false on the server render and true only after the client
  // mounts (for portal positioning), which a render-time value can't express.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setMounted(true); }, []);

  const filtered = value.trim()
    ? options.filter(o => o.toLowerCase().includes(value.toLowerCase()))
    : options;

  const reposition = useCallback(() => {
    const rect = inputRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.max(rect.width, 420);
    const left = Math.min(rect.left, Math.max(8, window.innerWidth - width - 8));
    const spaceBelow = window.innerHeight - rect.bottom - 8;
    const spaceAbove = rect.top - 8;
    const openAbove = spaceBelow < 150 && spaceAbove > spaceBelow;
    const availH = Math.min(openAbove ? spaceAbove : spaceBelow, 320);
    setStyle({
      position: 'fixed',
      ...(openAbove ? { bottom: window.innerHeight - rect.top + 4 } : { top: rect.bottom + 4 }),
      left,
      minWidth: width,
      maxHeight: availH,
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
    return () => {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
  }, [open, reposition]);

  const select = useCallback((opt: string) => {
    if (onSelect) {
      onSelect(opt);
      onChange('');  // clear the search input after selection
    } else {
      onChange(opt);
    }
    setOpen(false);
    setActiveIdx(-1);
  }, [onChange, onSelect]);

  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (!inputRef.current?.contains(e.target as Node) && !listRef.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  useEffect(() => {
    if (activeIdx < 0 || !listRef.current) return;
    (listRef.current.children[activeIdx] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' });
  }, [activeIdx]);

  const showDropdown = open && mounted;

  return (
    <div className="relative w-full">
      <input
        ref={inputRef}
        value={value}
        onChange={e => { onChange(e.target.value); setOpen(true); setActiveIdx(-1); }}
        onFocus={() => { reposition(); setOpen(true); }}
        onKeyDown={e => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (!open) { setOpen(true); return; }
            setActiveIdx(i => Math.min(i + 1, filtered.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActiveIdx(i => Math.max(i - 1, 0));
          } else if (e.key === 'Enter') {
            e.preventDefault();
            if (activeIdx >= 0 && filtered[activeIdx]) {
              select(filtered[activeIdx]);
            } else if (onSelect && value.trim()) {
              select(value.trim());
            }
          } else if (e.key === 'Escape') {
            setOpen(false);
          }
        }}
        placeholder={placeholder}
        className={className}
        autoComplete="off"
        spellCheck={false}
      />

      {showDropdown && createPortal(
        <div style={style} className="overflow-hidden border border-rule-strong bg-surface shadow-overlay">
          {/* Header bar */}
          <div className="flex shrink-0 items-center justify-between border-b border-border bg-surface-sunken px-3 py-2">
            <span className="text-xs text-ink-muted">
              {options.length === 0
                ? 'No fields loaded. Click Fetch fields first'
                : value.trim()
                  ? `${filtered.length} of ${options.length} fields`
                  : `${options.length} fields available`}
            </span>
            <span className="hidden text-xs text-ink-faint sm:block">↑↓ · ↵ select · Esc close</span>
          </div>

          {/* List */}
          {filtered.length > 0 ? (
            <ul ref={listRef} className="min-h-0 flex-1 scroll-y py-1">
              {filtered.map((opt, i) => (
                <li
                  key={opt}
                  onMouseDown={e => { e.preventDefault(); select(opt); }}
                  onMouseEnter={() => setActiveIdx(i)}
                  className={`cursor-pointer whitespace-nowrap px-3 py-1.5 font-mono text-xs leading-5 transition-colors ${
                    i === activeIdx ? 'bg-surface-hover text-ink' : 'text-ink-2 hover:bg-surface-hover hover:text-ink'
                  }`}
                >
                  <Highlight text={opt} query={value} />
                </li>
              ))}
            </ul>
          ) : value.trim() ? (
            <div className="px-3 py-5 text-center">
              <p className="text-xs text-ink-muted">No fields matching <span className="font-mono text-ink">{value}</span></p>
              <p className="mt-1 text-xs text-ink-faint">Press Enter to use this value as-is</p>
            </div>
          ) : null}
        </div>,
        document.body,
      )}
    </div>
  );
}
