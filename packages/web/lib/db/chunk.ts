/** How many values one statement binds in an `IN (...)` list: well under SQLite's default limit of
 *  999 bound variables per statement. */
export const CHUNK_SIZE = 500;

/** `items` split into runs of at most `size`, in order. */
export function chunk<T>(items: readonly T[], size: number = CHUNK_SIZE): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
