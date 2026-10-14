# drive-share-service

GUI-driven **Google Drive sharing (permissions) manager** for the Hackit shared Gmail
(`hackit@gmail.com`). The fe2 SPA feature `driveshare` calls this service through the
api-gateway (`/api/v1/driveshare/*`, binding `SVC_DRIVE_SHARE`); the service manages
Drive **permissions** (who can view / comment / edit, plus link sharing) via Drive API
v3 `permissions.list/create/update/delete` and `files.list`.

- **$0**: owns no D1, no Queues, no KV. Google Drive holds the files/permissions;
  identity-roster is the only dependency (authz). Access token is cached in-isolate.
- **Auth seam (mock → real)**: a personal Gmail cannot use a service account /
  domain-wide delegation, so the grant is a one-time-consented **refresh token**. The
  composition root (`src/index.ts`) wires the **real** Drive client only when the three
  `GOOGLE_HACKIT_OAUTH_*` secrets are bound; otherwise (or with `DRIVESHARE_MOCK=1`) an
  in-memory **mock** client runs, so the whole surface builds/deploys/E2Es before any
  real token exists. Dropping in the real token is one branch — no other code changes.

## Routes (internal; gateway strips `/api/v1`)

| Method | Path | Perm | Purpose |
|---|---|---|---|
| GET | `/driveshare/files` | `drive:read` | list files/folders (`q`, `folderId`, `cursor`, `limit`) |
| GET | `/driveshare/files/:id/permissions` | `drive:read` | list a file's sharing entries |
| POST | `/driveshare/files/:id/permissions` | `drive:write` | grant a role to an email |
| PATCH | `/driveshare/files/:id/permissions/:permId` | `drive:write` | change a role |
| DELETE | `/driveshare/files/:id/permissions/:permId` | `drive:write` | revoke |
| PUT | `/driveshare/files/:id/link` | `drive:write` | link sharing on/off (`anyone`) |

`drive:read` / `drive:write` are not yet in the frozen `PERMISSION_CATALOG` (same as
drive-proxy); they are opaque wire strings passed to identity `/authz/check`. Roles must
grant these keys for real (non-mock) use — see below.

## Getting the real Hackit refresh token (one-time, done by the operator)

1. Google Cloud Console → create/pick a project (any account can own it).
2. **APIs & Services → Enable APIs → Google Drive API** (free).
3. **OAuth consent screen**: External, add `hackit@gmail.com` as a **Test user**
   (keeps it in testing mode — no verification needed for a refresh token).
4. **Credentials → Create OAuth client ID → Desktop app**. Note the **Client ID** and
   **Client secret**.
5. Get a refresh token consented **as `hackit@gmail.com`** with scope
   `https://www.googleapis.com/auth/drive` — e.g. via the OAuth Playground
   (gear → *Use your own OAuth credentials* → paste client id/secret → authorize the
   Drive scope while logged in as hackit@ → *Exchange authorization code for tokens*),
   or a one-off local `code` → token exchange against
   `https://oauth2.googleapis.com/token`. Copy the `refresh_token`.
6. Set the three secrets (never commit them):

   ```
   npx wrangler secret put GOOGLE_HACKIT_OAUTH_CLIENT_ID     --config services/drive-share-service/wrangler.free.toml
   npx wrangler secret put GOOGLE_HACKIT_OAUTH_CLIENT_SECRET --config services/drive-share-service/wrangler.free.toml
   npx wrangler secret put GOOGLE_HACKIT_OAUTH_REFRESH_TOKEN --config services/drive-share-service/wrangler.free.toml
   ```

7. Grant `drive:read` / `drive:write` to the operator roles in identity-roster (until the
   permission catalog adds them, they resolve as plain strings).

## Switching the account from ロール管理 (no `wrangler secret put`)

ロール管理 → 「その他」の表 → 「Google アカウント」 lets a system admin (`identity:admin` +
Drive共有 編集) register several Google accounts and switch which one Drive is accessed as.
The selected account (D1 `driveshare_google_accounts` + `driveshare_google_active_account`,
refresh tokens AES-GCM sealed) takes precedence over `GOOGLE_HACKIT_OAUTH_REFRESH_TOKEN`; the
secret's account is listed as 「サーバーの初期設定」 and can be switched back to. With nothing
selected the secret is used as before.

| Method | Path | Purpose |
|---|---|---|
| GET | `/driveshare/google-account` | `{ accounts[], canConnect }`: each with in use (`active`), registered at/by, `needsReconnect` (invalid_grant) |
| POST | `/driveshare/google-account/connect` | `{ redirectUri }` -> Google consent URL (state stored in D1, 10 min, single use) |
| POST | `/driveshare/google-account/callback` | `{ code, state }` relayed by the SPA from `/driveshare?code&state`; registers (same address = token replaced) and switches to it |
| POST | `/driveshare/google-account/active` | `{ accountId }` (or `"secret"`) switches the account in use |
| DELETE | `/driveshare/google-account/accounts/:id` | removes a registered account (409 while in use) |

One-time setup per environment:

1. Apply `infra/d1/migrations/driveshare/0002_google_account.sql` to the environment's D1.
2. GCP → Credentials → **Create OAuth client ID → Web application**. Authorized redirect URI =
   `<fe2 origin>/driveshare` (one per environment, e.g. staging and prod fe2 origins).
3. OAuth consent screen → add the new Google account as a **Test user**. In testing mode
   Google expires refresh tokens after **7 days** (the dialog then marks it 要再接続);
   publishing the app to production removes that limit.
4. Secrets: `GOOGLE_HACKIT_OAUTH_WEB_CLIENT_ID`, `GOOGLE_HACKIT_OAUTH_WEB_CLIENT_SECRET`,
   `DRIVESHARE_TOKEN_ENC_KEY` (`openssl rand -base64 32`). The connect flow needs the Web
   client; the Desktop client cannot redirect to https.

If the stored token can no longer be used (key rotated, Web client secret removed) Drive
fails closed with "reconnect required" and the dialog says so — it never silently switches
to the secret's account. Only a missing `driveshare_google_*` table (migration not
applied) falls back to the secret.

Switching accounts does **not** move ownership of existing files.

Local secrets template lives at `~/DubVault/secrets/hackit-drive-oauth.json` (git-ignored,
machine-local only). Values are never logged.

## カレンダー > ミーティング (`/meetings`)

Meetings (定例 / 単発) are created **on the shared Google account selected in Drive共有 > 設定**,
with a Google Meet link, and the target's members are invited automatically. Contract:
`packages/types/src/meeting.ts`. Gateway segment `/meetings` → this Worker.

| Route | Permission |
|---|---|
| `GET /meetings`, `GET /meetings/targets` | カレンダー 閲覧 + `calendar:meetings_view` |
| `POST /meetings`, `PATCH /meetings/:id`, `DELETE /meetings/:id`, `POST /meetings/sync` | カレンダー 編集 + `calendar:meetings_edit` |

Both keys are toggles in ロール管理 > カレンダー > 細かい権限; migration `identity/0019` gives them
to the system admin role only.

- **Targets**: each role, plus `all` (全体 = every active member). Each target owns ONE secondary
  calendar on the shared account (named after the role / 全体), created on the first meeting.
  Switching the shared account creates new calendars on the new account; meetings made on the
  old account can only be deleted (Dub row only) — recreate them.
- **Invite address**: the member's 名簿 Gmail (member-service `POST /members/internal/google-emails`,
  binding `SVC_MEMBER`), else their Dub login address. Without the binding everyone gets the
  Dub address. Members without a Gmail are reported in `POST /meetings/sync` → `withoutGoogleAccount`.
- **Calendar sharing**: every target calendar is shared read-only (ACL `reader`) with every
  active member; Google mails them an "add this calendar" link so they can show it in their own
  list. Attendees see their own meetings on their main calendar regardless.
- **Recurrence**: RRULE in `Asia/Tokyo` — weekly / biweekly / monthly_weekday (第N X曜日 of the
  first occurrence; a 5th weekday means the last one, `-1`), optional `until` (inclusive JST date).
- **Automatic follow**: `MeetingSyncDO` (SQLite Durable Object **alarm**, no cron slot) runs the
  same reconcile as `POST /meetings/sync` hourly and ~1 minute after every meeting write. It adds
  new role members, removes ONLY attendees / calendar shares that Dub added (ledgers
  `driveshare_meeting_invites` / `driveshare_meeting_calendar_acl`) — guests and shares added by
  hand in Google Calendar are never touched — and patches an event (`sendUpdates=all`) only when
  its attendee list changed. Google calls run against a per-invocation budget; a run cut short
  continues 2 minutes later.
- **Mock**: when Drive is mocked (`DRIVESHARE_MOCK=1` or no account / secret), an in-memory
  calendar is used too (per isolate).

### Setup (once per environment)

1. Apply D1 migrations `driveshare/0003_meetings.sql` and `identity/0019_calendar_meetings_perms.sql`
   (staging/prod migrations are applied by hand).
2. Enable the **Google Calendar API** in the GCP project that owns the OAuth client
   (APIs & Services > Library > Google Calendar API), and add the scope
   `https://www.googleapis.com/auth/calendar` to the OAuth consent screen.
3. The connect flow now asks for `drive` + `calendar`. An account connected before this lacks
   calendar access: `GET /meetings` returns `account.calendarReady=false` and every write answers
   409 「Google アカウントにカレンダーの権限がありません。…」. Fix: Drive共有 > 設定 → 「再接続」 the
   same account (detected from the `scope` Google returns on token refresh). The
   `GOOGLE_HACKIT_OAUTH_REFRESH_TOKEN` secret fallback must likewise be re-minted with both scopes.
4. Deploy order: member-service before drive-share-service (it binds `SVC_MEMBER`). The first
   deploy creates the `MeetingSyncDO` class (`[[migrations]] tag = "v1"`); the alarm starts on the
   first meeting write or `POST /meetings/sync`.
