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

Local secrets template lives at `~/DubVault/secrets/hackit-drive-oauth.json` (git-ignored,
machine-local only). Values are never logged.
