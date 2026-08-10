// PreferenceMatrix — rows = type patterns, columns = channels (in_app/email/
// chat/push). Toggles edit local state; push column is shown but flagged
// "display only" until MO3 (FE5 §2-2, tests 11,12,17).

import type { ReactNode } from "react";
import { DataTable, Switch, Tooltip, type ColumnDef } from "@dub/ui";
import {
  NOTIFICATION_CHANNELS,
  type NotificationChannel,
} from "../contracts/notification-api";
import type { MergedPreference } from "../lib/preference-merge";
import { resolveTypeDisplay } from "../lib/type-dictionary";

const CHANNEL_LABEL: Record<NotificationChannel, string> = {
  in_app: "In-app",
  email: "Email",
  chat: "Chat",
  push: "Push",
};

// push is display-only until MO3 ships real delivery (test 17).
const DISPLAY_ONLY_CHANNELS: ReadonlySet<NotificationChannel> = new Set(["push"]);

function rowLabel(type: string): string {
  if (type === "*") return "All notifications";
  if (type.endsWith(".*")) return `${resolveTypeDisplay(type.slice(0, -1) + "x").group} (all)`;
  return resolveTypeDisplay(type).label;
}

export interface PreferenceMatrixProps {
  rows: MergedPreference[];
  onToggle: (type: string, channel: NotificationChannel) => void;
}

export function PreferenceMatrix(props: PreferenceMatrixProps): ReactNode {
  // @dub/ui DataTable is column-driven (ColumnDef<Row>), replacing the old
  // head/rows Table. The type column owns the row-level testId + "customized"
  // marker; each channel column renders a Switch cell.
  const columns: ColumnDef<MergedPreference>[] = [
    {
      key: "type",
      header: "Type",
      cell: (row) => (
        <span data-testid={`fe5-prefs-row-${row.type}`} data-overridden={row.overridden}>
          {rowLabel(row.type)}
          {row.overridden ? (
            <span data-testid={`fe5-prefs-override-${row.type}`} title="Customized">
              {" "}
              (customized)
            </span>
          ) : null}
        </span>
      ),
    },
    ...NOTIFICATION_CHANNELS.map(
      (ch): ColumnDef<MergedPreference> => ({
        key: ch,
        align: "center",
        header: DISPLAY_ONLY_CHANNELS.has(ch) ? (
          <Tooltip content="Delivery coming soon (settings saved now)">
            <span data-testid={`fe5-prefs-col-${ch}`}>{CHANNEL_LABEL[ch]} *</span>
          </Tooltip>
        ) : (
          <span data-testid={`fe5-prefs-col-${ch}`}>{CHANNEL_LABEL[ch]}</span>
        ),
        cell: (row) => (
          <Switch
            id={`fe5-prefs-switch-${row.type}-${ch}`}
            checked={row.channels.includes(ch)}
            onChange={() => props.onToggle(row.type, ch)}
            label={`${rowLabel(row.type)} — ${CHANNEL_LABEL[ch]}`}
            testId={`fe5-prefs-toggle-${row.type}-${ch}`}
          />
        ),
      }),
    ),
  ];

  return (
    <DataTable
      testId="fe5-prefs-matrix"
      columns={columns}
      rows={props.rows}
      rowKey={(row) => row.type}
    />
  );
}
