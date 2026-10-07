/** Changed field names only, including structured values, shared by review and audit. */
export function changedFields<T extends object>(before: T, after: Partial<T>): Array<keyof T> {
  const keys = Object.keys(after) as Array<keyof T>;
  return keys.filter(key => {
    return JSON.stringify(after[key]) !== JSON.stringify(before[key]);
  });
}
