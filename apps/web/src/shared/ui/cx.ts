/**
 * Joins class names, skipping falsy values. CSS Module lookups are typed
 * `string | undefined` under `noUncheckedIndexedAccess`, so this accepts both.
 */
export function cx(...names: ReadonlyArray<string | false | null | undefined>): string {
  return names.filter(Boolean).join(" ");
}
