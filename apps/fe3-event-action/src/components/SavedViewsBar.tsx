// Saved-views control for the event list toolbar (P2-2). Lets the user name the
// current filter, re-apply a saved view in one click, mark one as the default
// (auto-applied when the list opens with no URL filter), and delete views.
//
// FE1-primitive only (Menu / Modal / Button / TextField / Checkbox / IconButton +
// useToast); all persistence is delegated to lib/savedViews.ts (localStorage, $0).
// The component is data-thin: it owns the saved-views state via useSavedViews and
// reports the current serialized filter in / applied filter out through props.
import { useCallback, useState } from "react";
import { Menu, Modal, Button, TextField, Checkbox, IconButton, useToast } from "@dub/ui";
import type { MenuItem } from "@dub/ui";
import {
  addView,
  removeView,
  setDefault,
  loadSavedViews,
  persistSavedViews,
  type SavedViewsState,
} from "../lib/savedViews";
import { parseEventListFilter } from "../lib/filterState";
import { phaseLabel } from "./PhaseBadge";
import styles from "./components.module.css";

/** Saved-views state + persistence, exposed as simple mutators. Reads once on mount
 *  (localStorage ≈ per-user) and writes through on every change. */
export function useSavedViews() {
  const [state, setState] = useState<SavedViewsState>(() => loadSavedViews());
  const commit = useCallback((next: SavedViewsState) => {
    setState(next);
    persistSavedViews(next);
  }, []);
  return {
    state,
    add: useCallback(
      (name: string, query: string, makeDefault: boolean) =>
        setState((s) => {
          const next = addView(s, name, query, { makeDefault });
          persistSavedViews(next);
          return next;
        }),
      [],
    ),
    remove: useCallback(
      (id: string) =>
        setState((s) => {
          const next = removeView(s, id);
          persistSavedViews(next);
          return next;
        }),
      [],
    ),
    setDefaultView: useCallback(
      (id: string | null) =>
        setState((s) => {
          const next = setDefault(s, id);
          persistSavedViews(next);
          return next;
        }),
      [],
    ),
    commit,
  };
}

/** Human-readable one-liner for a serialized event-list filter (for the save dialog). */
function describeQuery(query: string): string {
  const f = parseEventListFilter(query);
  const parts: string[] = [];
  parts.push(f.phase ? `フェーズ: ${phaseLabel(f.phase)}` : "すべてのフェーズ");
  if (f.includeArchived) parts.push("アーカイブを含む");
  return parts.join(" / ");
}

export interface SavedViewsBarProps {
  /** The currently active filter, serialized (from serializeEventListFilter). */
  currentQuery: string;
  /** Apply a saved view's query — the page pushes it into the URL. */
  onApply: (query: string) => void;
}

export function SavedViewsBar({ currentQuery, onApply }: SavedViewsBarProps) {
  const { state, add, remove, setDefaultView } = useSavedViews();
  const toast = useToast();
  const [saveOpen, setSaveOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [name, setName] = useState("");
  const [asDefault, setAsDefault] = useState(false);

  const openSave = () => {
    setName("");
    setAsDefault(false);
    setSaveOpen(true);
  };

  const confirmSave = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    add(trimmed, currentQuery, asDefault);
    setSaveOpen(false);
    toast.show({ kind: "success", title: `ビュー「${trimmed}」を保存しました` });
  };

  const items: MenuItem[] = [
    ...state.views.map(
      (v): MenuItem => ({
        id: v.id,
        label: v.id === state.defaultId ? `★ ${v.name}` : v.name,
        ...(v.id === state.defaultId ? { icon: "check" as const } : {}),
        onSelect: () => onApply(v.query),
        testId: `fe3-savedviews-apply-${v.id}`,
      }),
    ),
    {
      id: "__save__",
      label: "現在のフィルタを保存…",
      icon: "pin" as const,
      dividerBefore: state.views.length > 0,
      onSelect: openSave,
      testId: "fe3-savedviews-save",
    },
    ...(state.views.length > 0
      ? [
          {
            id: "__manage__",
            label: "ビューを管理…",
            icon: "settings" as const,
            onSelect: () => setManageOpen(true),
            testId: "fe3-savedviews-manage",
          } satisfies MenuItem,
        ]
      : []),
  ];

  return (
    <>
      <Menu
        label="保存ビュー"
        icon="pin"
        items={items}
        testId="fe3-savedviews-menu"
      />

      <Modal
        open={saveOpen}
        onClose={() => setSaveOpen(false)}
        title="ビューを保存"
        size="sm"
        testId="fe3-savedviews-save-modal"
        footer={
          <>
            <Button variant="ghost" onClick={() => setSaveOpen(false)} testId="fe3-savedviews-save-cancel">
              キャンセル
            </Button>
            <Button
              variant="primary"
              onClick={confirmSave}
              disabled={name.trim() === ""}
              testId="fe3-savedviews-save-confirm"
            >
              保存
            </Button>
          </>
        }
      >
        <div className={styles.savedViewForm}>
          <label className={styles.savedViewFormLabel} htmlFor="fe3-savedviews-name">
            ビュー名
          </label>
          <TextField
            id="fe3-savedviews-name"
            value={name}
            onChange={setName}
            placeholder="例: 開催中のイベント"
            testId="fe3-savedviews-name"
          />
          <p className={styles.savedHint}>現在のフィルタ: {describeQuery(currentQuery)}</p>
          <Checkbox
            id="fe3-savedviews-default"
            checked={asDefault}
            onChange={setAsDefault}
            label="このビューをデフォルトにする（次回この一覧を開いた時に自動適用）"
            testId="fe3-savedviews-default"
          />
        </div>
      </Modal>

      <Modal
        open={manageOpen}
        onClose={() => setManageOpen(false)}
        title="保存ビューの管理"
        size="sm"
        testId="fe3-savedviews-manage-modal"
        footer={
          <Button variant="primary" onClick={() => setManageOpen(false)} testId="fe3-savedviews-manage-close">
            閉じる
          </Button>
        }
      >
        {state.views.length === 0 ? (
          <div className={styles.emptyState}>保存されたビューはありません</div>
        ) : (
          <ul className={styles.savedViewList} data-testid="fe3-savedviews-list">
            {state.views.map((v) => {
              const isDefault = v.id === state.defaultId;
              return (
                <li key={v.id} className={styles.savedViewItem} data-testid={`fe3-savedviews-item-${v.id}`}>
                  <div className={styles.savedViewItemText}>
                    <span className={styles.savedViewName}>{v.name}</span>
                    <span className={styles.savedHint}>{describeQuery(v.query)}</span>
                  </div>
                  <Button
                    variant={isDefault ? "primary" : "ghost"}
                    size="sm"
                    onClick={() => setDefaultView(isDefault ? null : v.id)}
                    testId={`fe3-savedviews-toggle-default-${v.id}`}
                  >
                    {isDefault ? "★ デフォルト" : "デフォルトにする"}
                  </Button>
                  <IconButton
                    name="trash"
                    aria-label={`ビュー「${v.name}」を削除`}
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      remove(v.id);
                      toast.show({ kind: "info", title: `ビュー「${v.name}」を削除しました` });
                    }}
                    testId={`fe3-savedviews-delete-${v.id}`}
                  />
                </li>
              );
            })}
          </ul>
        )}
      </Modal>
    </>
  );
}
