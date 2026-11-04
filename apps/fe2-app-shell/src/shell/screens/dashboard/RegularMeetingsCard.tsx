// ダッシュボードの「定例に参加」。自分が対象の全体定例・チーム定例 (出席を取る定例) を並べ、
// 「参加」で Meet を開くと同時に出席が記録される (POST /meetings/:id/join)。開始30分前〜終了まで
// が出席になる時間帯。定例が無い / 取得できない人にはカード自体を出さない (誰でも見るダッシュボード
// なので、関係のない人に空のカードやエラーを見せない)。
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge, Button, Card, Icon, SkeletonLoader, useToast } from "@dub/ui";
import { meeting } from "@dub/types";
import type { ApiClient } from "../../../lib/api-client.tsx";
import { joinMeetingRequest, openMeetWithAttendance } from "../../../lib/meet-join.ts";

export const MY_REGULARS_KEY = ["home", "my-regular-meetings"] as const;
const WEEKDAY = ["日", "月", "火", "水", "木", "金", "土"];

/** 「10/19(月) 21:00〜22:00」 */
export function regularWhen(next: meeting.OccurrenceStart, durationMinutes: number): string {
  const s = new Date(Date.parse(next.startsAt) + 9 * 3_600_000);
  const e = new Date(s.getTime() + durationMinutes * 60_000);
  const hm = (d: Date) => `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
  return `${s.getUTCMonth() + 1}/${s.getUTCDate()}(${WEEKDAY[s.getUTCDay()]}) ${hm(s)}〜${hm(e)}`;
}

export function RegularMeetingsCard({ api }: { api: ApiClient }): JSX.Element | null {
  const q = useQuery({
    queryKey: MY_REGULARS_KEY,
    queryFn: () => api.request<meeting.ListMyRegularMeetingsResponse>({ method: "GET", path: "/api/v1/meetings/me/regulars" }),
    staleTime: 60_000,
    refetchInterval: 60_000,
    retry: false,
  });
  if (q.isError) return null;
  if (!q.isPending && (q.data?.items.length ?? 0) === 0) return null;
  return (
    <Card
      testId="fe2-home-regulars"
      header={
        <span className="fe2-stat-label">
          <Icon name="users" />
          定例に参加
        </span>
      }
    >
      {q.isPending ? <SkeletonLoader lines={2} /> : <RegularMeetingsList api={api} items={q.data!.items} />}
    </Card>
  );
}

function RegularMeetingsList({ api, items }: { api: ApiClient; items: meeting.MyRegularMeeting[] }): JSX.Element {
  const qc = useQueryClient();
  const toast = useToast();
  const join = (m: meeting.MyRegularMeeting) => {
    // 楽観的: 開いている回なら先に「出席済み」にする (失敗したら取り直して戻す)。
    if (m.joinOpen) {
      qc.setQueryData<meeting.ListMyRegularMeetingsResponse>(MY_REGULARS_KEY, (prev) =>
        prev ? { items: prev.items.map((x) => (x.id === m.id ? { ...x, attended: true } : x)) } : prev,
      );
    }
    void openMeetWithAttendance(() => joinMeetingRequest(api, m.id), m.meetUrl).then((res) => {
      if (res?.recordedFor) toast.show({ kind: "success", title: `「${m.title}」の出席を記録しました` });
      else if (m.joinOpen) void qc.invalidateQueries({ queryKey: MY_REGULARS_KEY });
    });
  };

  return (
    <ul className="fe2-list">
      {items.map((m) => (
        <li key={m.id} className="fe2-list-row" data-testid={`fe2-home-regular-${m.id}`}>
          <span className="fe2-list-main">
            <span className="fe2-list-title">{m.title}</span>
            <span className="fe2-list-meta" style={{ display: "flex", gap: "var(--dub-space-2)", alignItems: "center", flexWrap: "wrap" }}>
              <Badge tone={m.kind === "all_hands" ? "brand" : "info"}>{meeting.REGULAR_KIND_LABELS[m.kind]}</Badge>
              {m.next ? regularWhen(m.next, m.durationMinutes) : "予定はありません"}
              {m.joinOpen ? <span>参加すると出席になります</span> : null}
            </span>
          </span>
          {m.attended ? (
            <Badge tone="success" testId={`fe2-home-regular-${m.id}-attended`}>
              出席済み
            </Badge>
          ) : null}
          {m.meetUrl ? (
            <Button
              size="sm"
              variant={m.joinOpen ? "primary" : "secondary"}
              onClick={() => join(m)}
              testId={`fe2-home-regular-${m.id}-join`}
            >
              参加
            </Button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
