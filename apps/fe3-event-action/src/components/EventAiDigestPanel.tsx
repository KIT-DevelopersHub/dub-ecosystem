// 「AI のまとめ」 (#879): a read-only digest of the event gathered from other apps, each
// line with its source link, a 食い違い banner when a source disagrees with the event's
// own fields, an admin 「今すぐ要約」 button, and a Q&A box. Shown to every member.
// While the flag is OFF the server sends a no-LLM preview (the event's own facts +
// 食い違い); with nothing to show, the 公開予定 notice. The chat is closed until
// AI_CHAT_AVAILABLE (lib/aiDigestRelease.ts).
import { useState } from "react";
import type { event } from "@dub/types";
import { Badge, Button, Icon, SkeletonLoader, Textarea } from "@dub/ui";
import { useNavigation } from "../contracts/navigation";
import { useEventDigestQuery } from "../hooks/useEventQueries";
import { useAskEvent, useRunEventDigest } from "../hooks/useEventMutations";
import {
  AI_CHAT_AVAILABLE,
  AI_UNAVAILABLE_MESSAGE,
  fieldLabel,
  isExternalLink,
  sourceLabel,
} from "../lib/aiDigestRelease";
import { normalizeError } from "../lib/errorMap";
import styles from "./components.module.css";

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("ja-JP", { dateStyle: "medium", timeStyle: "short" });
}

function SourceLink({ link, label }: { link: string; label: string }) {
  const nav = useNavigation();
  if (isExternalLink(link)) {
    return (
      <a className={styles.aiSourceLink} href={link} target="_blank" rel="noreferrer noopener">
        {label} <Icon name="external-link" />
      </a>
    );
  }
  return (
    <button type="button" className={styles.aiSourceLink} onClick={() => nav.navigate(link)}>
      {label} <Icon name="chevron-right" />
    </button>
  );
}

function StoppedNotice({ reason }: { reason: "disabled" | "offline" }) {
  return (
    <div className={styles.aiStopped} role="status" data-testid="fe3-ai-stopped">
      <Icon name="ban" />
      <span>
        停止中 —{" "}
        {reason === "disabled"
          ? "AI のまとめは Mac mini の準備ができるまで止めています。"
          : "Mac mini とつながっていないため、今は答えられません。"}
      </span>
    </div>
  );
}

function ComingSoonNotice({ testId, prefix }: { testId: string; prefix?: string }) {
  return (
    <div className={styles.aiStopped} role="status" data-testid={testId}>
      <Icon name="clock" />
      <span>
        {prefix}
        {AI_UNAVAILABLE_MESSAGE}
      </span>
    </div>
  );
}

function CitedLines({ lines, testId }: { lines: event.EventDigestLine[]; testId: string }) {
  return (
    <ul className={styles.aiLines} data-testid={testId}>
      {lines.map((l, i) => (
        <li key={`${l.link}-${i}`} className={styles.aiLine}>
          <span>{l.text}</span>
          <SourceLink link={l.link} label={sourceLabel(l.source)} />
        </li>
      ))}
    </ul>
  );
}

function Discrepancies({ items }: { items: event.EventDigestDiscrepancy[] }) {
  if (items.length === 0) return null;
  return (
    <div className={styles.aiDiscrepancy} role="alert" data-testid="fe3-ai-discrepancy">
      <div className={styles.aiDiscrepancyTitle}>
        <Icon name="alert-triangle" /> 食い違いがあります（直すのは人です。AI は書き換えません）
      </div>
      <ul className={styles.aiList}>
        {items.map((d, i) => {
          // source "event" = the legacy free-text 詳細欄 disagreeing with the event's own field.
          const name = d.source === "event" ? "詳細欄" : sourceLabel(d.source);
          return (
            <li key={`${d.field}-${d.source}-${i}`}>
              {fieldLabel(d.field)}: イベントは「{d.eventValue}」、{name}は「{d.sourceValue}」{" "}
              <SourceLink link={d.link} label={`${name}を開く`} />
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function AskBox({ eventId, stopped }: { eventId: string; stopped: Stopped }) {
  const [q, setQ] = useState("");
  const ask = useAskEvent(eventId);
  const res = ask.data;
  const closed = !AI_CHAT_AVAILABLE || stopped !== null;
  return (
    <div className={styles.aiAsk} data-testid="fe3-ai-ask">
      <label className={styles.aiAskLabel} htmlFor="fe3-ai-ask-input">
        このイベントについて質問する
      </label>
      <Textarea
        id="fe3-ai-ask-input"
        value={q}
        onChange={setQ}
        rows={2}
        placeholder={
          !AI_CHAT_AVAILABLE
            ? AI_UNAVAILABLE_MESSAGE
            : stopped
              ? "停止中のため質問できません"
              : "例: 会場の予約は済んでいますか？"
        }
        disabled={closed || ask.isPending}
        testId="fe3-ai-ask-input"
      />
      <div>
        <Button
          variant="secondary"
          iconLeft={<Icon name="send" />}
          onClick={() => ask.mutate(q.trim())}
          disabled={closed || q.trim() === "" || ask.isPending}
          testId="fe3-ai-ask-submit"
        >
          質問する
        </Button>
      </div>
      {!AI_CHAT_AVAILABLE ? <ComingSoonNotice testId="fe3-ai-chat-unavailable" /> : null}
      {ask.isPending ? <SkeletonLoader lines={2} /> : null}
      {ask.isError ? <div className={styles.errorText}>{normalizeError(ask.error).message}</div> : null}
      {res && res.status !== "answered" ? <StoppedNotice reason={res.status} /> : null}
      {res && res.status === "answered" ? (
        <div className={styles.aiAnswer} data-testid="fe3-ai-answer">
          <p className={styles.sectionBody}>{res.answer}</p>
          {res.sources.length > 0 ? (
            <ul className={styles.aiList}>
              {res.sources.map((s, i) => (
                <li key={`${s.link}-${i}`}>
                  <SourceLink link={s.link} label={s.label || "出典"} />
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

type Stopped = "disabled" | "offline" | null;

function stoppedOf(data: event.GetEventDigestResponse | undefined): Stopped {
  if (!data) return null;
  if (!data.enabled) return "disabled";
  return data.provider.status === "offline" ? "offline" : null;
}

// The read-only digest (preview while AI is OFF / the AI digest once ON). Shared by the event
// home panel and the shell's AI side panel; `idPrefix` keeps their testids apart.
function DigestBody({
  data,
  canRun,
  idPrefix,
}: {
  data: event.GetEventDigestResponse | undefined;
  canRun: boolean;
  idPrefix: string;
}) {
  const stopped = stoppedOf(data);
  const digest = data?.digest ?? null;
  const preview = !digest && stopped === "disabled" ? (data?.preview ?? null) : null;
  const hasPreview = preview !== null && (preview.lines.length > 0 || preview.discrepancies.length > 0);
  return (
    <>
      {stopped === "offline" ? <StoppedNotice reason={stopped} /> : null}
      {hasPreview && preview ? (
        <>
          <Discrepancies items={preview.discrepancies} />
          {preview.lines.length > 0 ? <CitedLines lines={preview.lines} testId={`${idPrefix}-preview-lines`} /> : null}
          <div className={styles.aiMeta} data-testid={`${idPrefix}-preview-meta`}>
            {formatDateTime(preview.collectedAt)} 時点でイベントから集めた情報です。AI による要約は
            {AI_UNAVAILABLE_MESSAGE}
          </div>
        </>
      ) : stopped === "disabled" ? (
        <ComingSoonNotice testId={`${idPrefix}-digest-coming-soon`} prefix="AI のまとめは" />
      ) : null}
      {digest ? (
        <>
          <Discrepancies items={digest.discrepancies} />
          {digest.lines.length > 0 ? (
            <CitedLines lines={digest.lines} testId={`${idPrefix}-lines`} />
          ) : (
            <div className={styles.sectionEmpty}>まとめる内容がありませんでした。</div>
          )}
          <div className={styles.aiMeta}>
            {formatDateTime(digest.generatedAt)} に作成（{digest.trigger === "manual" ? "手動" : "定期"}・{digest.model}）
          </div>
        </>
      ) : stopped ? null : (
        <div className={styles.sectionEmpty}>
          まだまとめがありません。{canRun ? "「今すぐ要約」で作れます。" : "管理者が作るまでお待ちください。"}
        </div>
      )}
    </>
  );
}

/** 「AI のまとめ」の中身だけ (今すぐ要約・質問欄なし)。シェルの AI パネルが使う。 */
export function EventAiDigestSummary({ eventId, idPrefix = "fe3-ai-summary" }: { eventId: string; idPrefix?: string }) {
  const q = useEventDigestQuery(eventId);
  return (
    <section className={styles.aiSummary} aria-label="AI のまとめ" data-testid={idPrefix}>
      <div className={styles.aiSummaryHead}>
        <Icon name="info" />
        <span>AI のまとめ</span>
      </div>
      {q.isLoading ? (
        <SkeletonLoader lines={4} testId={`${idPrefix}-skeleton`} />
      ) : q.isError ? (
        <div className={styles.errorText}>{normalizeError(q.error).message}</div>
      ) : (
        <DigestBody data={q.data} canRun={false} idPrefix={idPrefix} />
      )}
    </section>
  );
}

export function EventAiDigestPanel({ eventId, canRun }: { eventId: string; canRun: boolean }) {
  const q = useEventDigestQuery(eventId);
  const run = useRunEventDigest(eventId);

  const data = q.data;
  const stopped = stoppedOf(data);
  const digest = data?.digest ?? null;

  return (
    <section className={`${styles.section} ${styles.aiPanel}`} data-testid="fe3-ai-digest">
      <div className={styles.sectionHead}>
        <Icon name="info" />
        <span className={styles.sectionHeadTitle}>AI のまとめ</span>
        {digest ? <Badge tone="info">AI が作った要約です</Badge> : null}
        <span className={styles.aiHeadSpacer} />
        {canRun ? (
          <Button
            variant="secondary"
            iconLeft={<Icon name="refresh" />}
            onClick={() => run.mutate()}
            disabled={stopped !== null || run.isPending || q.isLoading}
            testId="fe3-ai-run"
          >
            今すぐ要約
          </Button>
        ) : null}
      </div>

      {q.isLoading ? (
        <SkeletonLoader lines={4} testId="fe3-ai-skeleton" />
      ) : q.isError ? (
        <div className={styles.errorText}>{normalizeError(q.error).message}</div>
      ) : (
        <>
          <DigestBody data={data} canRun={canRun} idPrefix="fe3-ai" />
          <AskBox eventId={eventId} stopped={stopped} />
        </>
      )}
    </section>
  );
}
