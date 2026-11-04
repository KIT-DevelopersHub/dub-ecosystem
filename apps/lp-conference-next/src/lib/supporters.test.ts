import { test } from "node:test";
import assert from "node:assert/strict";
import { supporterGroups, supporterTiers } from "./supporters.ts";

const base = { heading: "h", emptyNote: "e" };

test("旧形式の names[] は other 段になる", () => {
  const tiers = supporterTiers({ ...base, names: ["A", "B"] });
  assert.deepEqual(tiers, [{ id: "other", label: "ご支援者様", items: [{ name: "A" }, { name: "B" }] }]);
});

test("データが無ければ空（emptyNote を出す側）", () => {
  assert.deepEqual(supporterGroups({ ...base, names: [] }), []);
  assert.deepEqual(
    supporterGroups({ ...base, tiers: [{ id: "gold", label: "x", items: [] }, { id: "other", label: "y", items: [{ name: " " }] }] }),
    [],
  );
});

test("同じ見出しの gold / silver は 1 グループ、other は別グループ", () => {
  const groups = supporterGroups({
    ...base,
    tiers: [
      { id: "gold", label: "多大", items: [{ name: "A", message: "m" }] },
      { id: "silver", label: "多大", items: [{ name: "B" }] },
      { id: "other", label: "その他", items: [{ name: "C" }] },
    ],
  });
  assert.deepEqual(
    groups.map((g) => [g.label, g.kind, g.tiers.map((t) => t.id)]),
    [
      ["多大", "framed", ["gold", "silver"]],
      ["その他", "list", ["other"]],
    ],
  );
});

test("空の段は落ちて、見出しが違えば分かれる", () => {
  const groups = supporterGroups({
    ...base,
    tiers: [
      { id: "gold", label: "金", items: [] },
      { id: "silver", label: "銀", items: [{ name: "B" }] },
    ],
  });
  assert.deepEqual(groups.map((g) => g.label), ["銀"]);
});
