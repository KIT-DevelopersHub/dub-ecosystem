// 公開設定（セクション切り替え）の純粋ロジック。LP のビルド（CSS 生成）と LP Worker（<html> の属性）が共用する。
// 属性名と layout → 属性の対応は packages/types/src/lp.ts が正本（LP管理のミニプレビューとも共用）。
// 登録簿は引数で受け取る（テストで差し替える）。.ts 付きの import は node --test の strip-only TS 向け。
import type { LpSectionDef } from "../../../../packages/types/src/lp.ts";
import { lpSectionAttr as sectionAttr, lpOptionAttr as optionAttr, LP_HIDDEN as HIDDEN } from "../../../../packages/types/src/lp.ts";

export { sectionAttr, optionAttr, HIDDEN };
export { layoutAttributes } from "../../../../packages/types/src/lp.ts";

type Registry = Readonly<Record<string, LpSectionDef>>;

const SAFE_ID = /^[a-z0-9_]+$/;

function assertId(id: string, where: string): string {
  if (!SAFE_ID.test(id) || id === HIDDEN) throw new Error(`lp section registry: unsafe id "${id}" (${where})`);
  return id;
}

/**
 * 登録簿から CSS を作る。属性が無い（= Worker を通らない・設定が取れない・既定値）ときは
 * 既定のバリアントだけが見える。知らない値の属性も既定値として扱う（古い版に新しい値が来ても壊れない）。
 * スロットとバリアントの包みは display:contents なので、既定の見た目は包む前と同じ。
 */
export function siteConfigCss(registry: Registry): string {
  const rules: string[] = ["[data-lp-slot],[data-lp-slot]>[data-lp-variant]{display:contents}"];
  for (const [rawId, def] of Object.entries(registry)) {
    const id = assertId(rawId, "section");
    const attr = sectionAttr(id);
    const slot = `[data-lp-slot="${id}"]`;
    const d = assertId(def.defaultVariant, `${id}.defaultVariant`);
    rules.push(`${slot}>[data-lp-variant]:not([data-lp-variant="${d}"]){display:none}`);
    for (const rawV of Object.keys(def.variants)) {
      const v = assertId(rawV, `${id}.variants`);
      if (v === d) continue;
      rules.push(`html[${attr}="${v}"] ${slot}>[data-lp-variant="${v}"]{display:contents}`);
      rules.push(`html[${attr}="${v}"] ${slot}>[data-lp-variant="${d}"]{display:none}`);
    }
    if (def.hideable) {
      rules.push(`html[${attr}="${HIDDEN}"] ${slot},html[${attr}="${HIDDEN}"] [data-lp-nav="${id}"]{display:none!important}`);
    }
    for (const [rawK, o] of Object.entries(def.options ?? {})) {
      const k = assertId(rawK, `${id}.options`);
      const oa = optionAttr(id, k);
      const el = `[data-lp-opt="${id}-${k}"]`;
      if (o.kind === "boolean") {
        rules.push(o.default ? `html[${oa}="off"] ${el}{display:none!important}` : `html:not([${oa}="on"]) ${el}{display:none!important}`);
        continue;
      }
      const values = Object.keys(o.values ?? {}).map((v) => assertId(v, `${id}.options.${k}`));
      const others = values.filter((v) => v !== o.default);
      for (const v of others) rules.push(`html:not([${oa}="${v}"]) ${el}[data-lp-opt-value="${v}"]{display:none!important}`);
      if (others.length > 0) {
        rules.push(`${others.map((v) => `html[${oa}="${v}"] ${el}[data-lp-opt-value="${String(o.default)}"]`).join(",")}{display:none!important}`);
      }
    }
  }
  return rules.join("\n");
}
