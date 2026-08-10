// Left navigation pane: compose button, primary folders with unread badges, and
// user labels. Layout/behaviour follows Gmail; all visuals are @dub/tokens +
// our own line icons (no Google assets).
import { NAV_FOLDERS, inFolder, threadUnread, type FolderId } from "./mailModel.ts";
import { MailIcon, type MailIconName } from "./icons.tsx";
import { useMailStore } from "./useMailStore.tsx";

function count(folder: FolderId, threads: ReturnType<typeof useMailStore>["state"]["threads"], unreadOnly: boolean): number {
  return threads.filter((t) => inFolder(t, folder) && (!unreadOnly || threadUnread(t))).length;
}

export function MailSidebar(): JSX.Element {
  const { state, dispatch } = useMailStore();

  return (
    <nav
      data-testid="fe2-mail-sidebar"
      style={{
        width: 256,
        flexShrink: 0,
        padding: "8px 8px 8px 4px",
        display: "flex",
        flexDirection: "column",
        gap: 4,
        overflowY: "auto",
      }}
    >
      <button
        type="button"
        data-testid="fe2-mail-compose-open"
        onClick={() => dispatch({ type: "OPEN_COMPOSE", compose: {} })}
        style={{
          all: "unset",
          cursor: "pointer",
          display: "inline-flex",
          alignItems: "center",
          gap: 10,
          alignSelf: "flex-start",
          margin: "4px 8px 12px 8px",
          padding: "12px 20px 12px 14px",
          borderRadius: "var(--dub-radius-lg)",
          background: "var(--dub-color-surface-raised)",
          border: "1px solid var(--dub-color-border-default)",
          boxShadow: "var(--dub-shadow-sm)",
          color: "var(--dub-color-text-primary)",
          fontWeight: 600,
          fontSize: "var(--dub-font-size-sm)",
        }}
      >
        <MailIcon name="compose" size={20} />
        作成
      </button>

      {NAV_FOLDERS.map((f) => {
        const active = state.labelFilter === null && state.folder === f.id;
        const unread = f.id === "drafts" ? count(f.id, state.threads, false) : count(f.id, state.threads, true);
        return (
          <button
            key={f.id}
            type="button"
            data-testid={`fe2-mail-folder-${f.id}`}
            aria-current={active ? "page" : undefined}
            onClick={() => dispatch({ type: "SET_FOLDER", folder: f.id })}
            style={{
              all: "unset",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: 16,
              height: 32,
              padding: "0 12px 0 20px",
              borderRadius: "0 16px 16px 0",
              color: active ? "var(--dub-color-brand-700)" : "var(--dub-color-text-secondary)",
              background: active ? "var(--dub-color-brand-100)" : "transparent",
              fontWeight: active ? 700 : 500,
              fontSize: "var(--dub-font-size-sm)",
            }}
          >
            <MailIcon name={f.icon as MailIconName} size={18} />
            <span style={{ flex: 1 }}>{f.label}</span>
            {unread > 0 ? (
              <span style={{ fontSize: "var(--dub-font-size-xs)", fontWeight: 700 }}>{unread}</span>
            ) : null}
          </button>
        );
      })}

      <div
        style={{
          margin: "12px 20px 4px",
          fontSize: "var(--dub-font-size-xs)",
          color: "var(--dub-color-text-muted)",
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: "0.04em",
        }}
      >
        ラベル
      </div>
      {state.labels.map((l) => {
        const active = state.labelFilter === l.id;
        return (
          <button
            key={l.id}
            type="button"
            data-testid={`fe2-mail-label-${l.id}`}
            aria-current={active ? "page" : undefined}
            onClick={() => dispatch({ type: "SET_LABEL", label: l.id })}
            style={{
              all: "unset",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: 16,
              height: 32,
              padding: "0 12px 0 20px",
              borderRadius: "0 16px 16px 0",
              color: active ? "var(--dub-color-text-primary)" : "var(--dub-color-text-secondary)",
              background: active ? "var(--dub-color-surface-sunken)" : "transparent",
              fontWeight: active ? 700 : 500,
              fontSize: "var(--dub-font-size-sm)",
            }}
          >
            <span
              aria-hidden
              style={{ width: 12, height: 12, borderRadius: 3, background: l.color, flexShrink: 0 }}
            />
            <span style={{ flex: 1 }}>{l.name}</span>
          </button>
        );
      })}
    </nav>
  );
}
