// In-memory MOCK Drive client. Selected by index.ts whenever the Hackit OAuth
// secrets are not bound (or DRIVESHARE_MOCK=1), so the whole service builds, runs,
// and is E2E-testable at $0 before a real refresh token exists. It mirrors the REAL
// client's observable behaviour: folder-first ordering, name-substring filter,
// link-share hint on files, idempotent delete. Swapping to the real client changes
// nothing the SPA can observe except the data source.
import { errors } from "@dub/errors";
import type {
  CreatePermissionParams,
  DriveShareClient,
  ListFilesParams,
} from "./drive-client";
import { DRIVE_FOLDER_MIME } from "./drive-client";
import type { ListFilesResult, ListPermissionsResult, SharePermission } from "./types";

interface MockFile {
  id: string;
  name: string;
  mimeType: string;
  ownerName: string;
  modifiedTime: string;
  webViewLink: string;
  permissions: SharePermission[];
}

function seedFiles(): MockFile[] {
  const owner = "Hackit 運営";
  const link = (id: string) => `https://drive.google.com/file/d/${id}/view`;
  const mk = (
    id: string,
    name: string,
    mimeType: string,
    modifiedTime: string,
    permissions: SharePermission[],
  ): MockFile => ({ id, name, mimeType, ownerName: owner, modifiedTime, webViewLink: link(id), permissions });

  const ownerPerm: SharePermission = {
    id: "perm_owner",
    type: "user",
    role: "owner",
    emailAddress: "hackit@gmail.com",
    displayName: "Hackit 運営",
    domain: null,
  };
  return [
    mk("fld_root", "Hackit 2026 共有", DRIVE_FOLDER_MIME, "2026-08-10T09:00:00Z", [
      { ...ownerPerm, id: "perm_1" },
      { id: "perm_2", type: "user", role: "writer", emailAddress: "staff-a@example.com", displayName: "スタッフA", domain: null },
    ]),
    mk("fld_designs", "デザイン素材", DRIVE_FOLDER_MIME, "2026-08-11T02:30:00Z", [{ ...ownerPerm, id: "perm_3" }]),
    mk("fil_budget", "予算管理.xlsx", "application/vnd.google-apps.spreadsheet", "2026-08-11T23:10:00Z", [
      { ...ownerPerm, id: "perm_4" },
      { id: "perm_5", type: "user", role: "reader", emailAddress: "sponsor@example.com", displayName: "協賛担当", domain: null },
    ]),
    mk("fil_flyer", "当日チラシ.pdf", "application/pdf", "2026-08-12T01:00:00Z", [
      { ...ownerPerm, id: "perm_6" },
      { id: "perm_anyone_flyer", type: "anyone", role: "reader", emailAddress: null, displayName: null, domain: null },
    ]),
    mk("fil_runsheet", "進行台本.gdoc", "application/vnd.google-apps.document", "2026-08-12T03:45:00Z", [
      { ...ownerPerm, id: "perm_7" },
      { id: "perm_8", type: "user", role: "commenter", emailAddress: "mc@example.com", displayName: "司会", domain: null },
    ]),
  ];
}

export function createMockDriveShareClient(): DriveShareClient {
  const files = seedFiles();
  const byId = new Map(files.map((f) => [f.id, f]));
  let seq = 100;
  const nextId = () => `perm_mock_${seq++}`;

  function require(fileId: string): MockFile {
    const f = byId.get(fileId);
    if (!f) throw errors.notFound("driveResource", fileId);
    return f;
  }

  return {
    async listFiles(p: ListFilesParams): Promise<ListFilesResult> {
      const needle = p.q?.trim().toLowerCase();
      const matched = files
        .filter((f) => (needle ? f.name.toLowerCase().includes(needle) : true))
        .slice()
        // folder-first, then name (mirrors Drive orderBy=folder,name)
        .sort((a, b) => {
          const af = a.mimeType === DRIVE_FOLDER_MIME ? 0 : 1;
          const bf = b.mimeType === DRIVE_FOLDER_MIME ? 0 : 1;
          return af !== bf ? af - bf : a.name.localeCompare(b.name, "ja");
        });
      return {
        files: matched.map((f) => ({
          id: f.id,
          name: f.name,
          mimeType: f.mimeType,
          isFolder: f.mimeType === DRIVE_FOLDER_MIME,
          ownerName: f.ownerName,
          modifiedTime: f.modifiedTime,
          webViewLink: f.webViewLink,
          linkShared: f.permissions.some((perm) => perm.type === "anyone"),
        })),
        nextCursor: null,
      };
    },

    async listPermissions(fileId: string): Promise<ListPermissionsResult> {
      const f = require(fileId);
      return { fileId, permissions: f.permissions.map((perm) => ({ ...perm })) };
    },

    async createPermission(fileId: string, p: CreatePermissionParams): Promise<SharePermission> {
      const f = require(fileId);
      if (p.type === "anyone") {
        const existing = f.permissions.find((perm) => perm.type === "anyone");
        if (existing) {
          existing.role = p.role;
          return { ...existing };
        }
      } else if (p.emailAddress) {
        const dup = f.permissions.find((perm) => perm.type === p.type && perm.emailAddress === p.emailAddress);
        if (dup) throw errors.conflict("この宛先には既に権限が付与されています", { emailAddress: p.emailAddress });
      }
      const perm: SharePermission = {
        id: nextId(),
        type: p.type,
        role: p.role,
        emailAddress: p.emailAddress ?? null,
        displayName: p.emailAddress ? p.emailAddress.split("@")[0]! : null,
        domain: null,
      };
      f.permissions.push(perm);
      return { ...perm };
    },

    async updatePermission(fileId: string, permissionId: string, role): Promise<SharePermission> {
      const f = require(fileId);
      const perm = f.permissions.find((x) => x.id === permissionId);
      if (!perm) throw errors.notFound("drivePermission", permissionId);
      if (perm.role === "owner") throw errors.forbidden("オーナー権限は変更できません");
      perm.role = role;
      return { ...perm };
    },

    async deletePermission(fileId: string, permissionId: string): Promise<void> {
      const f = require(fileId);
      const idx = f.permissions.findIndex((x) => x.id === permissionId);
      if (idx === -1) return; // idempotent
      if (f.permissions[idx]!.role === "owner") throw errors.forbidden("オーナー権限は剥奪できません");
      f.permissions.splice(idx, 1);
    },
  };
}
