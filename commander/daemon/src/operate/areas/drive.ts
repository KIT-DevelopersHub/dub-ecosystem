// ドライブ共有: sharing (drive-share-service), the shared drive itself (drive-proxy) and the
// file ledger (file-meta). All drive-share / drive-proxy calls go to Google Drive live.
import type { AreaSpec } from "../catalog-types.ts";
import { read } from "./helpers.ts";

const SHARE = "drive-share-service";
const PROXY = "drive-proxy";
const META = "file-meta";
const DRIVE_VIEW = { keys: ["drive:read"], appLevel: { app: "driveshare", level: "view" } } as const;
const FILE_VIEW = { keys: ["file:read"], appLevel: { app: "driveshare", level: "view" } } as const;
const OUT = "依頼範囲外（ドライブは共有権限と移動だけを開放する）";

export const DRIVE: AreaSpec = {
  area: "drive",
  entries: [
    read({
      id: "driveshare.files.list",
      area: "drive",
      path: "/driveshare/files",
      service: SHARE,
      requires: DRIVE_VIEW,
      description: "共有ドライブのファイル一覧を取得する",
      hint: "files[].id・name・isFolder・ownerName・linkShared。folderId でフォルダ内、q で名前検索",
      query: ["folderId", "q", "limit", "cursor"],
    }),
    read({
      id: "driveshare.permissions.list",
      area: "drive",
      path: "/driveshare/files/:id/permissions",
      service: SHARE,
      requires: DRIVE_VIEW,
      description: "ファイル1件の共有相手と権限を取得する",
      hint: "permissions[].id・type・role(reader|commenter|writer|owner)・emailAddress・inherited",
    }),
    read({
      id: "driveshare.roleGrants.list",
      area: "drive",
      path: "/driveshare/role-grants",
      service: SHARE,
      requires: DRIVE_VIEW,
      description: "ロール単位の共有設定をすべて取得する",
      hint: "items[].fileId・roleId・roleName・driveRole・memberCount",
    }),
    read({
      id: "driveshare.fileRoleGrants.list",
      area: "drive",
      path: "/driveshare/files/:id/role-grants",
      service: SHARE,
      requires: DRIVE_VIEW,
      description: "ファイル1件のロール単位の共有設定を取得する",
      hint: "items[].roleId・roleName・driveRole",
    }),
    read({
      id: "drive.files.list",
      area: "drive",
      path: "/drive/files",
      service: PROXY,
      requires: DRIVE_VIEW,
      description: "フォルダ内の書類一覧を取得する",
      hint: "query.folderId 必須。items[].id・name・mimeType・modifiedAt",
      query: ["folderId", "kind", "q", "limit", "cursor"],
    }),
    read({
      id: "drive.files.get",
      area: "drive",
      path: "/drive/files/:id",
      service: PROXY,
      requires: DRIVE_VIEW,
      description: "書類1件の情報を取得する",
      hint: "id・name・mimeType・modifiedAt のみ（親フォルダは返らない）",
    }),
    read({
      id: "drive.files.embed",
      area: "drive",
      path: "/drive/files/:id/embed",
      service: PROXY,
      requires: DRIVE_VIEW,
      description: "書類の埋め込み用 URL を取得する",
      hint: "{ embedUrl }。フォルダは400",
    }),
    read({
      id: "drive.sheets.values",
      area: "drive",
      path: "/drive/sheets/:id/values",
      service: PROXY,
      requires: DRIVE_VIEW,
      description: "スプレッドシートのセルの値を取得する",
      hint: "query.range 必須（A1 形式 例 Sheet1!A1:D20）。{ values: string[][] }",
      query: ["range"],
    }),
    read({
      id: "files.search",
      area: "drive",
      path: "/files/search",
      service: META,
      requires: FILE_VIEW,
      description: "ファイル台帳を名前などで検索する",
      hint: "items[].id・name・mimeType・ownerId・driveFileId",
      query: ["q", "mimeType", "ownerId", "limit", "cursor"],
    }),
    read({
      id: "files.meta.get",
      area: "drive",
      path: "/files/meta/:id",
      service: META,
      requires: FILE_VIEW,
      description: "ファイル台帳の1件と紐づき先（タスク・イベント等）を取得する",
      hint: "query.include=links で links[].targetType・targetId",
      query: ["include"],
    }),
  ],
  excluded: [
    { service: PROXY, route: "POST /drive/files/:id/trash", reason: "ゴミ箱から戻す API が無い（不可逆）" },
    { service: PROXY, route: "POST /drive/files", reason: OUT },
    { service: PROXY, route: "POST /drive/sheets/:id/values", reason: OUT },
    { service: META, route: "GET /files/:id/download", reason: "ファイル本体（バイナリ）で、計画の読み取りに使えない" },
    { service: META, route: "POST /files", reason: OUT },
    { service: META, route: "POST /files/meta", reason: OUT },
    { service: META, route: "PATCH /files/meta/:id", reason: OUT },
    { service: META, route: "DELETE /files/meta/:id", reason: OUT },
    { service: META, route: "POST /files/meta/:id/links", reason: OUT },
    { service: META, route: "DELETE /files/meta/:id/links", reason: OUT },
  ],
  pending: [
    { service: SHARE, route: "POST /driveshare/files/:id/permissions" },
    { service: SHARE, route: "PATCH /driveshare/files/:id/permissions/:permId" },
    { service: SHARE, route: "DELETE /driveshare/files/:id/permissions/:permId" },
    { service: SHARE, route: "POST /driveshare/files/:id/role-grants" },
    { service: SHARE, route: "DELETE /driveshare/files/:id/role-grants/:roleId" },
    { service: SHARE, route: "POST /driveshare/files/:id/role-grants/:roleId/reapply" },
    { service: SHARE, route: "PUT /driveshare/files/:id/link" },
    { service: PROXY, route: "POST /drive/files/:id/move" },
  ],
};
