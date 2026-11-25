// AudienceSummaryPanel — 通知管理の「誰に届くか」。受け取る通知の種類ごとに、ロール管理でその
// 権限を持つロール（人数つき）と、いま届く人数を並べる。宛先はロール管理 > 通知 > 詳細設定 の
// 「全体への通知を受け取る」「管理者向け通知を受け取る」で決まる。

import type { ReactNode } from "react";
import { Badge, Button, Card, SkeletonList, Stack, Tag } from "@dub/ui";
import type { AudienceSummary } from "../contracts/notification-api";
import { useAudiences } from "../hooks/useAudiences";

const muted = { color: "var(--dub-color-fg-muted)", fontSize: 13, lineHeight: 1.6, margin: 0 } as const;

function AudienceCard({ item }: { item: AudienceSummary }): ReactNode {
  return (
    <div style={{ flex: "1 1 280px", minWidth: 0 }} data-testid={`fe5-audience-${item.audience}`}>
      <Card padded>
        <Stack gap={2}>
          <Stack direction="row" justify="between" align="center" gap={2}>
            <strong>{item.label}</strong>
            <Badge tone={item.recipientCount > 0 ? "info" : "warning"} testId={`fe5-audience-count-${item.audience}`}>
              {item.recipientCount}人に届く
            </Badge>
          </Stack>
          <p style={muted}>{item.description}</p>
          <div>
            <p style={{ ...muted, fontWeight: 600 }}>受け取るロール</p>
            {item.roles.length === 0 ? (
              <p style={muted} data-testid={`fe5-audience-noroles-${item.audience}`}>
                どのロールにも付いていません（誰にも届きません）
              </p>
            ) : (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 4 }}>
                {item.roles.map((r) => (
                  <Tag key={r.id} testId={`fe5-audience-role-${item.audience}`}>
                    {r.name}（{r.memberCount}人）
                  </Tag>
                ))}
              </div>
            )}
          </div>
          <div>
            <p style={{ ...muted, fontWeight: 600 }}>この種類の通知</p>
            <ul style={{ ...muted, paddingInlineStart: "1.25rem" }}>
              {item.examples.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          </div>
        </Stack>
      </Card>
    </div>
  );
}

export function AudienceSummaryPanel(): ReactNode {
  const { items, loading, error, reload } = useAudiences();
  return (
    <Stack gap={2} testId="fe5-audiences">
      <Stack gap={1}>
        <h2 style={{ fontSize: 16, fontWeight: 700, margin: 0 }}>誰に届くか</h2>
        <p style={muted}>
          受け取るロールは「ロール管理 → 通知 → 詳細設定」の「全体への通知を受け取る」「管理者向け通知を受け取る」で変更できます。
          タスクの割り当て・メンション/DM・参加イベントの更新など自分宛ての通知は、ロールに関係なく本人に届きます。
        </p>
      </Stack>
      {loading && items.length === 0 ? (
        <SkeletonList rows={2} testId="fe5-audiences-skeleton" />
      ) : error ? (
        <Card padded testId="fe5-audiences-error">
          <Stack direction="row" justify="between" align="center" gap={2}>
            <span style={muted}>届く相手の一覧を読み込めませんでした</span>
            <Button variant="secondary" onClick={() => void reload()} testId="fe5-audiences-retry">
              再読み込み
            </Button>
          </Stack>
        </Card>
      ) : (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--dub-space-3, 12px)" }}>
          {items.map((item) => (
            <AudienceCard key={item.audience} item={item} />
          ))}
        </div>
      )}
    </Stack>
  );
}
