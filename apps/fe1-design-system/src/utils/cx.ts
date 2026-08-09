// Tiny className joiner. Tolerates undefined/false so CSS-Module class refs that
// are absent under vitest's css handling collapse away without crashing.
export type ClassValue = string | undefined | null | false;

export function cx(...values: ClassValue[]): string | undefined {
  const joined = values.filter(Boolean).join(" ");
  return joined.length > 0 ? joined : undefined;
}
