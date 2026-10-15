// Slack channel picker: name search over what the bot can see (公開/非公開, member count,
// already-imported badge). Selection is a single choice; the parent owns it.
import { Badge, EmptyState, FormField, SkeletonList, TextField } from "@dub/ui";
import type { SlackChannelOption, SlackImportJobStatus } from "../../api/contract";
import styles from "./slack-import.module.css";

export interface SlackChannelPickerProps {
  channels: SlackChannelOption[] | null; // null = loading
  query: string;
  onQueryChange: (q: string) => void;
  selected: string | null; // channel name
  onSelect: (name: string) => void;
  /** Latest job status per Slack channel id (live, overrides the list's snapshot). */
  statusOf: (channel: SlackChannelOption) => SlackImportJobStatus | null;
}

const JOB_BADGE: Record<SlackImportJobStatus, { tone: "success" | "info" | "danger"; label: string }> = {
  done: { tone: "success", label: "取り込み済み" },
  queued: { tone: "info", label: "取り込み中" },
  running: { tone: "info", label: "取り込み中" },
  failed: { tone: "danger", label: "失敗" },
};

export function filterSlackChannels(channels: SlackChannelOption[], query: string): SlackChannelOption[] {
  const q = query.trim().replace(/^#/, "").toLowerCase();
  return q ? channels.filter((c) => c.name.toLowerCase().includes(q)) : channels;
}

export function SlackChannelPicker({ channels, query, onQueryChange, selected, onSelect, statusOf }: SlackChannelPickerProps) {
  const visible = channels ? filterSlackChannels(channels, query) : [];
  return (
    <div className={styles.section}>
      <FormField label="チャンネルを検索" htmlFor="fe6-slack-import-search">
        <TextField
          id="fe6-slack-import-search"
          value={query}
          onChange={onQueryChange}
          placeholder="例: general"
          testId="fe6-slack-import-search"
        />
      </FormField>
      {channels === null ? (
        <SkeletonList rows={4} testId="fe6-slack-import-channels-loading" />
      ) : visible.length === 0 ? (
        <EmptyState
          icon="search"
          title={channels.length === 0 ? "取り込めるチャンネルがありません" : "一致するチャンネルがありません"}
          description="非公開チャンネルは Slack で LMB を招待すると表示されます。"
        />
      ) : (
        <div className={styles.channelList} role="group" aria-label="Slack チャンネル" data-testid="fe6-slack-import-channels">
          {visible.map((c) => {
            const status = statusOf(c);
            const badge = status ? JOB_BADGE[status] : null;
            return (
              <button
                key={c.id}
                type="button"
                className={styles.channelOption}
                aria-pressed={selected === c.name}
                onClick={() => onSelect(c.name)}
                data-testid="fe6-slack-import-channel"
                data-channel-name={c.name}
              >
                <span className={styles.channelGlyph} aria-hidden>
                  {c.isPrivate ? "🔒" : "#"}
                </span>
                <span className={styles.channelName}>{c.name}</span>
                <span className={styles.channelMeta}>
                  {c.memberCount !== null && <span>{c.memberCount} 人</span>}
                  <Badge tone={c.isPrivate ? "warning" : "neutral"}>{c.isPrivate ? "非公開" : "公開"}</Badge>
                  {c.isArchived && <Badge tone="neutral">アーカイブ</Badge>}
                  {badge && <Badge tone={badge.tone}>{badge.label}</Badge>}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
