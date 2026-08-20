'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { useSidebarPref } from '@/lib/hooks/use-sidebar-pref';
import { can, type Role } from '@/lib/rbac';
import {
  LayoutDashboard, Settings, Library, EyeOff, Radar, PanelLeftClose, PanelLeft, ScrollText, Activity, Terminal,
  type LucideIcon,
} from 'lucide-react';

/* The sidebar is light on both grounds now.
 *
 * It used to be a dark panel beside a light page, which is where a whole class
 * of colour bugs came from: shared tokens like `muted` and `foreground` resolve
 * to the light theme, so every one of them had to be overridden by hand with
 * white/opacity classes, and those overrides then survived invisibly into dark
 * mode. One ground, one token set, no exceptions.
 *
 * The active item is marked by a solid bar and weight, not by colour. Red stays
 * reserved for things that are genuinely critical, and a page you are simply
 * looking at is not one of them. */

const staticNavTop = [
  { href: '/dashboard',    label: 'Dashboards',   icon: LayoutDashboard },
  { href: '/library',      label: 'Library',      icon: Library },
  { href: '/scans',        label: 'Scans',        icon: Radar   },
  { href: '/suppressions', label: 'Suppressions',  icon: EyeOff  },
];

const staticNavBottom = [
  { href: '/settings', label: 'Settings', icon: Settings },
];

const auditNavItem = { href: '/audit', label: 'Audit log', icon: ScrollText };
const diagnosticsNavItem = { href: '/diagnostics', label: 'Diagnostics', icon: Activity };
const queryNavItem = { href: '/query', label: 'Query', icon: Terminal };

const RAIL_WIDTH = 64;
const EXPANDED_WIDTH = 256;

// Defined at module scope (not inside Sidebar's render) — a component defined inside a render
// function gets a new function identity every render, which React treats as a new component
// type and remounts, losing state/focus. See docs/engineering/conventions/ui.md.
function NavItem({ item, active, expanded }: {
  item: { href: string; label: string; icon: LucideIcon };
  active: boolean;
  expanded: boolean;
}) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      title={!expanded ? item.label : undefined}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'group relative flex h-9 items-center gap-3 text-sm transition-colors',
        expanded ? 'px-3' : 'justify-center px-0',
        active
          ? 'bg-sidebar-accent font-medium text-ink'
          : 'text-ink-2 hover:bg-surface-hover hover:text-ink',
      )}
    >
      {/* The marker is a bar down the left edge, so it reads the same whether the
          rail is collapsed to icons or expanded to labels. */}
      {active && <span aria-hidden="true" className="absolute inset-y-0 left-0 w-0.5 bg-ink" />}
      <Icon className="size-4 shrink-0" />
      {expanded && <span className="min-w-0 flex-1 truncate leading-none">{item.label}</span>}
    </Link>
  );
}

export function Sidebar({ initialPinned, role }: { initialPinned: boolean; role: Role }) {
  const pathname = usePathname();
  const topNav = [
    ...staticNavTop,
    ...(can(role, 'rules:validate') ? [queryNavItem] : []),
  ];
  const bottomNav = [
    ...staticNavBottom,
    ...(can(role, 'audit:read') ? [auditNavItem] : []),
    ...(can(role, 'azure:manage') ? [diagnosticsNavItem] : []),
  ];
  const { pinned, expanded, setPinned, hoverHandlers } = useSidebarPref('sidebar:main', initialPinned);
  // The aside is always absolutely positioned (avoids toggling `position` mid-transition, which
  // caused a one-frame flash as the width animated). Unpinned + hover-expanded flies out as an
  // overlay over content; pinned (docked) or truly collapsed both reserve their own layout space
  // via the wrapper below instead, so visually nothing overlaps.
  const overlay = expanded && !pinned;
  const asideWidth = expanded ? EXPANDED_WIDTH : RAIL_WIDTH;
  // The wrapper reserves real layout space equal to the aside's width — except in overlay mode,
  // where the aside flies out over content and the wrapper stays at the rail width instead.
  const wrapperWidth = overlay ? RAIL_WIDTH : asideWidth;

  return (
    <div
      className="relative h-full shrink-0"
      style={{ width: wrapperWidth }}
      {...hoverHandlers}
    >
      <aside
        className={cn(
          'absolute inset-y-0 left-0 z-40 flex h-full flex-col border-r border-sidebar-border bg-sidebar transition-[width] duration-200',
          overlay && 'shadow-overlay',
        )}
        style={{ width: asideWidth }}
      >
        {/* Logo.
         *
         * Two files per state rather than one recoloured by CSS: the mark is a black
         * tile on light and an off-white tile on dark, which is a swap of the artwork,
         * not a tint. Both carry the same alt text and exactly one is ever displayed,
         * so the accessible name is announced once either way.
         *
         * Sources are 2x (64px tile, 306px lockup) drawn at 32px high. `overflow-hidden`
         * matters during the 200ms rail-to-expanded transition, where the full-width
         * lockup is briefly wider than the box it sits in. */}
        <div className={cn(
          'flex h-16 shrink-0 items-center overflow-hidden border-b border-sidebar-border',
          expanded ? 'gap-3 px-4' : 'justify-center px-2',
        )}>
          <Link href="/dashboard" className="flex shrink-0 items-center" title="Go to dashboard">
            {expanded ? (
              <>
                <img src="/brand/lockup.png" alt="RuleBeat" className="h-8 w-auto shrink-0 dark:hidden" />
                <img src="/brand/lockup-dark.png" alt="RuleBeat" className="hidden h-8 w-auto shrink-0 dark:block" />
              </>
            ) : (
              <>
                <img src="/brand/mark.png" alt="RuleBeat" className="size-8 shrink-0 dark:hidden" />
                <img src="/brand/mark-dark.png" alt="RuleBeat" className="hidden size-8 shrink-0 dark:block" />
              </>
            )}
          </Link>
          {expanded && (
            <button
              type="button"
              onClick={() => setPinned(!pinned)}
              title={pinned ? 'Collapse sidebar' : 'Pin sidebar open'}
              className="ml-auto flex size-7 shrink-0 items-center justify-center text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink"
            >
              {pinned ? <PanelLeftClose className="size-4" /> : <PanelLeft className="size-4" />}
            </button>
          )}
        </div>

        {/* Nav */}
        <nav className="scroll-y flex-1 space-y-6 py-4">

          {/* Main section */}
          <div className="space-y-px">
            {topNav.map((item) => {
              // '/dashboard' covers the redirector itself plus '/dashboards' (gallery) and
              // '/dashboards/[id]' — a plain prefix match on item.href would miss the extra 's'.
              const active = item.href === '/dashboard'
                ? pathname.startsWith('/dashboard')
                : pathname === item.href || pathname.startsWith(item.href + '/');
              return <NavItem key={item.href} item={item} active={active} expanded={expanded} />;
            })}
          </div>

          {/* Settings section */}
          <div className="space-y-px">
            {expanded && <p className="label-grid mb-2 px-3 select-none">Settings</p>}
            {bottomNav.map((item) => {
              const active = pathname === item.href;
              return <NavItem key={item.href} item={item} active={active} expanded={expanded} />;
            })}
          </div>
        </nav>

        {/* Footer — both variants stay mounted and cross-fade via opacity instead of a hard
            conditional swap, so the content doesn't pop instantly while the aside's own width
            is still animating (a discrete mount/unmount has no transition to ride along with). */}
        <div className="relative h-[52px] shrink-0 overflow-hidden border-t border-sidebar-border">
          <div className={cn(
            'absolute inset-0 flex items-center gap-3 px-4 transition-opacity duration-150',
            expanded ? 'opacity-100' : 'pointer-events-none opacity-0',
          )}>
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-medium leading-none text-ink">Community</p>
              <p className="label-grid mt-1.5">Free plan</p>
            </div>
          </div>

          <div className={cn(
            'absolute inset-0 flex items-center justify-center transition-opacity duration-150',
            !expanded ? 'opacity-100' : 'pointer-events-none opacity-0',
          )}>
            <button
              type="button"
              onClick={() => setPinned(!pinned)}
              title={pinned ? 'Collapse sidebar' : 'Pin sidebar open'}
              className="flex size-7 shrink-0 items-center justify-center text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink"
            >
              <PanelLeft className="size-4" />
            </button>
          </div>
        </div>
      </aside>
    </div>
  );
}
