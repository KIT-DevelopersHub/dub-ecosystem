// スポンサー → 名刺一覧。サムネ + 会社名 + 氏名 + 役職 + 登録者 + 登録日のカードグリッド (新しい順)。
// 会社名・氏名・部署・メモで検索。カードを押すと詳細ドロワー。主ボタン「名刺をスキャン」は sponsor:write の人だけ。
import { useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Button, EmptyState, ErrorState, PageHeader, Skeleton, Stack, TextField } from "@dub/ui";
import { sponsor } from "@dub/types";
import { isTempCard, useCards } from "./sponsorHooks.ts";
import { CardDrawer } from "./CardDrawer.tsx";
import { CardPhoto, formatDate, RetryUpload, useSponsorCapability } from "./SponsorShared.tsx";
import styles from "./sponsor.module.css";

export const SCAN_PATH = "/sponsor/scan";

function matches(c: sponsor.BusinessCard, q: string): boolean {
  if (q === "") return true;
  return [c.companyName, c.personName, c.department, c.note].some((v) => v?.toLowerCase().includes(q));
}

function CardTile({ card, onOpen }: { card: sponsor.BusinessCard; onOpen: (id: string) => void }): JSX.Element {
  const saving = isTempCard(card);
  const sub = [card.personName && card.companyName ? card.personName : null, card.title].filter(Boolean).join("・");
  return (
    <li className={styles.tile} data-testid={`fe2-sponsor-card-${card.id}`}>
      <button
        type="button"
        className={styles.tileButton}
        disabled={saving}
        aria-label={`${sponsor.cardDisplayName(card)} の名刺を開く`}
        onClick={() => onOpen(card.id)}
      >
        <CardPhoto card={card} />
        <span className={styles.tileBody}>
          <span className={styles.tileTitle} data-testid="fe2-sponsor-card-name">
            {card.companyName ?? sponsor.cardDisplayName(card)}
          </span>
          {sub ? <span className={styles.tileSub}>{sub}</span> : null}
          <span className={styles.tileMeta}>
            {saving ? "保存中…" : `${card.createdByName ?? "—"}・${formatDate(card.createdAt)}`}
          </span>
        </span>
      </button>
      <div className={styles.tileRetry}>
        <RetryUpload card={card} />
      </div>
    </li>
  );
}

function GridSkeleton(): JSX.Element {
  return (
    <ul className={styles.grid} data-testid="fe2-sponsor-loading" aria-busy="true" aria-label="名刺を読み込み中">
      {Array.from({ length: 6 }, (_, i) => (
        <li key={i} className={styles.tile}>
          <div className={styles.photo}>
            <Skeleton variant="rect" width="100%" height="100%" radius="0" />
          </div>
          <div className={styles.tileBody}>
            <Skeleton width="70%" />
            <Skeleton width="45%" />
            <Skeleton width="55%" />
          </div>
        </li>
      ))}
    </ul>
  );
}

export function SponsorCardsScreen(): JSX.Element {
  const list = useCards();
  const navigate = useNavigate();
  const { canWrite } = useSponsorCapability();
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const scan = () => void navigate({ to: SCAN_PATH });

  const all = list.data?.cards ?? [];
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return all.filter((c) => matches(c, q));
  }, [all, query]);

  let body: JSX.Element;
  if (list.isLoading) {
    body = <GridSkeleton />;
  } else if (list.isError || !list.data) {
    body = (
      <ErrorState
        testId="fe2-sponsor-error"
        error={{ code: "INTERNAL", message: "名刺を読み込めませんでした。" }}
        onRetry={() => void list.refetch()}
      />
    );
  } else if (all.length === 0) {
    body = (
      <EmptyState
        testId="fe2-sponsor-empty"
        icon="folder"
        title="まだ名刺がありません"
        description={canWrite ? "受け取った名刺を撮影すると、スポンサーチームの全員で見られます。" : "スポンサーチームが登録した名刺がここに並びます。"}
        action={
          canWrite ? (
            <Button size="lg" testId="fe2-sponsor-empty-scan" onClick={scan}>
              名刺をスキャン
            </Button>
          ) : undefined
        }
      />
    );
  } else if (rows.length === 0) {
    body = <p className={styles.note} data-testid="fe2-sponsor-no-match">「{query.trim()}」に合う名刺はありません。</p>;
  } else {
    body = (
      <ul className={styles.grid} data-testid="fe2-sponsor-grid">
        {rows.map((c) => (
          <CardTile key={c.id} card={c} onOpen={setOpenId} />
        ))}
      </ul>
    );
  }

  return (
    <div className={styles.page}>
      <Stack gap={6} testId="fe2-sponsor-cards-screen">
        <PageHeader
          testId="fe2-sponsor-header"
          title="名刺"
          description="スポンサーチームで受け取った名刺を共有します。"
          actions={
            canWrite ? (
              <Button testId="fe2-sponsor-scan" onClick={scan}>
                名刺をスキャン
              </Button>
            ) : undefined
          }
        />
        {all.length > 0 ? (
          <div className={styles.search}>
            <TextField
              id="sponsor-search"
              testId="fe2-sponsor-search"
              value={query}
              onChange={setQuery}
              placeholder="会社名・氏名・部署・メモで検索"
            />
          </div>
        ) : null}
        {body}
      </Stack>
      <CardDrawer cardId={openId} onClose={() => setOpenId(null)} />
    </div>
  );
}
