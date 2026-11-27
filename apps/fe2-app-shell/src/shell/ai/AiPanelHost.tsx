// Wires the @dub/app-ui AiSidePanel into the shell: resolves what the viewer is looking at
// (aiPanelContext), shows the event's 「AI のまとめ」 (FE3) when an event is in focus, and
// injects the send function (aiChatSender — undefined while the AI chat is closed).
import { useMemo, useState, type ReactNode } from "react";
import { Icon, useMediaQuery, NARROW_VIEWPORT_QUERY } from "@dub/ui";
import { AI_CHAT_AVAILABLE, AI_UNAVAILABLE_MESSAGE, AiSidePanel, type AiPanelContext } from "@dub/app-ui";
import {
  EventAiDigestSummary,
  EventApiProvider,
  NavigationProvider as EventNavigationProvider,
  useCurrentEventId,
  useEventDetailQuery,
  type EventApi,
} from "@dub/fe3-event-action";
import type { NavEntry } from "../../modules/types.tsx";
import { pickAiPanelSender, type AiPanelSender } from "./aiChatSender.ts";
import { resolveAiPanelTarget, type AiPanelTarget } from "./aiPanelContext.ts";
import styles from "./AiPanelHost.module.css";

export interface AiPanelHostProps {
  pathname: string;
  navEntries: NavEntry[];
  onClose: () => void;
  onNavigate?: (path: string) => void;
  eventApi?: EventApi;
  /** Test seam: override the sender (else chosen from AI_CHAT_AVAILABLE + context). */
  sender?: AiPanelSender;
}

interface Exchange {
  question: string;
  answer: string;
}

function EventTitle({ eventId, children }: { eventId: string; children: (ctx: AiPanelContext) => ReactNode }) {
  const q = useEventDetailQuery(eventId);
  return <>{children({ label: "イベント", title: q.data?.title ?? null, loading: q.isLoading })}</>;
}

export function AiPanelHost({ pathname, navEntries, onClose, onNavigate, eventApi, sender }: AiPanelHostProps): JSX.Element {
  const selectedEventId = useCurrentEventId();
  const target: AiPanelTarget = resolveAiPanelTarget(pathname, navEntries, selectedEventId);
  const narrow = useMediaQuery(NARROW_VIEWPORT_QUERY);
  const send = sender ?? pickAiPanelSender(target, eventApi);
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  const [sending, setSending] = useState(false);

  // FE3's source links navigate through its own contract; on a phone the sheet covers the
  // page, so close it when a link takes the viewer somewhere.
  const navigation = useMemo(
    () => ({
      navigate: (to: string) => {
        onNavigate?.(to);
        if (narrow) onClose();
      },
      params: {},
      search: "",
      setSearch: () => {},
    }),
    [onNavigate, narrow, onClose],
  );

  const onSend = send
    ? async (question: string) => {
        setSending(true);
        try {
          const res = await send(question);
          const answer =
            res.status === "answered" && res.answer ? res.answer : "今は答えられません（AI が止まっているか、つながっていません）。";
          setExchanges((xs) => [...xs, { question, answer }]);
        } finally {
          setSending(false);
        }
      }
    : undefined;

  const panel = (context: AiPanelContext | null, body: ReactNode) => (
    <AiSidePanel
      onClose={onClose}
      context={context}
      chatAvailable={AI_CHAT_AVAILABLE || sender !== undefined}
      unavailableMessage={AI_UNAVAILABLE_MESSAGE}
      {...(onSend ? { onSend } : {})}
      sending={sending}
      placeholder={target.kind === "event" ? "例: 会場の予約は済んでいますか？" : "この画面について質問する"}
      testId="fe2-ai-panel"
    >
      {body}
      {exchanges.length > 0 ? (
        <ol className={styles.exchanges} data-testid="fe2-ai-panel-answers">
          {exchanges.map((x, i) => (
            <li key={i} className={styles.exchange}>
              <p className={styles.question}>{x.question}</p>
              <p className={styles.answer}>{x.answer}</p>
            </li>
          ))}
        </ol>
      ) : null}
    </AiSidePanel>
  );

  if (target.kind === "event" && eventApi) {
    return (
      <EventApiProvider api={eventApi}>
        <EventNavigationProvider value={navigation}>
          <EventTitle eventId={target.eventId}>
            {(ctx) => panel(ctx, <EventAiDigestSummary eventId={target.eventId} idPrefix="fe2-ai-panel-digest" />)}
          </EventTitle>
        </EventNavigationProvider>
      </EventApiProvider>
    );
  }

  const context: AiPanelContext =
    target.kind === "app" ? { label: "アプリ", title: target.label } : { label: "ホーム", title: null };
  return panel(
    context,
    <p className={styles.hint} data-testid="fe2-ai-panel-hint">
      <Icon name="info" />
      <span>イベントを選ぶと、そのイベントの「AI のまとめ」がここに出ます。</span>
    </p>,
  );
}
