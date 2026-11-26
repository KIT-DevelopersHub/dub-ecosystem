// イベント設定 > 使うアプリ — which launcher apps this event uses. One switch per
// event-scoped app (event.EVENT_TOGGLEABLE_APPS). Org-wide apps (メール・チャット・通知・
// カレンダー …) are always on and are not listed.
// The shell greys (never removes) tiles of apps that are off for the current event.
// Optimistic: the switch flips at once; a failed save rolls back with an error toast.
import { Switch, SkeletonList } from "@dub/ui";
import { appRegistry, event as evNs, type common } from "@dub/types";
import { useEventAppsQuery } from "../hooks/useEventQueries";
import { useSaveEventApps } from "../hooks/useEventMutations";
import { normalizeError } from "../lib/errorMap";
import styles from "./components.module.css";

/** Stable marker for verify:live (the feature's liveness check). */
export const EVENT_APPS_MARKER = "fe3-event-apps";

const ALWAYS_ON: ReadonlySet<string> = new Set(evNs.EVENT_ALWAYS_ENABLED_APPS);
const TOGGLEABLE = appRegistry.APP_MANIFEST.filter((app) => evNs.isEventToggleableApp(app.id));

export interface EventAppsSettingsProps {
  eventId: common.EventId;
  canWrite: boolean;
}

export function EventAppsSettings({ eventId, canWrite }: EventAppsSettingsProps) {
  const q = useEventAppsQuery(eventId);
  const save = useSaveEventApps(eventId);

  if (q.isPending) return <SkeletonList rows={6} testId={`${EVENT_APPS_MARKER}-loading`} />;
  if (q.isError || !q.data) {
    return <div className={styles.errorText}>{normalizeError(q.error).message}</div>;
  }

  const enabled = new Set<string>(q.data.enabledApps);
  const toggle = (id: string, on: boolean) => {
    const next = evNs.EVENT_TOGGLEABLE_APPS.filter((a) => (a === id ? on : enabled.has(a)));
    save.mutate({ enabledApps: next });
  };

  return (
    <div className={styles.appToggleList} data-testid={EVENT_APPS_MARKER}>
      <p className={styles.kvLabel}>
        オフにしたアプリは、このイベントを選んでいる間ランチャーで灰色になります（消えません）。
        メール・チャット・通知・カレンダーなど団体全体で使うアプリはいつもオンです。
        {q.data.customized ? null : " このイベントはまだ設定していないため、すべてのアプリがオンです。"}
      </p>
      {TOGGLEABLE.map((app) => {
        const locked = ALWAYS_ON.has(app.id);
        return (
          <div key={app.id} className={styles.appToggleRow}>
            <Switch
              id={`event-app-${app.id}`}
              testId={`${EVENT_APPS_MARKER}-${app.id}`}
              label={locked ? `${app.label}（常にオン）` : app.label}
              checked={enabled.has(app.id)}
              disabled={!canWrite || locked}
              onChange={(on) => toggle(app.id, on)}
            />
          </div>
        );
      })}
    </div>
  );
}
