// CI invariant: the LP tickets wire types have exactly one definition (src/lp-tickets.ts).
// services/lp-tickets and fe2 (LP管理) alias them; a local `interface LpTicket…` or a
// non-alias `type LpTicket… =` in either file is a second definition that can drift.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const repo = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const CONSUMERS = ["services/lp-tickets/src/types.ts", "apps/fe2-app-shell/src/features/lp/lpApi.tsx"];
const contractNames = [...readFileSync(repo("packages/types/src/lp-tickets.ts"), "utf8").matchAll(/^export (?:interface|type) (\w+)/gm)].map(
  (m) => m[1] as string,
);

describe("lpTickets contract — single source", () => {
  it("declares the wire types", () => {
    expect(contractNames).toEqual(expect.arrayContaining(["LpTicketsState", "LpTicketOrder", "LpTicketCoupon", "LpTicketTypeInput"]));
  });

  for (const file of CONSUMERS) {
    it(`${file} only aliases the contract`, () => {
      const src = readFileSync(repo(file), "utf8");
      const redeclared: string[] = [];
      for (const name of contractNames) {
        if (new RegExp(`^export interface ${name}\\b`, "m").test(src)) redeclared.push(name);
        const alias = src.match(new RegExp(`^export type ${name}\\s*=\\s*([^;]+);`, "m"));
        if (alias && alias[1]?.trim() !== `lpTickets.${name}`) redeclared.push(name);
      }
      expect(redeclared).toEqual([]);
    });
  }
});
