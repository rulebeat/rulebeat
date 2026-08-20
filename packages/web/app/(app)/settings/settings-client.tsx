'use client';

import { useState } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { Input, Label } from '@/components/ui/input';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow, TableScroll,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';
import type { Category } from '@/lib/types';
import type { AppUser } from '@/lib/db/users';
import { can, ROLE_LABELS, type Role } from '@/lib/rbac';
import { UsersSection } from './users-section';
import { AzureConnectionSection } from './azure-connection-section';
import type { AzureConnectionStatus } from '@/lib/azure-credential';
import { SignInSection } from './sign-in-section';
import type { SignInStatus } from '@/lib/sign-in-config';
import { NotificationsSection } from './notifications-section';
import { ThemeToggle } from '@/components/theme/theme-toggle';
import type { NotificationChannelSummary } from '@/lib/db/notification-channels';
import {
  Plus, Trash2, Pencil, Check, X, Lock, Eye, Pipette,
  Tag, KeyRound, Network, LayoutGrid, ShieldCheck, Activity, Library, EyeOff, Folder,
  Shield, Cloud, Database, Server, HardDrive, Cpu, Globe, Wifi, DollarSign, CreditCard,
  TrendingUp, BarChart3, PieChart, Users, User, Building2, Package, Terminal, FileText,
  FileCheck, GitBranch, Layers, Zap, AlertTriangle, CheckCircle2, Settings as SettingsIcon,
  Filter, Search, Bell, Mail, Link2, Flag, Star, Target, Compass, Clock, Calendar, Wrench,
  Radar, ClipboardCheck, Scale,
  type LucideIcon,
} from 'lucide-react';

const ICON_MAP: Record<string, LucideIcon> = {
  Tag, Folder, KeyRound, Trash2, Network, LayoutGrid, ShieldCheck, Shield, Activity,
  Library, EyeOff, Eye, Cloud, Database, Server, HardDrive, Cpu, Globe, Wifi,
  DollarSign, CreditCard, TrendingUp, BarChart3, PieChart, Users, User, Building2, Package, Terminal,
  FileText, FileCheck, GitBranch, Layers, Zap, AlertTriangle, CheckCircle2, Settings: SettingsIcon,
  Filter, Search, Bell, Mail, Link2, Flag, Star, Target, Compass, Clock, Calendar, Wrench,
  Radar, ClipboardCheck, Scale,
};
const ICON_NAMES = Object.keys(ICON_MAP);

// Curated quick picks. Deliberately excludes pure "alarm" red — that hue is reserved for
// severity/destructive elsewhere in the product, so a category shouldn't default to or be
// nudged toward it. The native colour input below still lets a user pick literally anything,
// including red, if that's genuinely what they want.
const COLOR_SWATCHES = [
  '#2563eb', '#3b82f6', '#0ea5e9', '#06b6d4', '#14b8a6',
  '#10b981', '#22c55e', '#84cc16', '#eab308', '#f59e0b',
  '#f97316', '#fb923c', '#ec4899', '#d946ef', '#a855f7',
  '#8b5cf6', '#6366f1', '#64748b', '#78716c', '#0f766e',
];

interface CategoryFormValues {
  label: string;
  color: string;
  icon: string;
}

function ColorSwatchPicker({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  const isPreset = COLOR_SWATCHES.includes(value);
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {COLOR_SWATCHES.map(c => (
        <button
          key={c}
          type="button"
          onClick={() => onChange(c)}
          title={c}
          className={cn(
            'size-6 border transition-shadow',
            value === c
              ? 'border-ink shadow-[inset_0_0_0_2px_var(--color-surface)]'
              : 'border-border hover:border-rule-strong',
          )}
          style={{ backgroundColor: c }}
        />
      ))}
      {/* Any colour, not just the curated set above — a category's colour is a label, not a
          measurement, so it's a sanctioned exception to the token-only rule (see CLAUDE.md). */}
      <label
        title={isPreset ? 'Pick a custom colour' : value}
        className={cn(
          'relative flex size-6 shrink-0 cursor-pointer items-center justify-center overflow-hidden border transition-shadow',
          !isPreset
            ? 'border-ink shadow-[inset_0_0_0_2px_var(--color-surface)]'
            : 'border-border hover:border-rule-strong',
        )}
        style={!isPreset ? { backgroundColor: value } : undefined}
      >
        {isPreset && <Pipette className="size-3.5 text-ink-2" />}
        <input
          type="color"
          value={value}
          onChange={e => onChange(e.target.value)}
          className="absolute inset-0 size-full cursor-pointer opacity-0"
        />
      </label>
    </div>
  );
}

function IconPicker({ value, onChange }: { value: string; onChange: (i: string) => void }) {
  return (
    <div className="flex max-w-lg flex-wrap items-center gap-1.5">
      {ICON_NAMES.map(name => {
        const Icon = ICON_MAP[name];
        return (
          <button
            key={name}
            type="button"
            onClick={() => onChange(name)}
            title={name}
            /* Selected reads as inversion, not a tinted hue. Colour in this product
               means severity, so it is never spent on "this one is picked". */
            className={cn(
              'flex size-7 items-center justify-center border transition-colors',
              value === name
                ? 'border-ink bg-ink text-surface'
                : 'border-border text-ink-2 hover:bg-surface-hover hover:text-ink',
            )}
          >
            <Icon className="size-3.5" />
          </button>
        );
      })}
    </div>
  );
}

function EditRow({
  initial, onSave, onCancel, saving,
}: {
  initial: CategoryFormValues;
  onSave: (v: CategoryFormValues) => void;
  onCancel: () => void;
  saving?: boolean;
}) {
  const [label, setLabel] = useState(initial.label);
  const [color, setColor] = useState(initial.color);
  const [icon, setIcon] = useState(initial.icon);

  return (
    /* Stays a raw <tr> on purpose: it spans every column, so the shared
       TableRow/TableCell pair would only add styling it has to undo. */
    <tr className="border-b border-border bg-surface-sunken last:border-0">
      <td colSpan={5} className="px-4 py-4">
        <div className="flex max-w-lg flex-col gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="category-label">Label</Label>
            <Input
              id="category-label"
              value={label}
              onChange={e => setLabel(e.target.value)}
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label>Color</Label>
            <ColorSwatchPicker value={color} onChange={setColor} />
          </div>
          <div className="space-y-1.5">
            <Label>Icon</Label>
            <IconPicker value={icon} onChange={setIcon} />
          </div>
          <div className="flex items-center gap-2 pt-1">
            <Button
              size="sm"
              disabled={saving || !label.trim()}
              onClick={() => onSave({ label: label.trim(), color, icon })}
            >
              <Check className="size-3.5" />
              Save
            </Button>
            <Button size="sm" variant="outline" onClick={onCancel}>
              <X className="size-3.5" />
              Cancel
            </Button>
          </div>
        </div>
      </td>
    </tr>
  );
}

export function SettingsClient({
  initialCategories,
  role,
  currentUserId,
  initialUsers,
  initialUsersWithPassword,
  initialAzureStatus,
  initialSignInStatus,
  initialChannels,
}: {
  initialCategories: Category[];
  role: Role;
  currentUserId: string;
  /** Empty unless the viewer is an admin — the server only loads these for `users:manage`. */
  initialUsers: AppUser[];
  initialUsersWithPassword: string[];
  /** Null unless the viewer is an admin — the server only loads it for `azure:manage`. */
  initialAzureStatus: AzureConnectionStatus | null;
  /** Null unless the viewer is an admin — the server only loads it for `auth:manage`. */
  initialSignInStatus: SignInStatus | null;
  /** Null unless the viewer is an admin — the server only loads it for `notifications:manage`. */
  initialChannels: NotificationChannelSummary[] | null;
}) {
  const canEditCategories = can(role, 'categories:write');
  const canManageUsers = can(role, 'users:manage');
  const canManageAzure = can(role, 'azure:manage');
  const canManageAuth = can(role, 'auth:manage');
  const canManageNotifications = can(role, 'notifications:manage');
  // Derived from what they actually can't do here, not from the role name — a future read-only
  // role would otherwise land on this page with no explanation of why nothing is clickable.
  const readOnlyHere = !canEditCategories && !canManageUsers;
  const [categories, setCategories] = useState<Category[]>(initialCategories);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleUpdate(id: string, values: CategoryFormValues) {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/categories/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
      });
      const body = await res.json() as Category & { error?: string };
      if (!res.ok) { setError(body.error ?? 'Failed to update category'); return; }
      setCategories(cs => cs.map(c => c.id === id ? body : c));
      setEditingId(null);
    } finally { setSaving(false); }
  }

  async function handleCreate(values: CategoryFormValues) {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/categories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
      });
      const body = await res.json() as Category & { error?: string };
      if (!res.ok) { setError(body.error ?? 'Failed to create category'); return; }
      setCategories(cs => [...cs, body]);
      setCreating(false);
    } finally { setSaving(false); }
  }

  async function handleDelete(cat: Category) {
    if (!confirm(`Delete "${cat.label}"? Rules already using this category keep their category value but lose their Scans tab.`)) return;
    setError(null);
    const res = await fetch(`/api/categories/${encodeURIComponent(cat.id)}`, { method: 'DELETE' });
    if (!res.ok) {
      const body = await res.json() as { error?: string };
      setError(body.error ?? 'Failed to delete category');
      return;
    }
    setCategories(cs => cs.filter(c => c.id !== cat.id));
  }

  return (
    <div className="max-w-4xl space-y-6">
      {readOnlyHere && (
        /* A plain panel, not a warning. Read-only access is a normal way to hold
           an account, so it states the fact without raising an alarm about it. */
        <div className="flex items-center gap-2 border border-border bg-surface-sunken px-4 py-2.5 text-sm text-ink-2">
          <Eye className="size-3.5 shrink-0 text-ink-muted" />
          You have {ROLE_LABELS[role]} access. You can see everything here, but not change it.
        </div>
      )}

      {/* Appearance comes first because it is the only section on this page every
          role can use. It is a personal preference, stored per browser, so it is
          not gated on a role and never writes to the database. */}
      <Card>
        <CardHeader>
          <CardTitle>Appearance</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <ThemeToggle />
          <p className="text-xs text-ink-2">
            System follows whatever your computer is set to, and changes with it.
          </p>
        </CardContent>
      </Card>

      {/* Sign-in first, Azure connection second, deliberately: how you get into RuleBeat at all
          comes before what RuleBeat can see once you're in. */}
      {canManageAuth && initialSignInStatus && (
        <SignInSection initialStatus={initialSignInStatus} />
      )}

      {canManageAzure && initialAzureStatus && (
        <AzureConnectionSection initialStatus={initialAzureStatus} />
      )}

      {canManageNotifications && initialChannels !== null && (
        <NotificationsSection initialChannels={initialChannels} />
      )}

      <Card>
        <CardHeader>
          <CardTitle>Categories</CardTitle>
          {!creating && canEditCategories && (
            <Button size="sm" variant="outline" onClick={() => { setCreating(true); setEditingId(null); }}>
              <Plus className="h-3.5 w-3.5" />
              New category
            </Button>
          )}
        </CardHeader>
        <CardContent className="p-0">
          {error && <Callout tone="error" className="border-x-0 border-t-0">{error}</Callout>}
          <TableScroll>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead shrink>Color</TableHead>
                  <TableHead>Label</TableHead>
                  <TableHead>Slug</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead shrink />
                </TableRow>
              </TableHeader>
              <TableBody>
              {categories.map(cat => {
                const Icon = ICON_MAP[cat.icon ?? ''] ?? Folder;
                if (editingId === cat.id) {
                  return (
                    <EditRow
                      key={cat.id}
                      initial={{ label: cat.label, color: cat.color ?? COLOR_SWATCHES[0], icon: cat.icon ?? 'Folder' }}
                      onSave={v => { void handleUpdate(cat.id, v); }}
                      onCancel={() => setEditingId(null)}
                      saving={saving}
                    />
                  );
                }
                return (
                  <TableRow key={cat.id} className="group">
                    <TableCell shrink>
                      {/* The category colour is the user's own choice and carries no
                          severity meaning, so it stays a small solid square beside a
                          neutral icon rather than tinting a whole tile. */}
                      <span className="flex items-center gap-2">
                        <span
                          className="size-3 shrink-0 border border-border"
                          style={{ backgroundColor: cat.color ?? 'var(--color-ink-faint)' }}
                        />
                        <Icon className="size-3.5 text-ink-muted" />
                      </span>
                    </TableCell>
                    <TableCell className="font-medium text-ink">{cat.label}</TableCell>
                    <TableCell className="font-mono text-xs text-ink">{cat.id}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1.5">
                        {cat.isBuiltin && (
                          <span className="inline-flex items-center gap-1 bg-surface-sunken px-1.5 py-0.5 text-xs font-medium text-ink-2">
                            <Lock className="size-2.5 shrink-0" />
                            Built-in
                          </span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell shrink>
                      {canEditCategories && (
                        <div className="flex items-center justify-end gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                          <Button
                            variant="ghost" size="icon-sm" title="Edit category"
                            onClick={() => { setEditingId(cat.id); setCreating(false); }}
                          >
                            <Pencil className="size-3.5" />
                          </Button>
                          {!cat.isBuiltin && (
                            <Button
                              variant="ghost" size="icon-sm" title="Delete category"
                              className="hover:text-sev-critical"
                              onClick={() => { void handleDelete(cat); }}
                            >
                              <Trash2 className="size-3.5" />
                            </Button>
                          )}
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
              {creating && (
                <EditRow
                  initial={{ label: '', color: COLOR_SWATCHES[0], icon: 'Folder' }}
                  onSave={v => { void handleCreate(v); }}
                  onCancel={() => setCreating(false)}
                  saving={saving}
                />
              )}
              </TableBody>
            </Table>
          </TableScroll>
        </CardContent>
      </Card>

      {canManageUsers && (
        <UsersSection
          initialUsers={initialUsers}
          initialUsersWithPassword={initialUsersWithPassword}
          currentUserId={currentUserId}
        />
      )}
    </div>
  );
}
