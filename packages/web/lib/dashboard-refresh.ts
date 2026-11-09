/**
 * The auto-refresh interval has two homes (ADR 0013). Outside edit mode a pick applies only to the open
 * page: it is not saved and not in the address, so one person's choice never changes it for everyone.
 * The saved interval is set in edit mode and saved with the layout. Pure and client-safe.
 */

export interface RefreshChoice {
  /** The open page's own interval, or null while the page follows the saved one. */
  page: number | null;
  /** The interval an open layout edit will save, or null while it keeps the saved one. */
  draft: number | null;
}

export const NO_REFRESH_CHOICE: RefreshChoice = { page: null, draft: null };

/** The interval the open page counts down with. A layout edit in progress does not change it. */
export function pageInterval(saved: number, choice: RefreshChoice): number {
  return choice.page ?? saved;
}

/** The interval the picker shows: the one the layout edit will save, or else the page's own. */
export function shownInterval(editMode: boolean, saved: number, choice: RefreshChoice): number {
  return editMode ? choice.draft ?? saved : pageInterval(saved, choice);
}

/** What a pick does. Only a pick in edit mode is part of a save, so only it leaves the layout changed. */
export function pickInterval(editMode: boolean, choice: RefreshChoice, value: number): { choice: RefreshChoice; layoutChanged: boolean } {
  return editMode
    ? { choice: { ...choice, draft: value }, layoutChanged: true }
    : { choice: { ...choice, page: value }, layoutChanged: false };
}

/** The interval a layout save carries. */
export function savedInterval(saved: number, choice: RefreshChoice): number {
  return choice.draft ?? saved;
}
