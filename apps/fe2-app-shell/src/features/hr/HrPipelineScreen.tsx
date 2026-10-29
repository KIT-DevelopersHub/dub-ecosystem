// 人事 → パイプライン (カンバン) と 応募者一覧。どちらもカードや行を押すと詳細ドロワーが開く。
// カンバンはドラッグでも、カードの「←/→」ボタン (キーボード操作可) でも段階を動かせる。段階移動は
// 楽観的 UI。内定 → 参加 は名簿への追加を伴うので、ドロップ/ボタンではなく確認ダイアログを通す。
import { useMemo, useState, type DragEvent } from "react";
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  PageHeader,
  SegmentedControl,
  SkeletonLoader,
  Stack,
} from "@dub/ui";
import { hr } from "@dub/types";
import { useApplicants, useHrTeams, useMoveStage } from "./hrHooks.ts";
import { ApplicantDrawer, NewApplicantModal, StageBadge, STAGE_LABELS, nextStage, prevStage, useHrCapability } from "./HrShared.tsx";
import { HrTabs, type HrTabId } from "./HrTabs.tsx";
import styles from "./hr.module.css";

const DRAG_MIME = "application/x-dub-hr-applicant";

function HrFrame({ active, children }: { active: HrTabId; children: JSX.Element }): JSX.Element {
  const { canWrite } = useHrCapability();
  const [creating, setCreating] = useState(false);
  return (
    <Stack gap={6} testId={`fe2-hr-${active}-screen`}>
      <PageHeader
        testId="fe2-hr-header"
        title="人事"
        description="応募から選考・参加・オンボーディングまでを管理します。参加が決まった人は運営メンバー・名簿に追加されます。"
        actions={
          canWrite && active !== "onboarding" ? (
            <Button testId="fe2-hr-new" onClick={() => setCreating(true)}>
              応募者を登録
            </Button>
          ) : undefined
        }
      />
      <HrTabs active={active} />
      {children}
      <NewApplicantModal open={creating} onClose={() => setCreating(false)} />
    </Stack>
  );
}

function LoadingBoard(): JSX.Element {
  return (
    <div className={styles.board} data-testid="fe2-hr-loading">
      {hr.PIPELINE_STAGES.map((s) => (
        <div key={s} className={styles.column}>
          <SkeletonLoader lines={4} />
        </div>
      ))}
    </div>
  );
}

function LoadError({ onRetry }: { onRetry: () => void }): JSX.Element {
  return (
    <ErrorState testId="fe2-hr-error" error={{ code: "INTERNAL", message: "応募者を読み込めませんでした。" }} onRetry={onRetry} />
  );
}

function ApplicantCard({
  a,
  teamName,
  canWrite,
  onOpen,
}: {
  a: hr.Applicant;
  teamName: string | undefined;
  canWrite: boolean;
  onOpen: () => void;
}): JSX.Element {
  const move = useMoveStage();
  const next = nextStage(a.stage);
  const prev = prevStage(a.stage);
  return (
    <div
      className={styles.card}
      role="button"
      tabIndex={0}
      data-testid={`fe2-hr-card-${a.id}`}
      draggable={canWrite && a.stage !== "joined"}
      onDragStart={(e) => e.dataTransfer.setData(DRAG_MIME, a.id)}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      <span className={styles.cardName}>{a.name}</span>
      <span className={styles.cardMeta}>{[a.department, a.grade, teamName].filter(Boolean).join(" ・ ") || "—"}</span>
      {canWrite && (prev || next) ? (
        <div className={styles.cardActions} onClick={(e) => e.stopPropagation()}>
          {prev ? (
            <Button
              size="sm"
              variant="ghost"
              testId={`fe2-hr-card-${a.id}-prev`}
              onClick={() => move.mutate({ applicant: a, stage: prev })}
            >
              ← 戻す
            </Button>
          ) : (
            <span />
          )}
          {next ? (
            <Button
              size="sm"
              variant="secondary"
              testId={`fe2-hr-card-${a.id}-next`}
              onClick={() => move.mutate({ applicant: a, stage: next })}
            >
              {STAGE_LABELS[next]}へ →
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function HrPipelineScreen(): JSX.Element {
  const list = useApplicants();
  const teams = useHrTeams();
  const { canWrite } = useHrCapability();
  const move = useMoveStage();
  const [openId, setOpenId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<hr.ApplicantStage | null>(null);
  const teamName = (id: string | null) => teams.data?.teams.find((t) => t.id === id)?.name;

  const grouped = useMemo(() => {
    const g = new Map<hr.ApplicantStage, hr.Applicant[]>(hr.APPLICANT_STAGES.map((s) => [s, []]));
    for (const a of list.data?.applicants ?? []) g.get(a.stage)?.push(a);
    return g;
  }, [list.data]);

  const onDrop = (stage: hr.ApplicantStage) => (e: DragEvent) => {
    e.preventDefault();
    setDropTarget(null);
    const id = e.dataTransfer.getData(DRAG_MIME);
    const a = list.data?.applicants.find((x) => x.id === id);
    if (a && a.stage !== stage && hr.canTransition(a.stage, stage)) move.mutate({ applicant: a, stage });
  };

  let body: JSX.Element;
  if (list.isLoading) body = <LoadingBoard />;
  else if (list.isError || !list.data) body = <LoadError onRetry={() => void list.refetch()} />;
  else {
    const closed = [...(grouped.get("rejected") ?? []), ...(grouped.get("withdrawn") ?? [])];
    body = (
      <Stack gap={6}>
        <div className={styles.board} data-testid="fe2-hr-board">
          {hr.PIPELINE_STAGES.map((stage) => {
            const items = grouped.get(stage) ?? [];
            return (
              <section
                key={stage}
                className={`${styles.column} ${dropTarget === stage ? styles.columnDrop : ""}`}
                data-testid={`fe2-hr-column-${stage}`}
                aria-label={STAGE_LABELS[stage]}
                onDragOver={(e) => {
                  if (!canWrite || stage === "joined") return;
                  e.preventDefault();
                  setDropTarget(stage);
                }}
                onDragLeave={() => setDropTarget(null)}
                onDrop={onDrop(stage)}
              >
                <div className={styles.columnHeader}>
                  <span>{STAGE_LABELS[stage]}</span>
                  <span className={styles.columnCount}>{items.length}</span>
                </div>
                {items.length === 0 ? <span className={styles.empty}>なし</span> : null}
                {items.map((a) => (
                  <ApplicantCard key={a.id} a={a} teamName={teamName(a.desiredTeamId)} canWrite={canWrite} onOpen={() => setOpenId(a.id)} />
                ))}
              </section>
            );
          })}
        </div>
        <Card testId="fe2-hr-closed" header={<span className={styles.sectionTitle}>不採用・辞退（{closed.length}）</span>}>
          {closed.length === 0 ? (
            <span className={styles.note}>まだありません。</span>
          ) : (
            <div className={styles.closedRow}>
              {closed.map((a) => (
                <Button key={a.id} variant="ghost" size="sm" testId={`fe2-hr-closed-${a.id}`} onClick={() => setOpenId(a.id)}>
                  {a.name}（{STAGE_LABELS[a.stage]}）
                </Button>
              ))}
            </div>
          )}
        </Card>
      </Stack>
    );
  }

  return (
    <HrFrame active="pipeline">
      <>
        {body}
        <ApplicantDrawer applicantId={openId} onClose={() => setOpenId(null)} />
      </>
    </HrFrame>
  );
}

type StageFilter = "all" | "active" | hr.ApplicantStage;

export function HrListScreen(): JSX.Element {
  const list = useApplicants();
  const teams = useHrTeams();
  const [filter, setFilter] = useState<StageFilter>("active");
  const [openId, setOpenId] = useState<string | null>(null);

  let body: JSX.Element;
  if (list.isLoading) {
    body = (
      <Card testId="fe2-hr-loading">
        <SkeletonLoader lines={6} />
      </Card>
    );
  } else if (list.isError || !list.data) {
    body = <LoadError onRetry={() => void list.refetch()} />;
  } else {
    const rows = list.data.applicants.filter((a) =>
      filter === "all" ? true : filter === "active" ? !["joined", "rejected", "withdrawn"].includes(a.stage) : a.stage === filter,
    );
    body =
      list.data.applicants.length === 0 ? (
        <EmptyState testId="fe2-hr-empty" icon="user" title="まだ応募者がいません" description="「応募者を登録」から追加できます。" />
      ) : (
        <Card padded={false} testId="fe2-hr-list">
          {rows.length === 0 ? (
            <div style={{ padding: "var(--dub-space-5)" }} className={styles.note}>
              条件に合う応募者はいません。
            </div>
          ) : (
            rows.map((a) => (
              <button key={a.id} type="button" className={styles.listRow} data-testid={`fe2-hr-row-${a.id}`} onClick={() => setOpenId(a.id)}>
                <span className={styles.cardName}>{a.name}</span>
                <span className={styles.cardMeta}>
                  {[a.department, a.grade, teams.data?.teams.find((t) => t.id === a.desiredTeamId)?.name].filter(Boolean).join(" ・ ") || "—"}
                </span>
                <span className={styles.cardMeta}>{a.source ?? ""}</span>
                <StageBadge stage={a.stage} />
              </button>
            ))
          )}
        </Card>
      );
  }

  return (
    <HrFrame active="list">
      <>
        <SegmentedControl<StageFilter>
          testId="fe2-hr-filter"
          aria-label="段階で絞り込み"
          value={filter}
          onChange={setFilter}
          options={[
            { value: "active", label: "選考中" },
            { value: "joined", label: "参加" },
            { value: "rejected", label: "不採用" },
            { value: "withdrawn", label: "辞退" },
            { value: "all", label: "すべて" },
          ]}
        />
        {body}
        <ApplicantDrawer applicantId={openId} onClose={() => setOpenId(null)} />
      </>
    </HrFrame>
  );
}

export { HrFrame };
