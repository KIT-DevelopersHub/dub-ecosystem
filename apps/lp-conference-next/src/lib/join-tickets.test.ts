// Run: node --test src/lib/join-tickets.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { JOIN_TICKETS_ATTR, joinTicketsAttributes } from "./join-tickets.ts";

test("販売 on + CTA 差し替え on で参加者カードを購入リンクにする", () => {
  assert.deepEqual(joinTicketsAttributes({ enabled: true, ctaEnabled: true }), { [JOIN_TICKETS_ATTR]: "on" });
});

test("販売 off / CTA off / 設定なしは今まで通り（準備中）", () => {
  assert.deepEqual(joinTicketsAttributes({ enabled: false, ctaEnabled: true }), {});
  assert.deepEqual(joinTicketsAttributes({ enabled: true, ctaEnabled: false }), {});
  assert.deepEqual(joinTicketsAttributes(null), {});
});
