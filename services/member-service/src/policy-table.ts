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

  // Self 参加届 (アカウント設定 -> 参加情報), reached through api-gateway's GET|POST
  // /api/v1/me/participation, which authenticates the session and forwards the caller's
  // identity id alongside the marker. Self-scoped by construction: no target id is accepted
  // and the row is resolved through the caller's own identity link (resource-instance check,
  // kept in the handler — see service.getSelfParticipation / updateSelfParticipation).
  // INTERNAL does not guarantee an actor, so the handler still requires one (its 401 is the
  // `reqCtx` check, which gate.ts prescribes for INTERNAL routes that need an actor).
  "GET /members/internal/me/participation": INTERNAL,
  "POST /members/internal/me/participation": INTERNAL,

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
  "GET /members/overview": appLevel("members", "view"),
  // The CANONICAL team list other apps (gantt 等) read for their own team switchers.
  "GET /members/teams": appLevel("members", "view"),
  // 名簿行の逆引き (identity user -> member row).
  "GET /members/people/by-identity/:identityUserId": appLevel("members", "view"),

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
  "POST /members/people/:id/identity-link": appLevel("members", "edit"),
  "PATCH /members/people/:id": appLevel("members", "edit"),
  "DELETE /members/people/:id": appLevel("members", "edit"),

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
});
