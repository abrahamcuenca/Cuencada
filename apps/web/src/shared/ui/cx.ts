/**
 * Joins class names, skipping falsy values. CSS Module lookups are typed
 * `string | undefined` under `noUncheckedIndexedAccess`, so this accepts both.
 */
export function cx(...names: ReadonlyArray<string | false | null | undefined>): string {
  return names.filter(Boolean).join(" ");
}

/**
 * True when a ReactNode slot (hint, error) has something to render. Shared by
 * Field and Checkbox/Switch so `undefined`, `null`, `false` and `""` are treated
 * alike (and `0` is rendered).
 */
export function hasContent(node: unknown): boolean {
  return node !== undefined && node !== null && node !== false && node !== "";
}
