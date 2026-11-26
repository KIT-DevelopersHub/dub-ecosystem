// 「AI のまとめ」 (#879): a read-only digest of the event gathered from other apps, each
// line with its source link, a 食い違い banner when a source disagrees with the event's
// own fields, an admin 「今すぐ要約」 button, and a Q&A box. Every state is explicit:
// skeleton while loading, 「停止中」 when the flag is OFF or the Mac mini is offline.
// Release-gated: admins only until AI_DIGEST_RELEASED (lib/aiDigestRelease.ts).
import { useState } from "react";
import type { event } from "@dub/types";
import { Badge, Button, Icon, SkeletonLoader, Textarea } from "@dub/ui";
import { useCan } from "../contracts/fe2";
import { useNavigation } from "../contracts/navigation";
import { useEventDigestQuery } from "../hooks/useEventQueries";
import { useAskEvent, useRunEventDigest } from "../hooks/useEventMutations";
import { aiDigestVisible, AI_DIGEST_RELEASED, fieldLabel, isExternalLink, sourceLabel } from "../lib/aiDigestRelease";
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

function Discrepancies({ items }: { items: event.EventDigestDiscrepancy[] }) {
  if (items.length === 0) return null;
  return (
    <div className={styles.aiDiscrepancy} role="alert" data-testid="fe3-ai-discrepancy">
      <div className={styles.aiDiscrepancyTitle}>
        <Icon name="alert-triangle" /> 食い違いがあります（直すのは人です。AI は書き換えません）
      </div>
      <ul className={styles.aiList}>
        {items.map((d, i) => (
          <li key={`${d.field}-${d.source}-${i}`}>
            {fieldLabel(d.field)}: イベントは「{d.eventValue}」、{sourceLabel(d.source)}は「{d.sourceValue}」{" "}
            <SourceLink link={d.link} label={`${sourceLabel(d.source)}を開く`} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function AskBox({ eventId, stopped }: { eventId: string; stopped: "disabled" | "offline" | null }) {
  const [q, setQ] = useState("");
  const ask = useAskEvent(eventId);
  const res = ask.data;
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
        placeholder={stopped ? "停止中のため質問できません" : "例: 会場の予約は済んでいますか？"}
        disabled={stopped !== null || ask.isPending}
        testId="fe3-ai-ask-input"
      />
      <div>
        <Button
          variant="secondary"
          iconLeft={<Icon name="send" />}
          onClick={() => ask.mutate(q.trim())}
          disabled={stopped !== null || q.trim() === "" || ask.isPending}
          testId="fe3-ai-ask-submit"
        >
          質問する
        </Button>
      </div>
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

export function EventAiDigestPanel({ eventId, canRun }: { eventId: string; canRun: boolean }) {
  const isAdmin = useCan("identity:admin");
  const visible = aiDigestVisible(isAdmin);
  const q = useEventDigestQuery(eventId, visible);
  const run = useRunEventDigest(eventId);
  if (!visible) return null;

  const data = q.data;
  const stopped: "disabled" | "offline" | null = !data
    ? null
    : !data.enabled
      ? "disabled"
      : data.provider.status === "offline"
        ? "offline"
        : null;
  const digest = data?.digest ?? null;

  return (
    <section className={`${styles.section} ${styles.aiPanel}`} data-testid="fe3-ai-digest">
      <div className={styles.sectionHead}>
        <Icon name="info" />
        <span className={styles.sectionHeadTitle}>AI のまとめ</span>
        <Badge tone="info">AI が作った要約です</Badge>
        {!AI_DIGEST_RELEASED ? <Badge tone="neutral">未公開・管理者だけに表示</Badge> : null}
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
          {stopped ? <StoppedNotice reason={stopped} /> : null}
          {digest ? (
            <>
              <Discrepancies items={digest.discrepancies} />
              {digest.lines.length > 0 ? (
                <ul className={styles.aiLines} data-testid="fe3-ai-lines">
                  {digest.lines.map((l, i) => (
                    <li key={`${l.link}-${i}`} className={styles.aiLine}>
                      <span>{l.text}</span>
                      <SourceLink link={l.link} label={sourceLabel(l.source)} />
                    </li>
                  ))}
                </ul>
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
          <AskBox eventId={eventId} stopped={stopped} />
        </>
      )}
    </section>
  );
}
