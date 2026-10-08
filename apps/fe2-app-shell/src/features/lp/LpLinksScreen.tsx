// LP管理 → 流入URLタブ。「名前を付けて計測つき URL を発行する」→「流入元ごとの実績を見る」
// までを 1 画面で完結させる。
//
// 設計メモ:
//  - 発行する URL は LP の URL に utm_source を 1 個足したもの（lpLinks.ts）。中継を挟まないので
//    踏んだ人はワンホップで LP に着く。SNS に貼る値は小文字へ正規化して同じ流入元が割れないように。
//  - 発行・停止/再開は楽観的 UI（lpHooks）。先に一覧へ反映し、失敗したらロールバック + トースト。
//  - 読み込み中はスケルトン、未発行は空状態、失敗は再試行つきエラー（3 状態を必ず作り分ける）。
//  - 期間 SegmentedControl はログ管理タブと同じ lpRange を使い、数字の意味を揃える。
import { useMemo, useState } from "react";
import {
  Badge,
  Button,
  Card,
  DataTable,
  EmptyState,
  ErrorState,
  Form,
  FormField,
  PageHeader,
  SegmentedControl,
  SkeletonLoader,
  Stack,
  TextField,
  useToast,
  type ColumnDef,
} from "@dub/ui";
import type { LpLinkSummary } from "./lpApi.tsx";
import { useCreateLpLink, useLpLinks, useSetLpLinkActive } from "./lpHooks.ts";
import {
  LP_BASE_URL,
  LP_NAME_MAX,
  LP_SLUG_MAX,
  LP_TRACKING_PARAM,
  NO_DRAFT_ERRORS,
  buildTrackingUrl,
  formatLastVisit,
  hasDraftError,
  normalizeSlug,
  slugifySource,
  validateLinkDraft,
  type LpLinkDraftErrors,
} from "./lpLinks.ts";
import { LP_DEFAULT_RANGE_DAYS, LP_RANGE_DAYS, formatCount, rangeForDays, rangeLabel, type LpRangeDays } from "./lpRange.ts";
import { LpTabs } from "./LpTabs.tsx";
import styles from "./lp.module.css";

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** URL セル: 長い URL を折り返して全文見せ、コピーと「LPを開く」を並べる。 */
function UrlCell({ link }: { link: LpLinkSummary }): JSX.Element {
  const toast = useToast();
  return (
    <Stack gap={2}>
      <code className={styles.urlText} data-testid={`fe2-lp-link-url-${link.slug}`}>
        {link.url}
      </code>
      <div className={styles.urlActions}>
        <Button
          variant="secondary"
          size="sm"
          testId={`fe2-lp-link-copy-${link.slug}`}
          onClick={() => {
            void copyToClipboard(link.url).then((ok) =>
              toast.show({
                kind: ok ? "success" : "error",
                title: ok ? "流入URLをコピーしました" : "コピーに失敗しました（URLを選択して手動でコピーしてください）",
              }),
            );
          }}
        >
          コピー
        </Button>
        <a className={styles.urlOpen} href={link.url} target="_blank" rel="noreferrer noopener">
          LPを開く
        </a>
      </div>
    </Stack>
  );
}

function StateCell({
  link,
  onToggle,
  pending,
}: {
  link: LpLinkSummary;
  onToggle: (next: boolean) => void;
  pending: boolean;
}): JSX.Element {
  return (
    <Stack gap={2}>
      <Badge tone={link.active ? "success" : "neutral"} testId={`fe2-lp-link-state-${link.slug}`}>
        {link.active ? "有効" : "停止中"}
      </Badge>
      <Button
        variant="ghost"
        size="sm"
        disabled={pending}
        testId={`fe2-lp-link-toggle-${link.slug}`}
        onClick={() => onToggle(!link.active)}
      >
        {link.active ? "停止する" : "再開する"}
      </Button>
    </Stack>
  );
}

export function LpLinksScreen(): JSX.Element {
  const [days, setDays] = useState<LpRangeDays>(LP_DEFAULT_RANGE_DAYS);
  const range = useMemo(() => rangeForDays(days), [days]);

  const links = useLpLinks(range);
  const create = useCreateLpLink(range);
  const toggle = useSetLpLinkActive(range);

  const [name, setName] = useState("");
  // パラメータ値は「名前から自動で下書き → 触ったら手入力を尊重」。勝手に上書きし続けない。
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [errors, setErrors] = useState<LpLinkDraftErrors>(NO_DRAFT_ERRORS);

  const effectiveSlug = slugTouched ? normalizeSlug(slug) : slugifySource(name);
  const existingSlugs = useMemo(() => (links.data?.items ?? []).map((l) => l.slug), [links.data]);
  const preview = effectiveSlug ? buildTrackingUrl(effectiveSlug) : `${LP_BASE_URL}/?${LP_TRACKING_PARAM}=...`;

  const submit = () => {
    const draft = { name, slug: effectiveSlug };
    const next = validateLinkDraft(draft, existingSlugs);
    setErrors(next);
    if (hasDraftError(next)) return;
    create.mutate(
      { name: name.trim(), slug: normalizeSlug(effectiveSlug) },
      {
        onSuccess: () => {
          setName("");
          setSlug("");
          setSlugTouched(false);
          setErrors(NO_DRAFT_ERRORS);
        },
      },
    );
  };

  const columns: ColumnDef<LpLinkSummary>[] = useMemo(
    () => [
      {
        key: "name",
        header: "名前",
        minWidth: "9rem",
        cell: (l) => (
          <Stack gap={1}>
            <span className={styles.linkName}>{l.name}</span>
            <span className={styles.kpiHint}>
              {LP_TRACKING_PARAM}={l.slug}
            </span>
          </Stack>
        ),
      },
      { key: "url", header: "流入URL", minWidth: "20rem", cell: (l) => <UrlCell link={l} /> },
      {
        key: "visits",
        header: "期間内の訪問",
        align: "right",
        width: "8rem",
        cell: (l) => <span className={styles.num}>{formatCount(l.stats.visits)}</span>,
      },
      {
        key: "uniques",
        header: "一意訪問者",
        align: "right",
        width: "8rem",
        cell: (l) => <span className={styles.num}>{formatCount(l.stats.uniques)}</span>,
      },
      {
        key: "lastVisitAt",
        header: "最終訪問",
        width: "8rem",
        noWrap: true,
        cell: (l) => formatLastVisit(l.stats.lastVisitAt),
      },
      {
        key: "state",
        header: "状態",
        width: "7rem",
        cell: (l) => (
          <StateCell
            link={l}
            pending={toggle.isPending}
            onToggle={(next) => toggle.mutate({ id: l.id, active: next })}
          />
        ),
      },
    ],
    [toggle],
  );

  const issueForm = (
    <Card
      testId="fe2-lp-link-form"
      header={<span className={styles.sectionTitle}>流入URLを発行する</span>}
    >
      <Stack gap={5}>
        <span className={styles.note}>
          流入元ごとに名前を付けて URL を発行します。発行した URL を踏んだ人はそのまま北陸ITカンファレンスの
          LP に着き、どの流入元から来たかが下の一覧とログ管理タブに積み上がります。
        </span>
        <Form testId="fe2-lp-link-form-fields" onSubmit={submit}>
          <FormField
            label="名前（管理用）"
            htmlFor="fe2-lp-link-name"
            required
            help={`一覧に出る呼び名です（${LP_NAME_MAX}文字以内・例: Instagram 告知投稿）`}
            {...(errors.name ? { error: errors.name } : {})}
          >
            <TextField
              id="fe2-lp-link-name"
              testId="fe2-lp-link-name"
              value={name}
              placeholder="Instagram 告知投稿"
              onChange={(v) => {
                setName(v);
                setErrors(NO_DRAFT_ERRORS);
              }}
            />
          </FormField>
          <FormField
            label={`パラメータ値（${LP_TRACKING_PARAM}）`}
            htmlFor="fe2-lp-link-slug"
            required
            help={`URL に載る値です。半角英数字・ハイフン・アンダースコア、${LP_SLUG_MAX}文字以内。大文字は小文字に揃えます（Instagram と instagram が別集計に割れないように）`}
            {...(errors.slug ? { error: errors.slug } : {})}
          >
            <TextField
              id="fe2-lp-link-slug"
              testId="fe2-lp-link-slug"
              value={slugTouched ? slug : effectiveSlug}
              placeholder="instagram"
              onChange={(v) => {
                setSlugTouched(true);
                setSlug(v);
                setErrors(NO_DRAFT_ERRORS);
              }}
            />
          </FormField>
          <Stack gap={2}>
            <span className={styles.kpiLabel}>発行される URL</span>
            <code className={styles.urlText} data-testid="fe2-lp-link-preview">
              {preview}
            </code>
          </Stack>
          <div className={styles.formActions}>
            <Button type="submit" variant="primary" loading={create.isPending} testId="fe2-lp-link-submit">
              発行する
            </Button>
          </div>
        </Form>
      </Stack>
    </Card>
  );

  let list: JSX.Element;
  if (links.isLoading) {
    list = (
      <Card testId="fe2-lp-links-loading">
        <SkeletonLoader lines={6} />
      </Card>
    );
  } else if (links.isError) {
    list = (
      <ErrorState
        testId="fe2-lp-links-error"
        error={{ code: "INTERNAL", message: "発行済みの流入URLを読み込めませんでした。" }}
        onRetry={() => void links.refetch()}
      />
    );
  } else if ((links.data?.items ?? []).length === 0) {
    list = (
      <EmptyState
        testId="fe2-lp-links-empty"
        icon="megaphone"
        title="まだ流入URLがありません"
        description="上のフォームで最初の流入URLを発行してください。SNS やチラシごとに 1 本ずつ発行すると、どこから来たかが分かれて集計されます。"
      />
    );
  } else {
    list = (
      <Card testId="fe2-lp-links" header={<span className={styles.sectionTitle}>発行済みの流入URL</span>}>
        <Stack gap={5}>
          <DataTable<LpLinkSummary>
            testId="fe2-lp-links-table"
            columns={columns}
            rows={links.data?.items ?? []}
            rowKey={(l) => l.id}
            emptyState={<EmptyState title="この期間に該当する流入URLがありません" icon="megaphone" />}
          />
          <span className={styles.note}>
            訪問数は{rangeLabel(days)}の集計です（bot は除外）。発行直後は 0 件で、共有した URL が踏まれると増えます。
            停止しても過去の集計は消えません。
          </span>
        </Stack>
      </Card>
    );
  }

  return (
    <Stack gap={6} testId="fe2-lp-links-screen">
      <PageHeader
        testId="fe2-lp-links-header"
        title="LP管理"
        description="流入元ごとに計測つきの URL を発行します。発行した URL は北陸ITカンファレンスの LP に飛び、どの流入元から来たかを集計できます。"
      />
      <LpTabs active="links" />
      {issueForm}
      <SegmentedControl<string>
        testId="fe2-lp-links-range"
        aria-label="集計期間"
        caption="集計期間"
        value={String(days)}
        options={LP_RANGE_DAYS.map((d) => ({
          value: String(d),
          label: rangeLabel(d),
          testId: `fe2-lp-links-range-${d}`,
        }))}
        onChange={(v) => setDays(Number(v) as LpRangeDays)}
      />
      {list}
    </Stack>
  );
}
