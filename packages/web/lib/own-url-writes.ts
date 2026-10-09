/**
 * Tells the explorer's own URL writes from a navigation that came from somewhere else.
 *
 * The explorer starts from the URL once and then writes every change back with router.replace. When
 * the URL changes by anything other than one of those writes (a saved view opened from the menu,
 * Back or Forward, a link from another page) the explorer has to start again from the new URL. Its
 * writes can land late and out of step with the next ones, so every query it wrote counts as its
 * own until an outside navigation is seen, which starts the record over.
 */
export class OwnUrlWrites {
  private own: Set<string>;

  constructor(initialQuery: string) {
    this.own = new Set([initialQuery]);
  }

  /** The explorer is about to write `query` to the URL. */
  record(query: string): void {
    this.own.add(query);
  }

  /** Forgets every write so far, for a navigation about to be made on purpose: the URL it lands on
   *  must read as an outside one even if the explorer once wrote that same query. */
  forget(): void {
    this.own.clear();
  }

  /** True when the URL now holds `query` and the explorer did not write it. Seeing one starts the
   *  record over from it, so the explorer's next writes count as its own again. */
  isOutside(query: string): boolean {
    if (this.own.has(query)) return false;
    this.own = new Set([query]);
    return true;
  }
}
