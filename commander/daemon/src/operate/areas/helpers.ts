import type { CatalogEntry } from "../catalog-types.ts";

const READ_IMPACT = "読み取りのみ。データは変わりません。";

/** A GET entry: reads are always low risk and change nothing. */
export function read(e: Omit<CatalogEntry, "method" | "kind" | "reversible" | "risk" | "impact">): CatalogEntry {
  return { ...e, method: "GET", kind: "read", reversible: true, risk: "low", impact: READ_IMPACT };
}
