// THE authorization surface of member-service. Every endpoint this Worker serves is listed
// here with what its caller must carry; `policyGate` (mounted first in app.ts) enforces it
// and nothing else in this service checks permissions or the internal marker. A route added
// to app.ts without a line here is denied at runtime and turns test/policy-table.test.ts red.
//
// This service hosts TWO apps of ロール管理, not one: 運営メンバー (`members` — teams + people,
// the 名簿) and 参加届 (`participation` — submissions + 反映確定). Each has its own 無効/閲覧/編集
// row, so a rule names the app the ROUTE belongs to and a 名簿編集者 is never silently escalated
// into 参加届 review (and vice versa). `appLevel` resolves the tier through APP_MANIFEST, so the
// table can never disagree with ロール管理 about what 閲覧/編集 means.
import { definePolicyTable, appLevel, AUTHENTICATED, INTERNAL } from "@dub/policy-gate";

export const POLICY_TABLE = definePolicyTable({
  // ---- liveness ----
  // INTERNAL, deliberately NOT PUBLIC. Its only caller is app-health-monitor, whose target
  // list probes "member-service" at `/health` over the SVC_MEMBER Service Binding and
  // attaches the full x-dub-* set — x-dub-internal included — on every probe
  // (app-health-monitor/src/{config.ts,checks.ts}). So INTERNAL costs the real caller
  // nothing. PUBLIC would also "work" today, because api-gateway binds only the `members`
  // segment to this Worker (api-gateway/src/routes.ts) and `/health` therefore has no
  // gateway route at all — but that is an accident of routing config, not a decision, and
  // `workers_dev = false` (wrangler.free.toml) is the other half of it. PUBLIC asserts "the
  // open internet may call this, intentionally", which is not true here, so the rule says
  // what we mean (see rule.ts's PUBLIC note: a liveness probe is INTERNAL).
  "GET /health": INTERNAL,

  // ---- service-to-service only (/members/internal/*) ----
  // These four replace the hand-rolled `app.use("/members/internal/*", ...)` marker guard.
  // Same door, now declared. api-gateway strips every inbound x-dub-* and never re-adds
  // x-dub-internal on an external forward, and `internalOnlyPaths: ["/members/internal/"]`
  // 404s the prefix at the edge as a second layer — so the marker really does mean "another
  // Worker called me over a binding".
  //
  // None of them demands a key, and that is the point of each: the two 参加届 routes carry no
  // permission-bearing actor at all (the public landing has no session; the self routes act
  // solely on the session's own linked roster row), and the chat fan-out reads the 名簿 on
  // behalf of a notification, not of the poster. internalWithKeys would be wrong for all
  // four — see the per-route notes.
  //
  // NOTE on the status code: the old guard answered 404 (`errors.notFound`) to hide the
  // routes' existence; the INTERNAL rule answers 403 `internal_only`. Reachability is
  // unchanged — the edge still 404s the prefix before this Worker is reached, so the 403 is
  // only ever observed by a caller that already holds a Service Binding.

  // 公開 参加届 landing. api-gateway's POST /api/v1/public/participation verifies Turnstile /
  // rate-limits the UNAUTHENTICATED submitter and forwards here as a genuine s2s call; the
  // handler attributes the row to the `system:public-participation` principal. There is no
  // acting user to attribute a key to, which is exactly why this is INTERNAL and not
  // internalWithKeys.
  "POST /members/internal/participation": INTERNAL,

  // チーム単位メンション (<!team:id>) の展開, chat-service -> member-service. Returns the
  // identity user ids of a team's linked people so chat can notify them. Deliberately key-free:
  // chat calls it to deliver a NOTIFICATION, not on the poster's roster authority, so demanding
  // identity:read of the poster would break @team mentions for ordinary members.
  "GET /members/internal/team-members": INTERNAL,

  // 名簿の Gmail 逆引き, drive-share-service -> member-service. カレンダー > ミーティングの招待先
  // (and the shared calendar ACL) are each member's 名簿 Gmail. Key-free like team-members: the
  // reconcile runs hourly as a system actor (no user), and the edge 404s /members/internal/.
  "POST /members/internal/google-emails": INTERNAL,

  // 公開オンボーディング案内. api-gateway's PUBLIC GET /api/v1/public/onboarding forwards here
  // for a visitor who has no account yet (that is the whole point of the page), so there is
  // no actor and no key to demand. Read-only, and the content is authored to be public.
  "GET /members/internal/onboarding": INTERNAL,

  // 公開 面談申し込みフォーム (人事アプリ). api-gateway の PUBLIC GET|POST /api/v1/public/hr-interview-form
  // が未ログインの応募者のために s2s で転送してくる (POST は gateway で囮フィールド・Turnstile・レート制限を
  // 通した後)。参加届の公開受付と同じく発信者が居ないので鍵は要求できず INTERNAL。GET が返すのは人事が公開
  // 前提で書いた質問だけ、POST の応答は accepted のみ (誰が応募済みかは返さない)。回答は
  // `system:public-hr-interview-form` に帰属し、応募者を 面談日程調整中 で作る (hr-form-service)。
  "GET /members/internal/hr/interview-form": INTERNAL,
  "POST /members/internal/hr/interview-form": INTERNAL,
  // 公開の面談日程選択。api-gateway の PUBLIC POST /api/v1/public/hr-interview-booking/* が s2s で転送する。
  // 誰の予約かはメールで渡したトークンでハンドラが判定する (hr-interview-service)。
  "POST /members/internal/hr/interview-booking/view": INTERNAL,
  "POST /members/internal/hr/interview-booking/book": INTERNAL,

  // Self 参加届 (アカウント設定 -> 参加情報), reached through api-gateway's GET|POST
  // /api/v1/me/participation, which authenticates the session and forwards the caller's
  // identity id alongside the marker. Self-scoped by construction: no target id is accepted
  // and the row is resolved through the caller's own identity link (resource-instance check,
  // kept in the handler — see service.getSelfParticipation / updateSelfParticipation).
  // INTERNAL does not guarantee an actor, so the handler still requires one (its 401 is the
  // `reqCtx` check, which gate.ts prescribes for INTERNAL routes that need an actor).
  "GET /members/internal/me/participation": INTERNAL,
  "POST /members/internal/me/participation": INTERNAL,
  // スポンサーのメール連携: mail-gateway が Dub のメールを送った / 受け取った時に呼ぶ (system origin・ユーザーなし)。
  // 営業先の日付とステータスを決まりどおりに進めるだけで、本文・件名は受け取らない。
  "POST /members/internal/sponsor/mail-activity": INTERNAL,

  // ---- 運営メンバー (名簿): reads = 閲覧 ----
  // The former gate was `requireAny(["identity:read", "app:members:view"])` (OR). There is no
  // OR form, and none is needed: every role holding `identity:read` also holds
  // `app:members:view`, so the two sets coincide in real data. Both halves of the grant path
  // say so — identity migration 0010_app_access_policy_backfill.sql:40-41 backfills
  // `app:members:view` onto every role carrying `identity:read`, and
  // identity-roster/src/seed.ts:31 (`{ id: "members", read: "identity:read", ... }`) derives
  // the same key for every role created or re-seeded since. A role holding only
  // `app:members:view` (the delegated 統括 role #526 enabled) passed the OR and passes this
  // rule too, so collapsing to the per-app tier loses nobody and makes ロール管理 authoritative.
  // See docs/policy-coverage-inventory.md b-6.
  //
  // overview は名簿の全項目を返すので 運営名簿 の範囲 (members:roster_view) を重ねる。組織図までの
  // ロールは org-overview を読む: 同じ形で個人情報の項目だけ落としたもの (service.getOrgOverview)。
  "GET /members/overview": appLevel("members", "view", "members:roster_view"),
  "GET /members/org-overview": appLevel("members", "view"),
  // The CANONICAL team list other apps (gantt 等) read for their own team switchers.
  "GET /members/teams": appLevel("members", "view"),
  // 名簿行の逆引き (identity user -> member row).
  "GET /members/people/by-identity/:identityUserId": appLevel("members", "view", "members:roster_view"),

  // ---- 運営メンバー (名簿): writes = 編集 ----
  // The app's 編集 tier is the WHOLE requirement — deliberately NOT "編集 AND identity:admin".
  // #526 made the per-app key the 正典 so 名簿管理 can be delegated to a 統括 role holding no
  // org-admin key; re-adding the domain key here would silently revoke that delegation. Roles
  // that could write via identity:admin alone got their `:edit` key from migration 0010
  // (lines 30-33), so nobody loses access.
  "POST /members/teams": appLevel("members", "edit"),
  "PATCH /members/teams/:id": appLevel("members", "edit"),
  "DELETE /members/teams/:id": appLevel("members", "edit"),
  "POST /members/people": appLevel("members", "edit"),
  // 本人の情報に触る書き込みは 運営名簿 の編集範囲を重ねる。組織図までの編集は /org (運営での項目だけを
  // 受け付け、個人情報を落として返す) と チーム・メンバーの追加削除まで。追加は書くだけで他人の情報を
  // 読まず、削除も内容を返さないので 運営メンバータブの編集として残す。
  "POST /members/people/:id/identity-link": appLevel("members", "edit", "members:roster_edit"),
  "POST /members/people/:id/profile-reminder": appLevel("members", "edit", "members:roster_edit"),
  "PATCH /members/people/:id": appLevel("members", "edit", "members:roster_edit"),
  "PATCH /members/people/:id/org": appLevel("members", "edit"),
  "DELETE /members/people/:id": appLevel("members", "edit"),

  // チーム・役職ロールの一括付与。全員のロール割当を書き換えるので、ロール管理と同じ
  // 「管理 編集 + identity:admin」(identity-roster の POST /identity/users/:id/roles と同格)。
  "POST /members/role-sync/backfill": appLevel("admin", "edit", "identity:admin"),

  // ---- 自分視点のチーム情報 (AUTHENTICATED) ----
  // Self-scoped and unnamed-subject: the response is the team list (id/key/name/color) plus
  // the CALLER's own teamIds, derived from their identity link — the route takes no target id,
  // so "may I read this about someone else?" cannot be asked. An ordinary chat member holds no
  // roster permission yet must still pick "@統括チーム" and read a received chip as a team name,
  // so a key here would break チームメンション for exactly the people who use it most. No other
  // 名簿 row is exposed (service.ts listMentionTeams).
  "GET /members/me/mention-teams": AUTHENTICATED,

  // ---- 参加届 (participation) ----
  // 自分の 届 を出す. 参加届 is `openToAllAuthenticated` in APP_MANIFEST, so 閲覧 is what every
  // role gets by default and the tier is the honest expression of "this app is on for me";
  // demanding 編集 would lock out every non-admin, who is precisely who files a 届. The old
  // gate was bare requireAuth, which left this route outside ロール管理 entirely — setting
  // 参加届 to 無効 now really does stop submissions. Who the 届 may be ABOUT is a
  // resource-instance matter and stays in the handler (氏名・メール突合 + dedupe).
  "POST /members/participation": appLevel("participation", "view"),
  // 全員分の 届 一覧 and the 突合候補 for one 届: both expose OTHER people's roster rows, so the
  // 参加届 tier alone is not enough — `identity:read` (the 名簿 domain read key, in 運営メンバー's
  // 詳細設定) is required on top, which is what the previous `requirePermission("identity:read")`
  // demanded. The addition here is the tier, not the key.
  "GET /members/participation": appLevel("participation", "view", "identity:read"),
  "GET /members/participation/:id/candidates": appLevel("participation", "view", "identity:read"),
  // 反映確定 (link/create/skip) — rewrites the 名簿, so 編集 on 参加届. Same #526 reasoning as the
  // 名簿 writes above: the tier is the whole requirement, NOT "編集 AND identity:admin"
  // (docs/policy-coverage-inventory.md 2.4 proposes the latter; see the commit body for why
  // adding the domain key would revoke a delegation the code deliberately granted). Holding
  // 編集 on 運営メンバー does not reach this route — a different app's row.
  "POST /members/participation/:id/resolve": appLevel("participation", "edit"),

  // ---- オンボーディング案内 (参加届アプリの管理タブ) ----
  // 新メンバー向けの案内は参加届と同じ「入ってくる人の受け入れ」なので、参加届アプリの行で
  // 出し分ける。読むのは 閲覧（中身は公開ページと同じで、他人の名簿行を含まない）、
  // 項目の追加・編集・削除・並び替えは公開ページを書き換えるので 編集。
  "GET /members/onboarding": appLevel("participation", "view"),
  "POST /members/onboarding": appLevel("participation", "edit"),
  "POST /members/onboarding/reorder": appLevel("participation", "edit"),
  "PATCH /members/onboarding/:id": appLevel("participation", "edit"),
  "DELETE /members/onboarding/:id": appLevel("participation", "edit"),
  "PUT /members/onboarding/meetings": appLevel("participation", "edit"),
  // ---- 人事 (人事アプリ: 面談 → 採用 → オンボーディング) ----
  // 人事アプリ自身の 無効/閲覧/編集 行で出し分ける (運営メンバー・参加届の行とは独立)。応募者は
  // 個人情報なので、閲覧にも人事の詳細権限 hr:read を重ねる (参加届一覧が identity:read を重ねるのと同じ)。
  // ステータス変更・面談日・メモ・チェックは 編集 + hr:write、名簿に行を足す採用 (join) と削除は 編集 + hr:admin。
  // 名簿 (member_people) を直接書く唯一のルートは join で、どの行に結ぶかはハンドラが判定する。
  "GET /members/hr/applicants": appLevel("hr", "view", "hr:read"),
  "GET /members/hr/applicants/:id": appLevel("hr", "view", "hr:read"),
  "POST /members/hr/applicants": appLevel("hr", "edit", "hr:write"),
  "PATCH /members/hr/applicants/:id": appLevel("hr", "edit", "hr:write"),
  "POST /members/hr/applicants/:id/stage": appLevel("hr", "edit", "hr:write"),
  "POST /members/hr/applicants/:id/notes": appLevel("hr", "edit", "hr:write"),
  "POST /members/hr/applicants/:id/join": appLevel("hr", "edit", "hr:admin"),
  "DELETE /members/hr/applicants/:id": appLevel("hr", "edit", "hr:admin"),
  // 面談申し込みフォーム: 定義と回答一覧は応募者の個人情報と同格なので 閲覧 + hr:read。定義の編集 (公開ページを
  // 書き換える) と代理入力 (応募者を作る = POST /applicants と同じ) は 編集 + hr:write。
  "GET /members/hr/interview-form": appLevel("hr", "view", "hr:read"),
  "PUT /members/hr/interview-form": appLevel("hr", "edit", "hr:write"),
  "GET /members/hr/interview-form/responses": appLevel("hr", "view", "hr:read"),
  "POST /members/hr/interview-form/responses": appLevel("hr", "edit", "hr:write"),
  // 面談の日程調整: 枠・招待の一覧は応募者の個人情報と同格なので 閲覧 + hr:read。枠・設定の編集とメール送信は 編集 + hr:write。
  "GET /members/hr/interviews": appLevel("hr", "view", "hr:read"),
  "PUT /members/hr/interviews/settings": appLevel("hr", "edit", "hr:write"),
  "POST /members/hr/interviews/slots": appLevel("hr", "edit", "hr:write"),
  "POST /members/hr/interviews/slots/delete": appLevel("hr", "edit", "hr:write"),
  "DELETE /members/hr/interviews/slots/:id": appLevel("hr", "edit", "hr:write"),
  "POST /members/hr/interviews/slots/:id/release": appLevel("hr", "edit", "hr:write"),
  "POST /members/hr/interviews/invites/:id/send": appLevel("hr", "edit", "hr:write"),
  "GET /members/hr/onboarding": appLevel("hr", "view", "hr:read"),
  "PUT /members/hr/onboarding/:memberId/items/:itemId": appLevel("hr", "edit", "hr:write"),
  // ---- スポンサー (スポンサーアプリ: 名刺の共有) ----
  // スポンサーアプリ自身の 無効/閲覧/編集 行で出し分ける。名刺は社外の個人の連絡先なので、閲覧 (写真を含む)
  // にも詳細権限 sponsor:read を重ねる。登録・編集・写真の撮り直しは 編集 + sponsor:write、削除は 編集 + sponsor:admin。
  "GET /members/sponsor/cards": appLevel("sponsor", "view", "sponsor:read"),
  "GET /members/sponsor/cards/:id": appLevel("sponsor", "view", "sponsor:read"),
  "GET /members/sponsor/cards/:id/image": appLevel("sponsor", "view", "sponsor:read"),
  "POST /members/sponsor/cards": appLevel("sponsor", "edit", "sponsor:write"),
  "PATCH /members/sponsor/cards/:id": appLevel("sponsor", "edit", "sponsor:write"),
  "PUT /members/sponsor/cards/:id/image": appLevel("sponsor", "edit", "sponsor:write"),
  "DELETE /members/sponsor/cards/:id": appLevel("sponsor", "edit", "sponsor:admin"),
  // 営業進捗も名刺と同じ段階 (閲覧 = read・登録/編集/取り込み = write・削除 = admin)。
  "GET /members/sponsor/leads": appLevel("sponsor", "view", "sponsor:read"),
  "GET /members/sponsor/leads/:id": appLevel("sponsor", "view", "sponsor:read"),
  "POST /members/sponsor/leads": appLevel("sponsor", "edit", "sponsor:write"),
  "POST /members/sponsor/leads/import": appLevel("sponsor", "edit", "sponsor:write"),
  "PATCH /members/sponsor/leads/:id": appLevel("sponsor", "edit", "sponsor:write"),
  "DELETE /members/sponsor/leads/:id": appLevel("sponsor", "edit", "sponsor:admin"),
  "GET /members/sponsor/goals": appLevel("sponsor", "view", "sponsor:read"),
  // メール連携: メールの相手を担当者メールに登録 (= 営業先の編集) と自動更新の履歴は営業進捗と同じ段階。
  // 既存メールからの一括補完は全社の日付を書き換えうるので削除と同じ sponsor:admin。
  "POST /members/sponsor/leads/:id/contact-emails": appLevel("sponsor", "edit", "sponsor:write"),
  "GET /members/sponsor/leads/:id/activity": appLevel("sponsor", "view", "sponsor:read"),
  "POST /members/sponsor/leads/mail-backfill": appLevel("sponsor", "edit", "sponsor:admin"),

  // 目標管理。閲覧 + goals:read で全チームの進捗 (件数だけで個人情報は含まない) を読める。編集は 編集 のみ。
  "GET /members/goals": appLevel("goals", "view", "goals:read"),
  "PUT /members/goals/:teamId/:month": appLevel("goals", "edit"),
  "DELETE /members/goals/:teamId/:month": appLevel("goals", "edit"),
});
