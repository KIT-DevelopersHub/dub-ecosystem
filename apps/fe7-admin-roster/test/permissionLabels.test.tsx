// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { useState } from "react";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { identity, appRegistry, policy } from "@dub/types";
import { domainLabel, permissionLabel, permissionDescription } from "../src/lib/permissionLabels";
import { RolePolicyEditor } from "../src/components/RolePolicyEditor";
import { renderWithProviders } from "./renderWithProviders";

const catalog = [...identity.PERMISSION_CATALOG];

describe("permissionLabels — localization map", () => {
  it("maps every catalog domain to a Japanese group heading", () => {
    const domains = [...new Set(catalog.map((e) => e.domain))];
    for (const d of domains) {
      const label = domainLabel(d);
      expect(label).not.toBe(d); // localized, not the raw english domain
      expect(label).toMatch(/[぀-ヿ一-龯]|GitHub|Drive|Webhook/); // ja text (or proper noun)
    }
  });

  it("maps every catalog key to a Japanese label + description", () => {
    for (const e of catalog) {
      expect(permissionLabel(e.key, e.name)).not.toBe(e.name); // localized away from english
      expect(permissionDescription(e.key, e.description)).not.toBe(e.description);
    }
  });

  // Regression: the per-app labels used to be a hand-written list that had already drifted
  // (a newly registered app's app:<id>:* fell back to English). They are derived from
  // APP_MANIFEST now, so EVERY registered app is covered by construction.
  it("labels both access keys of every registered app from APP_MANIFEST", () => {
    for (const app of appRegistry.APP_MANIFEST) {
      for (const key of [app.access.view, app.access.edit]) {
        expect(permissionLabel(key, "EN")).toContain(app.label);
      }
    }
  });

  it("falls back to catalog english text for an unknown key/domain", () => {
    expect(domainLabel("unknown-domain")).toBe("unknown-domain");
    expect(permissionLabel("unknown:key", "English Name")).toBe("English Name");
    expect(permissionDescription("unknown:key", "English desc")).toBe("English desc");
  });
});

describe("RolePolicyEditor — アプリのアクセス権が軸、詳細はダイアログ、その他は下", () => {
  // usePermissions などの provider に依存するので、roster の provider ごと描画する
  //（bare render では query client が無い）。
  const setup = (selected: identity.PermissionKey[] = [], opts: { disabled?: boolean; lockedKeys?: identity.PermissionKey[] } = {}) => {
    const onChange = vi.fn((_next: identity.PermissionKey[]) => {});
    renderWithProviders(
      <RolePolicyEditor
        selected={selected}
        onChange={onChange}
        disabled={opts.disabled}
        lockedKeys={opts.lockedKeys ?? []}
      />,
    );
    return { onChange };
  };

  // 「アプリのアクセス権」が画面の軸 = 一番上のセクション。その下に「その他」。
  it("「アプリのアクセス権」セクションが一番上、その下に「その他」がある", () => {
    setup([]);
    const editor = screen.getByTestId("fe7-role-policy-editor");
    const apps = screen.getByTestId("fe7-app-access-table");
    const other = screen.getByTestId("fe7-other-permissions");
    expect(within(apps).getByRole("heading", { name: "アプリのアクセス権" })).toBeInTheDocument();
    expect(within(other).getByRole("heading", { name: "その他（どのアプリにも属さない権限）" })).toBeInTheDocument();
    // DOM 順で アプリのアクセス権 → その他（節の入れ替えを検知する）
    const sections = [...editor.children];
    expect(sections.indexOf(apps)).toBeLessThan(sections.indexOf(other));
  });

  it("renders one row per registered app with its Japanese name and level", () => {
    setup(["app:mail:view"]);
    for (const app of appRegistry.APP_MANIFEST) {
      expect(screen.getByTestId(`fe7-app-name-${app.id}`).textContent).toContain(app.label);
    }
    expect(screen.getByTestId("fe7-app-state-mail").textContent).toBe("閲覧");
    expect(screen.getByTestId("fe7-app-state-events").textContent).toBe("無効");
  });

  it("selecting 編集 emits BOTH graded keys (edit ⇒ view)", async () => {
    const user = userEvent.setup();
    const { onChange } = setup([]);
    await user.click(screen.getByTestId("fe7-app-level-mail-edit"));
    expect(onChange.mock.calls[0]?.[0]).toEqual(["app:mail:edit", "app:mail:view"]);
  });

  it("selecting 無効 clears the app's graded keys but keeps its detail keys", async () => {
    const user = userEvent.setup();
    const { onChange } = setup(["app:mail:view", "app:mail:edit", "mail:send"]);
    await user.click(screen.getByTestId("fe7-app-level-mail-none"));
    expect(onChange.mock.calls[0]?.[0]).toEqual(["mail:send"]);
  });

  it("clicking the app NAME opens the 詳細設定 dialog with that app's fine-grained keys", async () => {
    const user = userEvent.setup();
    setup(["app:mail:view", "mail:read"]);
    expect(screen.queryByTestId("fe7-app-dialog")).not.toBeInTheDocument();

    await user.click(screen.getByTestId("fe7-app-name-mail"));
    const dialog = screen.getByTestId("fe7-app-dialog");
    // mail owns 5 fine-grained keys; the label + raw key are both shown
    expect(within(dialog).getByText("メールの閲覧")).toBeInTheDocument();
    expect(within(dialog).getByText("mail:read")).toBeInTheDocument();
    expect((within(dialog).getByTestId("fe7-app-dialog-toggle-mail:read") as HTMLInputElement).checked).toBe(true);
    expect((within(dialog).getByTestId("fe7-app-dialog-toggle-mail:send") as HTMLInputElement).checked).toBe(false);
    // dangerous keys are flagged
    expect(within(dialog).getByTestId("fe7-app-dialog-danger-mail:read_all")).toBeInTheDocument();
    // role-shared mail visibility is a mail detail key with a Japanese label
    expect(within(dialog).getByText("同じロールの人宛てのメールを閲覧")).toBeInTheDocument();
    expect((within(dialog).getByTestId("fe7-app-dialog-toggle-mail:read_role_shared") as HTMLInputElement).checked).toBe(false);
    // a key from ANOTHER app is not in this dialog
    expect(within(dialog).queryByTestId("fe7-app-dialog-toggle-task:read")).not.toBeInTheDocument();
  });

  it("an app with no fine-grained key says so instead of rendering an empty dialog", async () => {
    const user = userEvent.setup();
    setup([]);
    await user.click(screen.getByTestId("fe7-app-name-gantt"));
    expect(screen.getByTestId("fe7-app-dialog-no-detail")).toBeInTheDocument();
    expect(screen.getByTestId("fe7-app-detail-count-mail")).toBeInTheDocument(); // mail HAS details
  });

  it("the dialog can also change the level (same policy helper as the table)", async () => {
    const user = userEvent.setup();
    const { onChange } = setup([]);
    await user.click(screen.getByTestId("fe7-app-name-chat"));
    await user.click(screen.getByTestId("fe7-app-dialog-level-view"));
    expect(onChange.mock.calls[0]?.[0]).toEqual(["app:chat:view"]);
  });

  // メッセージ削除ポリシーはロール管理から撤去（ロールの権限ではなくチャット側の設定）。
  it("メッセージ削除ポリシーはロール管理のどこにも出ない", async () => {
    const user = userEvent.setup();
    setup(["app:chat:view"]);
    expect(screen.queryByTestId("fe7-chat-deletion-policy")).not.toBeInTheDocument();

    await user.click(screen.getByTestId("fe7-app-name-chat"));
    const dialog = screen.getByTestId("fe7-app-dialog");
    expect(within(dialog).queryByTestId("fe7-chat-deletion-policy")).not.toBeInTheDocument();
    expect(within(dialog).queryByTestId("fe7-app-dialog-settings")).not.toBeInTheDocument();
  });

  // ユーザー要望: 運営メンバー/Drive共有 の細かい設定は、そのアプリの中で ON/OFF する。
  it("アプリ配下の細かい設定はそのアプリのダイアログに入る（運営メンバー / Drive共有）", async () => {
    const user = userEvent.setup();
    setup(["app:members:view", "app:driveshare:view"]);

    await user.click(screen.getByTestId("fe7-app-name-members"));
    const members = screen.getByTestId("fe7-app-dialog");
    expect(within(members).getByTestId("fe7-app-dialog-toggle-identity:admin")).toBeInTheDocument();
    await user.click(within(members).getByTestId("fe7-app-dialog-close"));

    await user.click(screen.getByTestId("fe7-app-name-driveshare"));
    const drive = screen.getByTestId("fe7-app-dialog");
    expect(within(drive).getByTestId("fe7-app-dialog-toggle-file:read")).toBeInTheDocument();
    expect(within(drive).getByTestId("fe7-app-dialog-toggle-drive:read")).toBeInTheDocument();
  });

  // 「アプリをオンにしたときに配下の細かい設定がオンオフできる」= 無効の間はロックする。
  // 段階の変更が実際に効くことを見たいので、ここだけ state を持つラッパで描画する。
  it("無効のアプリは細かい設定を触れず、閲覧にすると触れる", async () => {
    const user = userEvent.setup();
    function Harness() {
      const [selected, setSelected] = useState<identity.PermissionKey[]>([]);
      return <RolePolicyEditor selected={selected} onChange={setSelected} />;
    }
    renderWithProviders(<Harness />);

    await user.click(screen.getByTestId("fe7-app-name-mail"));
    const dialog = screen.getByTestId("fe7-app-dialog");
    expect(within(dialog).getByTestId("fe7-app-dialog-detail-locked")).toBeInTheDocument();
    expect((within(dialog).getByTestId("fe7-app-dialog-toggle-mail:read") as HTMLInputElement).disabled).toBe(true);
    // 無効でも既存の詳細キーは黙って剥奪しない = 一覧の件数は「—」で伏せるだけ
    expect(screen.getByTestId("fe7-app-detail-count-mail").textContent).toBe("—");

    // 「閲覧」にすると、同じトグルがそのまま操作できるようになる
    await user.click(within(dialog).getByTestId("fe7-app-dialog-level-view"));
    expect(within(dialog).queryByTestId("fe7-app-dialog-detail-locked")).not.toBeInTheDocument();
    const toggle = within(dialog).getByTestId("fe7-app-dialog-toggle-mail:read") as HTMLInputElement;
    expect(toggle.disabled).toBe(false);
    await user.click(toggle);
    expect((within(dialog).getByTestId("fe7-app-dialog-toggle-mail:read") as HTMLInputElement).checked).toBe(true);
    expect(screen.getByTestId("fe7-app-detail-count-mail").textContent).toBe("1 / 5");
  });

  // その他側と対称の到達性テスト: アプリが宣言した細かい権限は必ずそのダイアログに出る
  // （= APP_MANIFEST に detailPermissions を足して UI に出し忘れる、が起きない）。
  it("どのアプリのダイアログを開いても、そのアプリの細かい権限が漏れなく出る", async () => {
    const user = userEvent.setup();
    setup([]);
    for (const app of appRegistry.APP_MANIFEST) {
      await user.click(screen.getByTestId(`fe7-app-name-${app.id}`));
      const dialog = screen.getByTestId("fe7-app-dialog");
      for (const key of app.detailPermissions) {
        expect(within(dialog).getByTestId(`fe7-app-dialog-toggle-${key}`)).toBeInTheDocument();
      }
      if (app.detailPermissions.length === 0) {
        expect(within(dialog).getByTestId("fe7-app-dialog-no-detail")).toBeInTheDocument();
      }
      await user.click(within(dialog).getByTestId("fe7-app-dialog-close"));
    }
  });

  // 「詳細設定」列は細かい権限の有無だけで決まる（アプリ全体の設定という概念は撤去した）。
  it("一覧の「詳細設定」列は、細かい権限を持つアプリにだけ 設定 ボタンを出す", () => {
    setup([]);
    expect(screen.getByTestId("fe7-app-detail-chat")).toBeInTheDocument();
    // 細かい権限を持たないアプリ（ガント・ロール管理）は「なし」
    expect(screen.queryByTestId("fe7-app-detail-gantt")).not.toBeInTheDocument();
    expect(screen.queryByTestId("fe7-app-detail-admin")).not.toBeInTheDocument();
  });

  it("その他 は分類ごとに 1 行で、ダイアログを開くとそのグループの権限が出る", async () => {
    const user = userEvent.setup();
    setup(["infra:deploy"]);
    const other = screen.getByTestId("fe7-other-permissions");
    const groups = policy.otherPermissionGroups();
    // 画面に出るのは分類の行だけ（13 個のトグルを並べない）
    for (const group of groups) {
      expect(within(other).getByTestId(`fe7-other-name-${group.domain}`)).toBeInTheDocument();
    }
    expect(screen.getByTestId("fe7-other-count").textContent).toContain(`1 / ${policy.otherPermissions().length}`);
    expect(screen.getByTestId("fe7-other-granted-infra").textContent).toBe("1 / 4");

    // 「その他」に残るのは どのアプリにも属さない 4 分類だけ。アプリに引き取られた分類
    //（identity → 運営メンバー / file → Drive共有）はここに出ない。
    expect(groups.map((g) => g.domain)).toEqual(["infra", "audit", "github", "webhook"]);
    expect(within(other).queryByTestId("fe7-other-name-identity")).not.toBeInTheDocument();
    expect(within(other).queryByTestId("fe7-other-name-file")).not.toBeInTheDocument();
    expect(within(other).queryByTestId("fe7-other-name-drive")).not.toBeInTheDocument();

    // どのグループを開いても、そのグループのキーが漏れなく出る（= カタログ補集合が全部触れる）
    for (const group of groups) {
      await user.click(screen.getByTestId(`fe7-other-name-${group.domain}`));
      const dialog = screen.getByTestId("fe7-other-dialog");
      for (const entry of group.entries) {
        expect(within(dialog).getByTestId(`fe7-other-toggle-${entry.key}`)).toBeInTheDocument();
      }
      // アプリが持つキーはここに重複して出ない
      expect(within(dialog).queryByTestId("fe7-other-toggle-mail:send")).not.toBeInTheDocument();
      await user.click(within(dialog).getByTestId("fe7-other-dialog-close"));
    }
  });

  it("その他 のトグルは policy のキー集合をそのまま更新する", async () => {
    const user = userEvent.setup();
    const { onChange } = setup([]);
    await user.click(screen.getByTestId("fe7-other-detail-audit"));
    await user.click(screen.getByTestId("fe7-other-toggle-audit:read"));
    expect(onChange.mock.calls[0]?.[0]).toEqual(["audit:read"]);
  });

  it("disabled (read-only viewer) freezes every control", async () => {
    const user = userEvent.setup();
    setup(["app:mail:view"], { disabled: true });
    expect((screen.getByTestId("fe7-app-level-mail-edit") as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByTestId("fe7-other-name-audit"));
    expect((screen.getByTestId("fe7-other-toggle-audit:read") as HTMLInputElement).disabled).toBe(true);
  });

  it("locked keys freeze that app's level selector (self-lockout guard)", () => {
    setup(["app:admin:view", "app:admin:edit", "identity:admin"], { lockedKeys: ["app:admin:view", "app:admin:edit", "identity:admin"] });
    expect((screen.getByTestId("fe7-app-level-admin-none") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("fe7-app-level-mail-none") as HTMLButtonElement).disabled).toBe(false);
  });
});
