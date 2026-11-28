// EventHubOverview — the event home's top (#879). Reads top-down as イベント > アクション:
//   1. hero: title + phase + the four fixed facts (開催日 / 会場 / 定員 / 本番まで)
//   2. このイベントのアプリ: links to the other Dub apps, scoped where a route exists
//   3. アクション: the event's actions, each opening its own page
// The AI digest and the detail store keep rendering below (owned by EventHubPage).
import type { ReactNode } from "react";
import type { event } from "@dub/types";
import { Badge, Breadcrumbs, Button, EmptyState, ErrorState, Icon, SkeletonList, type IconName } from "@dub/ui";
import { useActionsQuery } from "../hooks/useEventQueries";
import { useActionRegistry } from "../context/ApiContext";
import { useNavigation } from "../contracts/navigation";
import { eventRoutes } from "../lib/routes";
import { daysUntil, eventAppLinks } from "../lib/eventLinks";
import { normalizeError } from "../lib/errorMap";
import { PhaseBadge } from "./PhaseBadge";
import styles from "./EventHubOverview.module.css";

function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("ja-JP", {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "short",
  });
}

function Fact({ icon, label, value, testId }: { icon: IconName; label: string; value: string | null; testId: string }) {
  return (
    <div className={styles.fact} data-testid={testId}>
      <span className={styles.factLabel}>
        <Icon name={icon} /> {label}
      </span>
      <span className={styles.factValue} data-empty={value ? undefined : "true"}>
        {value ?? "未設定"}
      </span>
    </div>
  );
}

function Section({
  title,
  aside,
  children,
  testId,
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
  testId: string;
}) {
  return (
    <section className={styles.section} data-testid={testId}>
      <div className={styles.sectionHead}>
        <h2 className={styles.sectionTitle}>{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

function ActionList({ eventId }: { eventId: string }) {
  const nav = useNavigation();
  const registry = useActionRegistry();
  const q = useActionsQuery(eventId);

  if (q.isPending) return <SkeletonList rows={3} testId="fe3-overview-actions-loading" />;
  if (q.isError) {
    const err = normalizeError(q.error);
    return (
      <ErrorState
        error={{ code: err.code, message: "アクションを取得できませんでした" }}
        onRetry={() => void q.refetch()}
      />
    );
  }
  const items = q.data.items.filter((a) => !a.archivedAt);
  if (items.length === 0) {
    return (
      <EmptyState
        icon="list"
        title="アクションはまだありません"
        description="アクションボードで、このイベントの取り組み（案内メール・設営など）を追加できます。"
        testId="fe3-overview-actions-empty"
      />
    );
  }
  return (
    <ul className={styles.actionList}>
      {items.map((a: event.DubAction) => {
        const plugin = registry.resolve(a.kind);
        return (
          <li key={a.id}>
            <button
              type="button"
              className={styles.actionRow}
              onClick={() => nav.navigate(eventRoutes.action(eventId, a.id))}
              data-testid={`fe3-overview-action-${a.id}`}
            >
              <Icon name={registry.has(a.kind) ? plugin.icon : "check-square"} />
              <span className={styles.actionTitle}>{a.title}</span>
              <Badge tone="neutral">{registry.has(a.kind) ? plugin.label : a.kind}</Badge>
              <Icon name="chevron-right" />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export function EventHubOverview({
  event: ev,
  canWrite,
  pageEditing,
  onEditInfo,
  onTogglePageEdit,
}: {
  event: event.DubEvent;
  canWrite: boolean;
  pageEditing: boolean;
  onEditInfo: () => void;
  onTogglePageEdit: (on: boolean) => void;
}) {
  const nav = useNavigation();
  const start = formatDate(ev.startsAt);
  const end = formatDate(ev.endsAt);
  const schedule = start && end && start !== end ? `${start} 〜 ${end}` : (start ?? end);
  const days = daysUntil(ev.startsAt);

  return (
    <div className={styles.root} data-testid="fe3-hub-overview">
      <Breadcrumbs
        testId="fe3-overview-breadcrumbs"
        items={[
          {
            label: "イベント",
            icon: "calendar",
            onClick: () => nav.navigate(eventRoutes.listAll()),
          },
          { label: ev.title },
        ]}
      />

      <header className={styles.hero} data-testid="fe3-hub-hero">
        <div className={styles.heroHead}>
          <div className={styles.heroTitleRow}>
            <h1 className={styles.heroTitle}>{ev.title}</h1>
            <PhaseBadge phase={ev.phase} testId="fe3-hub-phase" />
          </div>
          <div className={styles.heroActions}>
            {canWrite && pageEditing ? (
              <Button
                iconLeft={<Icon name="check" />}
                variant="primary"
                onClick={() => onTogglePageEdit(false)}
                testId="fe3-hub-edit-page-done"
              >
                編集を終了
              </Button>
            ) : null}
            {canWrite && !pageEditing ? (
              <>
                <Button
                  iconLeft={<Icon name="edit" />}
                  variant="secondary"
                  onClick={onEditInfo}
                  testId="fe3-hub-edit-event"
                >
                  基本情報を編集
                </Button>
                <Button
                  iconLeft={<Icon name="edit" />}
                  variant="ghost"
                  onClick={() => onTogglePageEdit(true)}
                  testId="fe3-hub-edit-page"
                >
                  ページを編集
                </Button>
              </>
            ) : null}
            <Button
              iconLeft={<Icon name="settings" />}
              variant="ghost"
              onClick={() => nav.navigate(eventRoutes.settings(ev.id))}
              testId="fe3-hub-open-settings"
            >
              設定・使うアプリ
            </Button>
          </div>
        </div>
        {ev.description ? <p className={styles.heroDesc}>{ev.description}</p> : null}
        <div className={styles.facts}>
          <Fact icon="calendar" label="開催日" value={schedule} testId="fe3-overview-fact-date" />
          <Fact icon="flag" label="会場" value={ev.venue ?? null} testId="fe3-overview-fact-venue" />
          <Fact
            icon="users"
            label="定員"
            value={typeof ev.capacity === "number" ? `${ev.capacity.toLocaleString("ja-JP")}人` : null}
            testId="fe3-overview-fact-capacity"
          />
          <Fact
            icon="clock"
            label="本番まで"
            value={days === null ? null : days < 0 ? "開催済み" : days === 0 ? "今日" : `あと ${days} 日`}
            testId="fe3-overview-fact-countdown"
          />
        </div>
      </header>

      <Section title="このイベントのアプリ" testId="fe3-overview-apps">
        <div className={styles.appGrid}>
          {eventAppLinks(ev.id).map((l) => (
            <button
              key={l.id}
              type="button"
              className={styles.appTile}
              onClick={() => nav.navigate(l.href)}
              data-testid={`fe3-overview-app-${l.id}`}
            >
              <span className={styles.appTop}>
                <span className={styles.appIcon}>
                  <Icon name={l.icon} />
                </span>
                <Badge tone={l.scoped ? "brand" : "neutral"}>{l.scoped ? "このイベント" : "全体"}</Badge>
              </span>
              <span className={styles.appLabel}>{l.label}</span>
              <span className={styles.appDesc}>{l.desc}</span>
            </button>
          ))}
        </div>
      </Section>

      <Section
        title="アクション"
        testId="fe3-overview-actions"
        aside={
          <Button
            variant="ghost"
            size="sm"
            iconRight={<Icon name="chevron-right" />}
            onClick={() => nav.navigate(eventRoutes.detail(ev.id))}
            testId="fe3-hub-open-actions"
          >
            アクションボード
          </Button>
        }
      >
        <ActionList eventId={ev.id} />
      </Section>
    </div>
  );
}
