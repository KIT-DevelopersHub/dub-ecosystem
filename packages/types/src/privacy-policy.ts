// プライバシーポリシー（北陸ITカンファレンス 公式サイト）。本文は会計アプリで編集し（member-service
// /members/accounting/privacy-policy）、LP Worker が /privacy に描く（lp-markdown の安全な描画）。
// LP Worker（workerd・`node --test` の strip-only TS）からも読むので import なしの純粋な定数と関数だけにする。

/** 本文の上限（文字数）。描画もこの長さまで。 */
export const PRIVACY_POLICY_MAX = 20_000;

/** 会計アプリでまだ保存していない時に LP に出す本文（Markdown）。 */
export const DEFAULT_PRIVACY_POLICY = `北陸ITカンファレンス（以下「本イベント」）を運営する一般社団法人 Developers Hub（以下「当団体」）は、本イベントの公式サイト（https://hokuriku-it-conf.com 以下「本サイト」）での個人情報と利用者情報の取り扱いを次のとおり定めます。

## 1. 取得する情報

- **チケットのお申し込み**: 氏名、メールアドレス、お申し込みフォームでご回答いただいた項目、領収書の宛名（ご入力いただいた場合）、お申し込みの内容（券種・枚数・金額）
- **登壇のご応募**: 応募フォームでご入力いただいた項目
- **スポンサー資料のご請求**: フォームでご入力いただいた会社名・お名前・メールアドレスなど
- **お問い合わせ**: メールでいただいたお名前・メールアドレス・お問い合わせの内容
- **閲覧時の情報**: 「5. アクセス解析と外部送信」に書いた情報

クレジットカード番号などの決済情報は決済代行会社（Stripe）が直接受け取り、当団体は保持しません。

## 2. 利用目的

- チケットの販売・発券・当日の受付、領収書の発行、お申し込みに関するご連絡
- 登壇者の選考とご連絡、スポンサー資料のご送付とご連絡
- お問い合わせへの回答
- 本イベントの運営、本サイトの改善、告知の効果の確認
- 法令に基づく対応

## 3. 第三者への提供

法令に基づく場合を除き、ご本人の同意なく個人情報を第三者に提供しません。

## 4. 取り扱いの委託

利用目的の範囲で、個人情報の取り扱いを次の事業者に委託します。委託先は適切に管理します。

- Stripe, Inc.（チケットの決済）
- Cloudflare, Inc.（本サイトの配信とデータの保管）
- Resend（お申し込み確認などのメールの送信）

## 5. アクセス解析と外部送信

本サイトの改善と告知の効果の確認のため、閲覧時に次の情報を当団体のサーバー（Cloudflare, Inc. のサービスを利用）へ送信し、日ごとの件数として集計します。

- 閲覧したページ、表示していた時間、スクロールの深さ、表示されたセクション、押したリンクの種類
- リンク元のサイト名、URL に付いた告知の識別子（utm_source / utm_medium / utm_campaign）
- 端末の種類・OS・ブラウザの系統、アクセス元の国と都道府県（IP アドレスから推定します。IP アドレス自体は保存しません）
- ページの表示速度（Core Web Vitals）
- チケットのお申し込みページまで進んだか・お申し込みが完了したか（お申し込みの内容・氏名・メールアドレスとは結び付けません）

cookie と、端末に長く残る識別子は使いません。同じ閲覧の中でページ数を数えるために、閲覧中のタブの中だけで有効な一時的な記録（sessionStorage）を使いますが、その識別子は送信しません。保存するのは日ごとの件数で、個人を特定できる形では保存しません。広告のための利用や第三者への提供はしません。

ブラウザの「トラッキング拒否（Do Not Track）」または「Global Privacy Control」を有効にしている場合、上記のアクセス解析の情報は送信しません。

このほか、本サイトの表示のために次の外部サービスへ閲覧時の情報が送信されます。

- Cloudflare Web Analytics（Cloudflare, Inc.）: 閲覧数の集計のため。閲覧したページ、リンク元、ブラウザの情報など
- Google Fonts（Google LLC）: 文字を表示するため。IP アドレス、ブラウザの情報など

## 6. 安全管理

個人情報への不正なアクセス・紛失・漏えいを防ぐため、扱える担当者を限り、通信を暗号化するなど、必要な安全管理の措置をとります。

## 7. 開示・訂正・削除などのご請求

ご本人から個人情報の開示・訂正・利用停止・削除などのご請求があった場合は、ご本人であることを確認したうえで、法令に従って対応します。下の窓口までご連絡ください。

## 8. お問い合わせ窓口

一般社団法人 Developers Hub　北陸ITカンファレンス 事務局
メール: info@developershub.jp

## 9. 改定

このポリシーは必要に応じて改定します。改定した内容は本サイトに載せた時から適用します。
`;

export type PrivacyPolicyBodyError = "required" | "too_long" | "invalid";

// 改行とタブ以外の制御文字は入れない（本文は Markdown として描くので、それ以外の文字はエスケープして出る）。
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]/;

/** 入力の検査と正規化（改行を LF に・末尾の空白を落とす）。画面とサーバが同じ結果を出す。 */
export function parsePrivacyPolicyBody(raw: unknown): { ok: true; value: string } | { ok: false; reason: PrivacyPolicyBodyError } {
  if (typeof raw !== "string") return { ok: false, reason: raw === undefined || raw === null ? "required" : "invalid" };
  const s = raw.replace(/\r\n?/g, "\n").replace(/\s+$/, "");
  if (!s.trim()) return { ok: false, reason: "required" };
  if (s.length > PRIVACY_POLICY_MAX) return { ok: false, reason: "too_long" };
  if (CONTROL.test(s)) return { ok: false, reason: "invalid" };
  return { ok: true, value: s };
}

/** エラーの文言（画面用）。 */
export function privacyPolicyErrorMessage(reason: PrivacyPolicyBodyError): string {
  switch (reason) {
    case "required":
      return "本文を入力してください";
    case "too_long":
      return `${PRIVACY_POLICY_MAX.toLocaleString("ja-JP")} 文字以内にしてください`;
    case "invalid":
      return "使えない文字が含まれています";
  }
}

/** 「最終更新日」の表示（日本時間の日付）。例: 2026年11月27日。 */
export function formatPolicyDate(iso: string): string | null {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const d = new Date(t + 9 * 3600_000);
  return `${d.getUTCFullYear()}年${d.getUTCMonth() + 1}月${d.getUTCDate()}日`;
}
