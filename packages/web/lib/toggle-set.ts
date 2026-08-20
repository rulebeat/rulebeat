/** Toggle `value` in/out of `set`, returning a new Set (never mutates the input) — the shared
 *  building block for every "click to add/remove from a filter/expanded-state Set" handler. */
export function toggleInSet<T>(set: Set<T>, value: T): Set<T> {
  const next = new Set(set);
  if (next.has(value)) {
    next.delete(value);
  } else {
    next.add(value);
  }
  return next;
}
