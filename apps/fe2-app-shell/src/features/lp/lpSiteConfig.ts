// 公開設定の純粋ロジック（編集・差分・プレビュー URL）。UI は登録簿（LP_SECTION_REGISTRY）を
// 汎用に描くので、バリアント・オプションを登録簿に足すだけで画面にも差分にも出る。
import { lp } from "@dub/types";
import type { LpSiteConfig } from "./lpApi.tsx";
import { LP_VERSIONS } from "./lpVersions.ts";
import { lpPreviewUrl } from "./lpPublish.ts";

export type LpConfigEnv = "draft" | "live";

export function parseEnv(searchStr: string | undefined): LpConfigEnv {
  return new URLSearchParams(searchStr ?? "").get("env") === "live" ? "live" : "draft";
}

export type ReleaseFlag = "ticketsEnabled" | "ticketsCtaEnabled" | "proposalsEnabled";

export const RELEASE_FLAGS: readonly { key: ReleaseFlag; label: string; on: string; off: string }[] = [
  { key: "ticketsEnabled", label: "チケット販売", on: "公開", off: "停止" },
  { key: "ticketsCtaEnabled", label: "参加登録ボタンの差し替え", on: "購入ボタン", off: "元の表示" },
  { key: "proposalsEnabled", label: "登壇者募集", on: "募集中", off: "停止" },
];

export function versionName(id: string): string {
  return LP_VERSIONS.find((v) => v.id === id)?.name ?? id;
}

export function setRelease<K extends keyof lp.LpRelease>(config: LpSiteConfig, key: K, value: lp.LpRelease[K]): LpSiteConfig {
  return { ...config, release: { ...config.release, [key]: value } };
}

/** 1 セクションの一部を変える。他のセクションの「書いていない = 既定値」はそのまま残す。 */
export function setSection(
  config: LpSiteConfig,
  id: lp.LpSectionId,
  patch: { variant?: string; visible?: boolean; option?: { key: string; value: lp.LpOptionValue } },
): LpSiteConfig {
  const cur = lp.resolveSection(config.layout, id);
  const next: lp.LpSectionSetting = {
    variant: patch.variant ?? cur.variant,
    visible: patch.visible ?? cur.visible,
    options: patch.option ? { ...cur.options, [patch.option.key]: patch.option.value } : cur.options,
  };
  return { ...config, layout: { ...config.layout, sections: { ...config.layout.sections, [id]: next } } };
}

export interface ConfigDiff {
  key: string;
  label: string;
  from: string;
  to: string;
}

function optionText(def: lp.LpOptionDef, v: lp.LpOptionValue): string {
  if (def.kind === "boolean") return v ? "表示" : "非表示";
  return def.values?.[String(v)] ?? String(v);
}

/** before → after の差分（版・3 つのフラグ・各セクションのバリアント/表示/オプション）。登録簿の並び順。 */
export function diffSiteConfig(before: LpSiteConfig, after: LpSiteConfig): ConfigDiff[] {
  const out: ConfigDiff[] = [];
  if (before.release.versionId !== after.release.versionId) {
    out.push({ key: "versionId", label: "公開する版", from: versionName(before.release.versionId), to: versionName(after.release.versionId) });
  }
  for (const f of RELEASE_FLAGS) {
    const a = before.release[f.key];
    const b = after.release[f.key];
    if (a !== b) out.push({ key: f.key, label: f.label, from: a ? f.on : f.off, to: b ? f.on : f.off });
  }
  for (const id of lp.LP_SECTION_IDS) {
    const def: lp.LpSectionDef = lp.LP_SECTION_REGISTRY[id];
    const a = lp.resolveSection(before.layout, id);
    const b = lp.resolveSection(after.layout, id);
    if (a.variant !== b.variant) {
      out.push({ key: `${id}.variant`, label: `${def.label}のバリアント`, from: def.variants[a.variant] ?? a.variant, to: def.variants[b.variant] ?? b.variant });
    }
    if (a.visible !== b.visible) {
      out.push({ key: `${id}.visible`, label: def.label, from: a.visible ? "表示" : "非表示", to: b.visible ? "表示" : "非表示" });
    }
    for (const [k, od] of Object.entries(def.options ?? {})) {
      if (a.options[k] !== b.options[k]) {
        out.push({ key: `${id}.options.${k}`, label: `${def.label}: ${od.label}`, from: optionText(od, a.options[k]!), to: optionText(od, b.options[k]!) });
      }
    }
  }
  return out;
}

/** チケット販売を「公開」にする変更か（今と同じ ack を必須にする）。 */
export function enablesTickets(before: LpSiteConfig, after: LpSiteConfig): boolean {
  return !before.release.ticketsEnabled && after.release.ticketsEnabled;
}

/** 版・チケット・募集だけを URL で当てたプレビュー（セクションは公開中の見た目）。本番のミニプレビュー用。 */
export function releasePreviewUrl(config: LpSiteConfig): string {
  return lpPreviewUrl(config.release.versionId, {
    tickets: config.release.ticketsEnabled ? "on" : "off",
    proposals: config.release.proposalsEnabled ? "on" : "off",
  });
}

/** 下書きのプレビュー URL: 下書きの版・チケット・募集で既存のプレビュー URL を作り、&config=draft で下書きの見た目を当てる。 */
export function draftPreviewUrl(draft: LpSiteConfig, previewToken?: string): string {
  return `${lpPreviewUrl(draft.release.versionId, {
    tickets: draft.release.ticketsEnabled ? "on" : "off",
    proposals: draft.release.proposalsEnabled ? "on" : "off",
    previewToken,
  })}&config=draft`;
}
