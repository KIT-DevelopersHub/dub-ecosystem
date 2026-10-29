// Run: node --test worker/legacy-redirect.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { CURRENT_LP_ORIGIN, legacyRedirect, redirectTarget } from "./legacy-redirect.ts";

const OLD = "https://lp-conference-next-v2-1.developershub-site.workers.dev";

test("root redirects to the current LP", () => {
  assert.equal(redirectTarget(`${OLD}/`), `${CURRENT_LP_ORIGIN}/`);
});

test("path and query are kept", () => {
  assert.equal(redirectTarget(`${OLD}/tickets?ref=x`), `${CURRENT_LP_ORIGIN}/tickets?ref=x`);
});

test("fetch answers 301 with Location", () => {
  const res = legacyRedirect(new Request(`${OLD}/`));
  assert.equal(res.status, 301);
  assert.equal(res.headers.get("location"), `${CURRENT_LP_ORIGIN}/`);
});
