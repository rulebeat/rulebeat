/**
 * The two defaults a dashboard can be (ADR 0012), as the console reads them. Pure, with no DB or Node imports.
 *
 * The notice is the one line a person is shown once after their My default stopped being reachable:
 * `/dashboard` redirects with `?notice=default-dashboard-unavailable`, and the page it lands on shows the
 * message, so the redirect and both landing pages read the same words.
 */
export const DEFAULT_UNAVAILABLE_NOTICE = 'default-dashboard-unavailable';

export const DEFAULT_UNAVAILABLE_MESSAGE =
  'The dashboard you had chosen as your default is no longer available to you. Choose another one from its menu.';

/** The notice text for a `notice` query value, or null for anything else: an unknown value shows nothing. */
export function noticeFor(value: string | string[] | undefined): string | null {
  return value === DEFAULT_UNAVAILABLE_NOTICE ? DEFAULT_UNAVAILABLE_MESSAGE : null;
}

/** `path` with the notice appended. */
export function withNotice(path: string): string {
  return `${path}?notice=${DEFAULT_UNAVAILABLE_NOTICE}`;
}

/** `dashboards` with `isMyDefault` set on the one the person chose, and false on the rest. */
export function withMyDefault<T extends { id: string }>(dashboards: readonly T[], myDefaultId: string | null): (T & { isMyDefault: boolean })[] {
  return dashboards.map(d => ({ ...d, isMyDefault: d.id === myDefaultId }));
}
