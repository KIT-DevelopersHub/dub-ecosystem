// 北陸ITカンファの CAMPFIRE クラファンを応援♡ — 2タップ導線のホームカード。
// 1タップ目: このボタンで CAMPFIRE を新しいタブで開く（本人のブラウザ・本人のログイン）。
// 2タップ目: 本人が CAMPFIRE 上で ♡ を押す。Dub は CAMPFIRE に一切アクセスしない。
// 押した事実だけを記録し（楽観的に即反映）、管理者は押した人の一覧を見られる。
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge, Button, Card, DataTable, Icon, Modal, SkeletonLoader } from "@dub/ui";
import type { gateway } from "@dub/types";
import type { ApiClient } from "../../../lib/api-client.tsx";
import { createOptimisticMutation } from "../../../lib/optimistic.tsx";
import { queryKeys } from "../../../lib/queryKeys.tsx";

type CheerStatus = gateway.CheerStatusResponse;
type CheerRow = gateway.CheerClickRow;

/** CAMPFIRE プロジェクトページ（設定値）。クライアント固定 = サーバ値で遷移先を変えさせない。 */
export const CAMPFIRE_PROJECT_URL = "https://camp-fire.jp/projects/975088/view";

const statusKey = queryKeys.feature("campfire-cheer", "me");
const adminKey = queryKeys.feature("campfire-cheer", "admin-list");

function fmt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function CheerersDialog({ api, open, onClose }: { api: ApiClient; open: boolean; onClose: () => void }): JSX.Element {
  const list = useQuery({
    queryKey: adminKey,
    enabled: open,
    queryFn: () =>
      api.request<gateway.CheerClicksAdminResponse>({ method: "GET", path: "/api/v1/admin/cheer/campfire/clicks" }),
  });
  return (
    <Modal open={open} onClose={onClose} title="応援ボタンを押した人" size="lg" testId="fe2-campfire-cheerers-dialog">
      <p className="fe2-stat-hint fe2-cheer-note">
        「押した」= CAMPFIRE のページを開いた記録です（♡ を押したかどうかは CAMPFIRE 側の操作のため分かりません）。
      </p>
      {list.isError ? (
        <div role="alert" className="fe2-inline-error">
          <p>一覧を取得できませんでした。</p>
          <Button variant="secondary" size="sm" onClick={() => void list.refetch()}>
            再試行
          </Button>
        </div>
      ) : (
        <DataTable<CheerRow>
          testId="fe2-campfire-cheerers-table"
          loading={list.isPending}
          rows={list.data?.items ?? []}
          rowKey={(r) => r.userId}
          emptyState={<p className="fe2-stat-hint">まだ誰も押していません。</p>}
          columns={[
            { key: "name", header: "名前", noWrap: true, cell: (r) => r.displayName },
            { key: "email", header: "メール", cell: (r) => r.email },
            { key: "last", header: "最後に押した日時", noWrap: true, cell: (r) => fmt(r.lastClickedAt) },
            { key: "first", header: "最初に押した日時", noWrap: true, cell: (r) => fmt(r.firstClickedAt) },
            { key: "count", header: "回数", noWrap: true, cell: (r) => `${r.clickCount} 回` },
          ]}
        />
      )}
    </Modal>
  );
}

export function CampfireCheerCard({ api, canViewCheerers = false }: { api: ApiClient; canViewCheerers?: boolean }): JSX.Element {
  const qc = useQueryClient();
  const [listOpen, setListOpen] = useState(false);
  const [recordFailed, setRecordFailed] = useState(false);

  const status = useQuery({
    queryKey: statusKey,
    queryFn: () => api.request<CheerStatus>({ method: "GET", path: "/api/v1/cheer/campfire/me" }),
  });

  const click = useMutation(
    createOptimisticMutation<gateway.CheerClickResponse, { at: string }, CheerStatus>(qc, {
      mutationFn: () => api.request<gateway.CheerClickResponse>({ method: "POST", path: "/api/v1/cheer/campfire/clicks", body: {} }),
      cacheKey: statusKey,
      applyOptimistic: (prev, v) => ({
        cheeredByMe: true,
        myLastClickedAt: v.at,
        totalCheerers: prev.cheeredByMe ? prev.totalCheerers : prev.totalCheerers + 1,
      }),
      onErrorToast: () => setRecordFailed(true),
    }),
  );

  const s = status.data;
  return (
    <Card
      testId="fe2-home-campfire-cheer"
      header={
        <div className="fe2-home-card-head">
          <span className="fe2-stat-label">
            <Icon name="megaphone" />
            北陸ITカンファのクラファンを応援♡
          </span>
          <Badge tone="neutral">任意</Badge>
        </div>
      }
    >
      <div className="fe2-cheer-body">
        <p className="fe2-cheer-lead">
          CAMPFIRE のプロジェクトページで ♡（お気に入り）を押すと応援になります。参加は任意です。
        </p>
        {/* 本物の <a target=_blank> で開く（ポップアップブロック回避）。記録は裏で送る。 */}
        <a
          href={CAMPFIRE_PROJECT_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="fe2-cheer-cta"
          data-testid="fe2-campfire-cheer-open"
          onClick={() => {
            setRecordFailed(false);
            click.mutate({ at: new Date().toISOString() });
          }}
        >
          CAMPFIREで応援する ♡
          <Icon name="external-link" />
        </a>
        {status.isPending ? (
          <SkeletonLoader lines={1} />
        ) : s?.cheeredByMe ? (
          <p className="fe2-stat-hint" data-testid="fe2-campfire-cheer-done">
            応援ありがとうございます！
            {s.myLastClickedAt ? `（${fmt(s.myLastClickedAt)} に開きました）` : ""}
          </p>
        ) : (
          <p className="fe2-stat-hint" data-testid="fe2-campfire-cheer-firsttime">
            はじめての人へ: CAMPFIRE のアカウント登録は1分。パスワードは自分で決めてください（Dub とは別のアカウントです）。
          </p>
        )}
        {recordFailed ? (
          <p className="fe2-stat-hint" role="status">
            押した記録を保存できませんでした（応援ページは開いています）。
          </p>
        ) : null}
        {canViewCheerers ? (
          <div className="fe2-cheer-admin">
            <span className="fe2-stat-hint" data-testid="fe2-campfire-cheer-count">
              押した人 {s ? `${s.totalCheerers} 名` : "—"}
            </span>
            <Button variant="secondary" size="sm" onClick={() => setListOpen(true)} testId="fe2-campfire-cheerers-open">
              一覧を見る
            </Button>
          </div>
        ) : null}
      </div>
      {canViewCheerers ? <CheerersDialog api={api} open={listOpen} onClose={() => setListOpen(false)} /> : null}
    </Card>
  );
}
