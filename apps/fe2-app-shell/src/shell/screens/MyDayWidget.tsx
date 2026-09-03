// MyDayWidget — the personal "マイデイ" card at the top of the home rail. Turns the
// dashboard from an org-wide readout into a per-viewer starting point: 対応中の
// タスク (live from /bff/home taskSummary), 未読メンション, and quick actions.
//
// Data honesty (design 2-1): only 対応中のタスク has a live source today. 未読メンション
// has no dedicated upstream yet, so it renders a丁寧な空状態 (a forward-looking
// placeholder, NOT a fake number or an error). Pending frames show a skeleton so a
// slow /bff/home never flashes an empty state that then fills in.
import { Badge, Button, Card, Icon, SkeletonLoader } from "@dub/ui";
import type { IconName } from "@dub/ui";

interface QuickAction {
  id: string;
  label: string;
  icon: IconName;
  path: string;
}

// Quick actions are pure SPA navigations (always available — no data dependency),
// so they never skeleton/empty. Paths mirror the registered nav entries.
const QUICK_ACTIONS: QuickAction[] = [
  { id: "tasks", label: "マイタスク", icon: "check-square", path: "/me/tasks" },
  { id: "events", label: "イベント", icon: "calendar", path: "/events" },
  { id: "chat", label: "チャット", icon: "message-square", path: "/chat" },
  { id: "mail", label: "メール", icon: "inbox", path: "/mail" },
];

function today(): string {
  try {
    return new Intl.DateTimeFormat("ja-JP", { month: "long", day: "numeric", weekday: "short" }).format(new Date());
  } catch {
    return "";
  }
}

export function MyDayWidget({
  openTasks,
  isPending,
  taskError,
  onNavigate,
}: {
  /** 対応中 (todo + in_progress + blocked) task count from /bff/home; undefined when
   *  pending or when task-service is in partialErrors. */
  openTasks: number | undefined;
  isPending: boolean;
  taskError: boolean;
  onNavigate?: (path: string) => void;
}): JSX.Element {
  const go = (path: string) => (e: { preventDefault(): void }) => {
    if (onNavigate) {
      e.preventDefault();
      onNavigate(path);
    }
  };

  return (
    <Card
      testId="fe2-home-myday"
      header={
        <div className="fe2-home-card-head">
          <span className="fe2-stat-label">
            <Icon name="sun" />
            マイデイ
          </span>
          <span className="fe2-myday-date" data-testid="fe2-myday-date">
            {today()}
          </span>
        </div>
      }
    >
      <div className="fe2-myday">
        {/* ── 対応中のタスク (live) ─────────────────────────────────────────────── */}
        <section className="fe2-myday-section" aria-label="対応中のタスク">
          <h3 className="fe2-myday-title">
            <Icon name="check-square" size="sm" />
            対応中のタスク
          </h3>
          {isPending ? (
            <SkeletonLoader lines={2} />
          ) : taskError ? (
            <p className="fe2-stat-hint" data-testid="fe2-myday-tasks-error">
              タスクを取得できませんでした。
            </p>
          ) : openTasks === undefined || openTasks === 0 ? (
            <p className="fe2-stat-hint" data-testid="fe2-myday-tasks-empty">
              対応中のタスクはありません。今日はゆとりがあります。
            </p>
          ) : (
            <a
              href="/me/tasks"
              className="fe2-myday-tasklink"
              data-testid="fe2-myday-open-tasks"
              onClick={go("/me/tasks")}
              aria-label={`対応中のタスク ${openTasks} 件をマイタスクで開く`}
            >
              <span className="fe2-myday-count" data-testid="fe2-myday-open-count">
                {openTasks}
              </span>
              <span className="fe2-myday-count-unit">件 が未完了</span>
              <Icon name="chevron-right" size="sm" />
            </a>
          )}
        </section>

        {/* ── 未読メンション (no source yet → 丁寧な空状態) ──────────────────────── */}
        <section className="fe2-myday-section" aria-label="未読メンション">
          <h3 className="fe2-myday-title">
            <Icon name="at-sign" size="sm" />
            未読メンション
          </h3>
          {isPending ? (
            <SkeletonLoader lines={1} />
          ) : (
            <p className="fe2-stat-hint" data-testid="fe2-myday-mentions-empty">
              新しいメンションはありません。
            </p>
          )}
        </section>

        {/* ── クイックアクション (always available) ─────────────────────────────── */}
        <section className="fe2-myday-section" aria-label="クイックアクション">
          <h3 className="fe2-myday-title">
            <Icon name="plus" size="sm" />
            クイックアクション
          </h3>
          <div className="fe2-myday-actions" data-testid="fe2-myday-actions">
            {QUICK_ACTIONS.map((a) => (
              <Button
                key={a.id}
                variant="secondary"
                size="sm"
                iconLeft={<Icon name={a.icon} size="sm" />}
                onClick={() => onNavigate?.(a.path)}
                testId={`fe2-myday-action-${a.id}`}
              >
                {a.label}
              </Button>
            ))}
          </div>
        </section>
      </div>
    </Card>
  );
}
