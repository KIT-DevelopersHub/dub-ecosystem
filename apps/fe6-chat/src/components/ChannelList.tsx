// Dark "workspace" sidebar: collapsible sections (Channels / DMs / Events),
// #-prefixed channels, presence dots on DMs, unread = bold name + mention/count
// badge. "New channel" (+) is gated by can("chat:create") upstream via canCreate.
// Slack-style information design — built from @dub/ui + own glyphs, no Slack assets.
// Org-wide sections (one shared set) render above the default groups for everyone. Only
// with `sectionActions` (chat:manage_sections) do the create / rename / delete entries and
// the per-row "⋯" move menu appear.
import { useState } from "react";
import { Icon, Menu, Skeleton, type MenuItem } from "@dub/ui";
import type { common } from "@dub/types";
import type { Channel, ChatSection } from "../api/contract";
import { buildSidebar, type ChannelGroup } from "../lib/channel-group";
import { getCollapsedSections, setCollapsedSections } from "../store/draft";
import { isPendingSection } from "../hooks/useChatSections";
import { getPresence, type Presence } from "../lib/presence";
import type { UnreadMap } from "../store/unread";
import styles from "../styles/chat.module.css";

export interface ChannelListProps {
  channels: Channel[];
  unread: UnreadMap;
  activeChannelId: common.ChannelId | null;
  canCreate: boolean;
  workspaceName?: string;
  onSelect: (channelId: common.ChannelId) => void;
  onCreate?: () => void;
  // DM row label ("the other side"); null = still resolving -> skeleton. Defaults to name.
  labelOf?: (channel: Channel) => string | null;
  // New-DM (+) on the ダイレクト section. Shown even with no DMs yet, so the first
  // conversation can be started from the sidebar.
  onNewDm?: () => void;
  // Set only when rendered inside the mobile nav drawer (P21) — adds a close (X)
  // affordance next to the workspace name so the drawer can be dismissed without
  // picking a channel first (backdrop-tap / Esc already close it too).
  onCloseMobile?: () => void;
  /** Channels/sections still loading -> skeleton rows (not "no channels"). */
  loading?: boolean;
  /** Org-wide sections overlay. Omit `sectionActions` for a read-only view (no organizing UI). */
  sections?: ChatSection[];
  assignments?: Record<common.ChannelId, string>;
  sectionActions?: SectionActions;
  /** Admin-only 「チャンネル取り込み」 (Slack). Omit to hide the entry. */
  onImport?: () => void;
  /** Admin-only 「絵文字取り込み」 (Slack custom emoji). Omit to hide the entry. */
  onImportEmoji?: () => void;
  /** Slack's 「後で」 entry above the channels (saved items + reminders). Omit to hide. */
  later?: { count: number; active: boolean; onOpen: () => void };
}

export interface SectionActions {
  /** Open the create dialog; `assignChannelId` = move that channel into the new section. */
  onCreate: (assignChannelId?: common.ChannelId) => void;
  onRename: (section: ChatSection) => void;
  onDelete: (section: ChatSection) => void;
  onMove: (channelId: common.ChannelId, sectionId: string | null) => void;
}

/** Liveness marker for the org-wide (shared) sections build. */
export const SHARED_SECTIONS_MARKER = "fe6-shared-sections-v1";

function Dot({ p }: { p: Presence }) {
  return <span className={`${styles.presenceDot} ${styles[p]}`} aria-hidden />;
}

export function ChannelList({
  channels,
  unread,
  activeChannelId,
  canCreate,
  workspaceName = "DevHub",
  onSelect,
  onCreate,
  labelOf = (c) => c.name,
  onNewDm,
  onCloseMobile,
  loading = false,
  sections = [],
  assignments = {},
  sectionActions,
  onImport,
  onImportEmoji,
  later,
}: ChannelListProps) {
  const layout = buildSidebar(channels, sections, assignments);
  const grouped = layout.groups;
  const groups: ChannelGroup[] =
    onNewDm && !grouped.some((g) => g.type === "dm") ? [...grouped, { type: "dm", label: "ダイレクト", channels: [] }] : grouped;
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => getCollapsedSections());
  const toggle = (key: string) =>
    setCollapsed((c) => {
      const next = { ...c, [key]: !c[key] };
      setCollapsedSections(next);
      return next;
    });
  const readySections = layout.sections.filter((g) => !isPendingSection(g.section.id));

  const moveItems = (c: Channel): MenuItem[] => {
    if (!sectionActions) return [];
    const current = assignments[c.id];
    const items: MenuItem[] = readySections.map(({ section }) => ({
      id: section.id,
      label: section.id === current ? `${section.name}（現在）` : section.name,
      icon: section.id === current ? "check" : "folder",
      disabled: section.id === current,
      testId: `fe6-channel-move-to-${section.id}`,
      onSelect: () => sectionActions.onMove(c.id, section.id),
    }));
    if (current) {
      items.push({
        id: "__remove",
        label: "セクションから外す",
        icon: "x",
        dividerBefore: items.length > 0,
        testId: "fe6-channel-move-remove",
        onSelect: () => sectionActions.onMove(c.id, null),
      });
    }
    items.push({
      id: "__new",
      label: "新しいセクションを作成…",
      icon: "plus",
      dividerBefore: items.length > 0,
      testId: "fe6-channel-move-new",
      onSelect: () => sectionActions.onCreate(c.id),
    });
    return items;
  };

  const renderChannel = (c: Channel) => {
    const u = unread[c.id];
    const count = u?.unreadCount ?? 0;
    const hasUnread = count > 0;
    const mentioned = !!u?.mentioned;
    const isActive = c.id === activeChannelId;
    const isDm = c.type === "dm";
    const label = labelOf(c);
    return (
      <div key={c.id} className={styles.channelRow}>
        <button
          type="button"
          className={`${styles.channelItem} ${isActive ? styles.active : ""} ${hasUnread ? styles.unread : ""}`}
          onClick={() => onSelect(c.id)}
          data-testid="fe6-channel-list-item"
          data-channel-id={c.id}
          aria-current={isActive ? "page" : undefined}
        >
          <span className={styles.channelGlyph} aria-hidden>
            {isDm ? <Dot p={getPresence(c.id)} /> : c.archived ? "🗄" : c.visibility === "private" ? "🔒" : "#"}
          </span>
          <span className={styles.channelName}>
            {label ?? <Skeleton variant="text" width="6em" testId="fe6-channel-label-loading" />}
          </span>
          {mentioned ? (
            <span className={styles.mentionBadge} data-testid="fe6-channel-unread-badge">
              {count}
            </span>
          ) : hasUnread ? (
            <span className={styles.countBadge} data-testid="fe6-channel-unread-badge">
              {count}
            </span>
          ) : null}
        </button>
        {sectionActions && (
          <span className={`${styles.sidebarMenu} ${styles.rowMenu}`}>
            <Menu label="セクションに移動" iconOnly align="end" items={moveItems(c)} testId="fe6-channel-move-menu" />
          </span>
        )}
      </div>
    );
  };

  return (
    <nav className={styles.sidebar} aria-label="チャネル一覧" data-testid="fe6-channel-list">
      <div className={styles.workspaceHeader}>
        <span className={styles.workspaceName}>{workspaceName}</span>
        <span className={styles.workspaceHeaderActions}>
          {canCreate && (
            <button
              type="button"
              className={styles.workspaceAction}
              onClick={onCreate}
              data-testid="fe6-channel-create"
              aria-label="チャネルを作成"
              title="チャネルを作成"
            >
              ＋
            </button>
          )}
          {onCloseMobile && (
            <button
              type="button"
              className={styles.workspaceAction}
              onClick={onCloseMobile}
              data-testid="fe6-mobile-nav-close"
              aria-label="チャネル一覧を閉じる"
              title="閉じる"
            >
              <Icon name="x" size="sm" />
            </button>
          )}
        </span>
      </div>

      <div className={styles.sidebarScroll}>
        {later && (
          <div className={styles.sidebarShortcuts}>
            <button
              type="button"
              className={`${styles.channelItem} ${later.active ? styles.active : ""}`}
              onClick={later.onOpen}
              aria-current={later.active ? "page" : undefined}
              data-testid="fe6-sidebar-later"
              data-marker="fe6-later-sidebar"
            >
              <span className={styles.channelGlyph} aria-hidden>
                🔖
              </span>
              <span className={styles.channelName}>後で</span>
              {later.count > 0 && (
                <span className={styles.countBadge} data-testid="fe6-sidebar-later-count">
                  {later.count}
                </span>
              )}
            </button>
          </div>
        )}
        {loading ? (
          <div className={styles.sidebarSkeleton} data-testid="fe6-channel-list-loading" aria-busy="true">
            {[0, 1, 2].map((block) => (
              <div key={block} className={styles.section}>
                <Skeleton variant="text" width="5em" />
                {[0, 1, 2].map((row) => (
                  <Skeleton key={row} variant="text" width={`${7 + ((block + row) % 3) * 2}em`} />
                ))}
              </div>
            ))}
          </div>
        ) : (
          <>
            {layout.sections.map(({ section, channels: list }) => {
              // Read-only viewers have nothing to do with an empty shared section.
              if (!sectionActions && list.length === 0) return null;
              const isCollapsed = !!collapsed[section.id];
              const pending = isPendingSection(section.id);
              return (
                <section
                  key={section.id}
                  className={styles.section}
                  data-testid="fe6-sidebar-section"
                  data-section-id={section.id}
                  data-marker={SHARED_SECTIONS_MARKER}
                >
                  <div className={styles.sectionHeader}>
                    <button
                      type="button"
                      className={styles.sectionToggle}
                      aria-expanded={!isCollapsed}
                      onClick={() => toggle(section.id)}
                    >
                      <span className={`${styles.sectionChevron} ${isCollapsed ? styles.collapsed : ""}`} aria-hidden>
                        ▾
                      </span>
                      <span className={styles.sectionName}>{section.name}</span>
                    </button>
                    {sectionActions && !pending && (
                      <span className={styles.sidebarMenu}>
                        <Menu
                          label={`セクション「${section.name}」の操作`}
                          iconOnly
                          align="end"
                          testId="fe6-section-menu"
                          items={[
                            { id: "rename", label: "名前を変更", icon: "edit", testId: "fe6-section-rename", onSelect: () => sectionActions.onRename(section) },
                            {
                              id: "delete",
                              label: "削除",
                              icon: "trash",
                              tone: "danger",
                              dividerBefore: true,
                              testId: "fe6-section-delete",
                              onSelect: () => sectionActions.onDelete(section),
                            },
                          ]}
                        />
                      </span>
                    )}
                  </div>
                  {!isCollapsed &&
                    (list.length === 0 ? (
                      <div className={styles.sectionEmptyHint}>チャンネルをここに移動できます</div>
                    ) : (
                      list.map(renderChannel)
                    ))}
                </section>
              );
            })}

            {groups.map((g) => {
              const isCollapsed = !!collapsed[g.type];
              const isDm = g.type === "dm";
              return (
                <section key={g.type} className={styles.section}>
                  <div className={styles.sectionHeader}>
                    <button
                      type="button"
                      className={styles.sectionToggle}
                      aria-expanded={!isCollapsed}
                      onClick={() => toggle(g.type)}
                    >
                      <span className={`${styles.sectionChevron} ${isCollapsed ? styles.collapsed : ""}`} aria-hidden>
                        ▾
                      </span>
                      {g.label}
                    </button>
                    {canCreate && !isDm && (
                      <button type="button" className={styles.sectionAdd} onClick={onCreate} aria-label={`${g.label}を追加`} title="追加">
                        ＋
                      </button>
                    )}
                    {isDm && onNewDm && (
                      <button
                        type="button"
                        className={styles.sectionAdd}
                        onClick={onNewDm}
                        aria-label="ダイレクトメッセージを開始"
                        title="ダイレクトメッセージを開始"
                        data-testid="fe6-dm-new"
                      >
                        ＋
                      </button>
                    )}
                  </div>
                  {!isCollapsed && g.channels.map(renderChannel)}
                </section>
              );
            })}

            {sectionActions && (
              <button
                type="button"
                className={styles.sectionCreate}
                onClick={() => sectionActions.onCreate()}
                data-testid="fe6-section-create"
              >
                ＋ セクションを作成
              </button>
            )}

            {onImport && (
              <button type="button" className={styles.sectionCreate} onClick={onImport} data-testid="fe6-slack-import-open">
                ⇩ チャンネル取り込み（Slack）
              </button>
            )}
            {onImportEmoji && (
              <button type="button" className={styles.sectionCreate} onClick={onImportEmoji} data-testid="fe6-emoji-import-sidebar">
                ⇩ 絵文字取り込み（Slack）
              </button>
            )}
          </>
        )}
      </div>
    </nav>
  );
}
