// スポンサー (フェーズ1 = 名刺の共有) のビジネスロジック。HTTP 非依存。項目と上限は @dub/types sponsor が SoT。
//
// - 写真だけの名刺も登録できるよう、テキスト項目はすべて任意 (trim して空なら null)。
// - 登録者名は登録時点の名簿 (member_people) の氏名を保存する (表示用・紐付いていなければ null)。
// - 写真本体は SponsorImageStore (本番 R2)。置き場が無い環境では写真の操作だけ 503 にする。
import { DubError, errors } from "@dub/errors";
import { sponsor } from "@dub/types";
import { cardImageKey, type CardRow, type SponsorImageStore, type SponsorRepo } from "./sponsor-repo";
import type { ReqCtx } from "./service";
import type { AppDeps } from "./types";

const errCardNotFound = (id: string): DubError =>
  new DubError("SPONSOR_CARD_NOT_FOUND", `Business card not found: ${id}`, { status: 404 });
const errVersionConflict = (id: string): DubError =>
  new DubError("SPONSOR_VERSION_CONFLICT", `Version conflict for ${id}`, { status: 409 });
const errImageNotFound = (id: string): DubError =>
  new DubError("SPONSOR_IMAGE_NOT_FOUND", `Business card has no image: ${id}`, { status: 404 });
const errUnsupportedType = (type: string): DubError =>
  new DubError("SPONSOR_IMAGE_UNSUPPORTED_TYPE", `Unsupported image type: ${type || "(none)"}`, {
    status: 415,
    details: { allowed: [...sponsor.CARD_IMAGE_TYPES] },
  });
const errTooLarge = (): DubError =>
  new DubError("SPONSOR_IMAGE_TOO_LARGE", `Image exceeds ${sponsor.CARD_IMAGE_MAX_BYTES} bytes`, {
    status: 413,
    details: { maxBytes: sponsor.CARD_IMAGE_MAX_BYTES },
  });
const errFilesUnavailable = (): DubError =>
  new DubError("SPONSOR_FILES_UNAVAILABLE", "Image storage is not configured", { status: 503, retryable: false });

const TEXT_FIELDS = ["companyName", "personName", "department", "title", "email", "phone", "note"] as const;
type TextField = (typeof TEXT_FIELDS)[number];

/** ゆるい形式チェック (空白なし・@ の前後に文字)。 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+$/;

function text(value: unknown, field: TextField): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw errors.validationFailed([{ field, reason: "invalid" }]);
  const t = value.trim();
  const max = field === "note" ? sponsor.CARD_NOTE_MAX : sponsor.CARD_FIELD_MAX;
  if (t.length > max) throw errors.validationFailed([{ field, reason: "too_long" }]);
  if (t.length === 0) return null;
  if (field === "email" && !EMAIL_RE.test(t)) throw errors.validationFailed([{ field, reason: "invalid" }]);
  return t;
}

function version(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw errors.validationFailed([{ field: "expectedVersion", reason: "required" }]);
  }
  return value;
}

/** "image/jpeg; charset=..." -> "image/jpeg"。 */
function mediaType(raw: string | undefined): string {
  return (raw ?? "").split(";")[0]!.trim().toLowerCase();
}

export function toCard(r: CardRow): sponsor.BusinessCard {
  const { orgId: _o, archivedAt: _a, imageContentType, ...rest } = r;
  return { ...rest, hasImage: imageContentType !== null };
}

export interface SponsorDeps extends Pick<AppDeps, "orgId" | "now" | "repo"> {
  sponsorRepo: SponsorRepo;
  /** undefined = 写真の置き場が無い (写真ルートは 503)。 */
  sponsorImages?: SponsorImageStore;
  newSponsorCardId: () => string;
}

export class SponsorService {
  constructor(private readonly deps: SponsorDeps) {}

  private async load(id: string): Promise<CardRow> {
    const row = await this.deps.sponsorRepo.getCard(id);
    if (!row || row.orgId !== this.deps.orgId || row.archivedAt !== null) throw errCardNotFound(id);
    return row;
  }

  private images(): SponsorImageStore {
    if (!this.deps.sponsorImages) throw errFilesUnavailable();
    return this.deps.sponsorImages;
  }

  async list(_ctx: ReqCtx): Promise<sponsor.ListCardsResponse> {
    const rows = await this.deps.sponsorRepo.listCards(this.deps.orgId);
    return { cards: rows.map(toCard) };
  }

  async get(_ctx: ReqCtx, id: string): Promise<sponsor.BusinessCard> {
    return toCard(await this.load(id));
  }

  async create(ctx: ReqCtx, body: sponsor.CreateCardRequest): Promise<sponsor.BusinessCard> {
    const b = (body ?? {}) as Record<string, unknown>;
    const now = this.deps.now();
    const person = await this.deps.repo.getPersonByIdentityUserId(this.deps.orgId, ctx.userId);
    const row: CardRow = {
      id: this.deps.newSponsorCardId(),
      orgId: this.deps.orgId,
      companyName: text(b.companyName, "companyName"),
      personName: text(b.personName, "personName"),
      department: text(b.department, "department"),
      title: text(b.title, "title"),
      email: text(b.email, "email"),
      phone: text(b.phone, "phone"),
      note: text(b.note, "note"),
      imageContentType: null,
      version: 1,
      createdBy: ctx.userId,
      createdByName: person?.name ?? null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    };
    await this.deps.sponsorRepo.createCard(row);
    return toCard(row);
  }

  /** 送られた項目だけ更新 (undefined = そのまま / null・空文字 = 消す)。 */
  async update(_ctx: ReqCtx, id: string, body: sponsor.UpdateCardRequest): Promise<sponsor.BusinessCard> {
    const b = (body ?? {}) as unknown as Record<string, unknown>;
    const expected = version(b.expectedVersion);
    const cur = await this.load(id);
    const next: CardRow = { ...cur, version: cur.version + 1, updatedAt: this.deps.now() };
    for (const f of TEXT_FIELDS) {
      if (b[f] !== undefined) next[f] = text(b[f], f);
    }
    if (!(await this.deps.sponsorRepo.updateCard(next, expected))) throw errVersionConflict(id);
    return toCard(next);
  }

  /** 論理削除。写真は best-effort で消す (失敗しても名刺の削除は成功)。 */
  async remove(_ctx: ReqCtx, id: string): Promise<void> {
    const cur = await this.load(id);
    const now = this.deps.now();
    const next: CardRow = { ...cur, imageContentType: null, archivedAt: now, version: cur.version + 1, updatedAt: now };
    if (!(await this.deps.sponsorRepo.updateCard(next, cur.version))) throw errVersionConflict(id);
    if (cur.imageContentType !== null && this.deps.sponsorImages) {
      await this.deps.sponsorImages.delete(cardImageKey(id)).catch(() => undefined);
    }
  }

  /** 写真を保存 (撮り直しは上書き)。形式 -> 415、サイズ -> 413。 */
  async putImage(
    _ctx: ReqCtx,
    id: string,
    contentType: string | undefined,
    readBody: () => Promise<ArrayBuffer>,
    declaredLength?: number,
  ): Promise<sponsor.BusinessCard> {
    const store = this.images();
    const type = mediaType(contentType);
    if (!sponsor.isCardImageType(type)) throw errUnsupportedType(type);
    if (declaredLength !== undefined && declaredLength > sponsor.CARD_IMAGE_MAX_BYTES) throw errTooLarge();
    const cur = await this.load(id);
    const bytes = await readBody();
    if (bytes.byteLength > sponsor.CARD_IMAGE_MAX_BYTES) throw errTooLarge();
    if (bytes.byteLength === 0) throw errors.validationFailed([{ field: "body", reason: "required" }]);
    await store.put(cardImageKey(id), bytes, type);
    const next: CardRow = { ...cur, imageContentType: type, version: cur.version + 1, updatedAt: this.deps.now() };
    if (!(await this.deps.sponsorRepo.updateCard(next, cur.version))) throw errVersionConflict(id);
    return toCard(next);
  }

  async getImage(_ctx: ReqCtx, id: string): Promise<{ body: ArrayBuffer; contentType: string }> {
    const store = this.images();
    const cur = await this.load(id);
    if (cur.imageContentType === null) throw errImageNotFound(id);
    const obj = await store.get(cardImageKey(id));
    if (!obj) throw errImageNotFound(id);
    return { body: obj.body, contentType: obj.contentType ?? cur.imageContentType };
  }
}
