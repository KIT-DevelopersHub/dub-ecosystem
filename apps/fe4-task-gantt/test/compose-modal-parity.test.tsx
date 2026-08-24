import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { common } from "@dub/types";
import { TaskCreateModal } from "../src/components/TaskCreateModal";
import { MyTaskCreateModal } from "../src/components/MyTaskCreateModal";

// ③ 判断99: ガント「タスクを作成」とマイタスク「タスクを発行」は、共有の TaskComposeFields で
// 同一のフィールド集合・レイアウト・ラベルに揃える。ここでは union のフィールドが両モーダルに
// 出ていること（＝完全共通化）を回帰で守る。文脈差（対象イベント lock / 親・先行の出し分け）
// のみが差分。
const EVT = "evt_1" as common.EventId;

// 両モーダルに共通で必ず出るフィールド（testId サフィックス）。
const SHARED_SUFFIXES = ["title", "event", "status", "priority", "assignee", "start", "due", "desc", "file", "url", "url-name"];

describe("③ 作成/発行モーダルの完全共通化: 同一フィールド集合", () => {
  it("ガント作成モーダルに union の全フィールドが出る（新規: 対象イベント/ステータス/内容/添付）", () => {
    render(
      <TaskCreateModal
        open
        onClose={() => {}}
        users={[]}
        teams={[]}
        parentOptions={[]}
        scopeTasks={[]}
        eventId={EVT}
        eventName="北陸ITカンファレンス2026"
        onCreate={async () => {}}
      />,
    );
    for (const s of SHARED_SUFFIXES) {
      expect(screen.getByTestId(`fe4-create-${s}`)).toBeInTheDocument();
    }
    // 対象イベントは gantt では現在のイベントに固定（disabled）＋ロック注記。
    expect((screen.getByTestId("fe4-create-event") as HTMLSelectElement).disabled).toBe(true);
    expect(screen.getByTestId("fe4-create-event-locked")).toBeInTheDocument();
  });

  it("マイタスク発行モーダルに union の全フィールドが出る（新規: ステータス/開始日）", () => {
    render(
      <MyTaskCreateModal
        open
        onClose={() => {}}
        events={[{ id: EVT, name: "北陸ITカンファレンス2026" }]}
        people={[]}
        teams={[]}
        onCreate={async () => {}}
      />,
    );
    for (const s of SHARED_SUFFIXES) {
      expect(screen.getByTestId(`fe4-mytask-create-${s}`)).toBeInTheDocument();
    }
    // 発行モーダルの対象イベントは選択可（disabled でない）。
    expect((screen.getByTestId("fe4-mytask-create-event") as HTMLSelectElement).disabled).toBe(false);
  });

  it("両モーダルは同一のフィールド・ラベル文言を共有する（担当者/期日/内容 の表記ゆれが無い）", () => {
    const { unmount } = render(
      <TaskCreateModal
        open
        onClose={() => {}}
        users={[]}
        teams={[]}
        parentOptions={[]}
        scopeTasks={[]}
        eventId={EVT}
        onCreate={async () => {}}
      />,
    );
    // ラベルは共有コンポーネント由来なので、片方に出る文言はもう片方にも出る。
    expect(screen.getByText("担当者")).toBeInTheDocument();
    expect(screen.getByText("開始日")).toBeInTheDocument();
    expect(screen.getByText("内容（任意）")).toBeInTheDocument();
    unmount();
    render(
      <MyTaskCreateModal
        open
        onClose={() => {}}
        events={[{ id: EVT, name: "E" }]}
        people={[]}
        teams={[]}
        onCreate={vi.fn(async () => {})}
      />,
    );
    expect(screen.getByText("担当者")).toBeInTheDocument();
    expect(screen.getByText("開始日")).toBeInTheDocument();
    expect(screen.getByText("内容（任意）")).toBeInTheDocument();
  });
});
