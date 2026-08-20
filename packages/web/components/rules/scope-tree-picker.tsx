'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, ChevronRight, Loader2, X } from 'lucide-react';
import type { ScopeTree, ScopeTreeNode } from '@/app/api/azure/scope-tree/route';
import { toggleInSet } from '@/lib/toggle-set';
import { cn } from '@/lib/utils';

/* The three scope kinds are told apart by shape and letter, not by colour.
 * They used to be a blue chip, a green chip and a violet chip, which read as
 * three severities to anyone glancing at the screen and left three more hues
 * to keep legible on both grounds. A square is a management group, a circle is
 * a subscription, a filled square is the whole tenant; the letter confirms it. */
const MARKER = 'flex shrink-0 items-center justify-center border border-rule-strong text-[8px] font-bold text-ink-2';

interface ScopeTreePickerProps {
  subscriptions: string[];
  managementGroups: string[];
  onChange: (value: { subscriptions: string[]; managementGroups: string[] }) => void;
  onNamesReady?: (names: Record<string, string>) => void;
}

export function ScopeTreePicker({ subscriptions, managementGroups, onChange, onNamesReady }: ScopeTreePickerProps) {
  const [tree, setTree] = useState<ScopeTree | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [dropdownStyle, setDropdownStyle] = useState<React.CSSProperties>({});

  const anchorRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || tree) return;
    // Fetch-on-open: an external-system read, not derivable render state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    setError(null);
    fetch('/api/azure/scope-tree')
      .then(r => r.json())
      .then((data: ScopeTree | { error: string }) => {
        if ('error' in data) throw new Error(data.error);
        setTree(data);
        const topMgs = data.children.filter(c => c.type === 'managementGroup').map(c => c.id);
        setExpanded(new Set(topMgs));
        if (onNamesReady) {
          const names: Record<string, string> = {};
          function collect(nodes: ScopeTreeNode[]) {
            for (const n of nodes) { names[n.id] = n.name; if (n.children) collect(n.children); }
          }
          collect(data.children);
          onNamesReady(names);
        }
      })
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));
  }, [open, tree]);

  const reposition = useCallback(() => {
    if (!anchorRef.current) return;
    const rect = anchorRef.current.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom - 8;
    const spaceAbove = rect.top - 8;
    const openAbove = spaceBelow < 240 && spaceAbove > spaceBelow;
    const availH = Math.min(openAbove ? spaceAbove : spaceBelow, 480);
    setDropdownStyle({
      position: 'fixed',
      ...(openAbove ? { bottom: window.innerHeight - rect.top + 4 } : { top: rect.bottom + 4 }),
      left: rect.left,
      width: Math.max(rect.width, 400),
      maxHeight: availH,
      zIndex: 9999,
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    reposition();
    setTimeout(() => searchRef.current?.focus(), 0);
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    return () => {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
  }, [open, reposition]);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (!anchorRef.current?.contains(e.target as Node) && !dropdownRef.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [open]);

  // Build id→name map for chip labels
  const nameMap = new Map<string, string>();
  function collectNames(nodes: ScopeTreeNode[]) {
    for (const n of nodes) {
      nameMap.set(n.id, n.name);
      if (n.children) collectNames(n.children);
    }
  }
  if (tree) collectNames(tree.children);

  const totalSelected = subscriptions.length + managementGroups.length;

  function toggleMg(id: string) {
    const next = managementGroups.includes(id)
      ? managementGroups.filter(x => x !== id)
      : [...managementGroups, id];
    onChange({ subscriptions, managementGroups: next });
  }

  function toggleSub(id: string) {
    const next = subscriptions.includes(id)
      ? subscriptions.filter(x => x !== id)
      : [...subscriptions, id];
    onChange({ subscriptions: next, managementGroups });
  }

  function toggleExpand(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    setExpanded(prev => toggleInSet(prev, id));
  }

  function nodeMatchesSearch(node: ScopeTreeNode): boolean {
    const q = search.toLowerCase();
    if (node.name.toLowerCase().includes(q) || node.id.toLowerCase().includes(q)) return true;
    return node.children?.some(c => nodeMatchesSearch(c)) ?? false;
  }

  function renderNode(node: ScopeTreeNode, depth: number): React.ReactNode {
    if (search && !nodeMatchesSearch(node)) return null;
    const isMg = node.type === 'managementGroup';
    const isExpanded = expanded.has(node.id) || !!search;
    const hasChildren = (node.children?.length ?? 0) > 0;
    const checked = isMg ? managementGroups.includes(node.id) : subscriptions.includes(node.id);

    return (
      <div key={node.id}>
        <button
          onClick={() => isMg ? toggleMg(node.id) : toggleSub(node.id)}
          className={cn(
            'flex w-full items-center gap-2 py-1.5 pr-3 text-left transition-colors hover:bg-surface-hover',
            checked && 'bg-surface-sunken',
          )}
          style={{ paddingLeft: `${12 + depth * 16}px` }}
        >
          {/* Expand toggle */}
          <span
            className="flex size-3.5 shrink-0 items-center justify-center text-ink-muted"
            onClick={hasChildren ? (e) => toggleExpand(node.id, e) : undefined}
          >
            {isMg && hasChildren
              ? isExpanded
                ? <ChevronDown className="size-3.5" />
                : <ChevronRight className="size-3.5" />
              : null}
          </span>

          {/* Checkbox */}
          <div className={cn(
            'flex size-4 shrink-0 items-center justify-center border',
            checked ? 'border-ink bg-ink' : 'border-rule-strong',
          )}>
            {checked && <Check className="size-2.5 text-surface" />}
          </div>

          {/* Type indicator */}
          <span className={cn(MARKER, 'size-3.5', !isMg && 'rounded-full')}>
            {isMg ? 'M' : 'S'}
          </span>

          {/* Name + ID */}
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-medium text-ink">{node.name}</p>
            <p className="truncate font-mono text-xs text-ink">{node.id}</p>
          </div>
        </button>

        {isExpanded && hasChildren && (
          <div>
            {node.children!.map(child => renderNode(child, depth + 1))}
          </div>
        )}
      </div>
    );
  }

  const chips = [
    ...managementGroups.map(id => ({ id, name: nameMap.get(id) ?? id, type: 'mg' as const })),
    ...subscriptions.map(id => ({ id, name: nameMap.get(id) ?? id, type: 'sub' as const })),
  ];

  const dropdown = open && typeof window !== 'undefined' && createPortal(
    <div
      ref={dropdownRef}
      style={{ ...dropdownStyle, display: 'flex', flexDirection: 'column' }}
      className="overflow-hidden border border-rule-strong bg-surface shadow-overlay"
      onMouseDown={e => e.stopPropagation()}
    >
      {/* Search */}
      <div className="shrink-0 border-b border-border px-3 py-1.5">
        <input
          ref={searchRef}
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search management groups or subscriptions…"
          className="w-full bg-transparent text-xs text-ink outline-none placeholder:text-ink-faint"
        />
      </div>

      {/* Tree */}
      <div className="scroll-y min-h-0 flex-1">
        {loading && (
          <div className="flex items-center gap-2 px-3 py-3 text-xs text-ink-muted">
            <Loader2 className="size-3.5 animate-spin" /> Loading scope hierarchy…
          </div>
        )}
        {error && <p className="px-3 py-2 text-xs text-sev-critical">{error}</p>}
        {!loading && !error && tree && (
          <>
            {/* Entire tenant option */}
            <button
              onClick={() => onChange({ subscriptions: [], managementGroups: [] })}
              className={cn(
                'flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-surface-hover',
                totalSelected === 0 && 'bg-surface-sunken',
              )}
            >
              <span className="size-3.5 shrink-0" />
              <div className={cn(
                'flex size-4 shrink-0 items-center justify-center rounded-full border',
                totalSelected === 0 ? 'border-ink bg-ink' : 'border-rule-strong',
              )}>
                {totalSelected === 0 && <span className="size-2 bg-surface" />}
              </div>
              <span className={cn(MARKER, 'size-3.5 bg-surface-sunken')}>T</span>
              <div className="min-w-0">
                <p className="text-xs font-medium text-ink">Entire tenant</p>
                <p className="truncate text-xs text-ink">{tree.tenantName} · all subscriptions</p>
              </div>
            </button>

            <div className="mx-3 my-1 border-t border-border" />

            {/* Legend */}
            <div className="flex items-center gap-3 px-3 pb-1">
              <span className="flex items-center gap-1 text-xs text-ink-muted">
                <span className={cn(MARKER, 'size-3 text-[7px]')}>M</span>
                Management group
              </span>
              <span className="flex items-center gap-1 text-xs text-ink-muted">
                <span className={cn(MARKER, 'size-3 rounded-full text-[7px]')}>S</span>
                Subscription
              </span>
            </div>

            {tree.children.map(node => renderNode(node, 0))}

            {search && tree.children.every(n => !nodeMatchesSearch(n)) && (
              <p className="px-3 py-2 text-xs text-ink-muted">No results</p>
            )}
          </>
        )}
      </div>

      {totalSelected > 0 && (
        <div className="shrink-0 border-t border-border bg-surface-sunken px-3 py-1.5">
          <button
            onClick={() => onChange({ subscriptions: [], managementGroups: [] })}
            className="text-xs text-ink-2 transition-colors hover:text-ink"
          >
            Clear all ({totalSelected} selected)
          </button>
        </div>
      )}
    </div>,
    document.body,
  );

  return (
    <div ref={anchorRef} className="relative">
      <div
        onClick={() => setOpen(o => !o)}
        className="flex min-h-9 w-full cursor-pointer flex-wrap items-center gap-1 border border-rule-strong bg-surface px-2.5 py-1.5 transition-colors hover:bg-surface-hover"
      >
        {chips.length === 0 && (
          <span className="flex-1 text-xs text-ink-muted">All subscriptions (entire tenant)</span>
        )}
        {chips.map(chip => (
          <span
            key={chip.id}
            className="inline-flex max-w-[220px] items-center gap-1 bg-surface-sunken px-2 py-0.5 text-xs font-medium text-ink-2"
          >
            {/* Same marker as the tree, so a chip and its row are recognisably the same thing. */}
            <span className={cn(MARKER, 'size-3 text-[7px]', chip.type === 'sub' && 'rounded-full')}>
              {chip.type === 'mg' ? 'M' : 'S'}
            </span>
            <span className="truncate">{chip.name}</span>
            <button
              onClick={e => { e.stopPropagation(); if (chip.type === 'mg') toggleMg(chip.id); else toggleSub(chip.id); }}
              className="shrink-0 transition-colors hover:text-ink"
              aria-label={`Remove ${chip.name}`}
            >
              <X className="size-3" />
            </button>
          </span>
        ))}
        <ChevronDown className={cn('ml-auto size-3.5 shrink-0 text-ink-muted transition-transform', open && 'rotate-180')} />
      </div>
      {dropdown}
    </div>
  );
}
