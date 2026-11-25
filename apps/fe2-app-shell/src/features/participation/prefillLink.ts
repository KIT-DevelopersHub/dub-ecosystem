// 参加届の入力済みリンク (/participate#prefill=<base64url JSON>)。人事が面談申し込みの内容から作り、本人が
// 入力し直さずに提出できるようにする。fragment はサーバーに送られないので、公開 API も保存も要らない。
// 受け取った値は入力欄の初期値になるだけ (改ざんされても提出時の通常の検証を通る)。
import { hrForm, member } from "@dub/types";
import { emptyProfileDraft, toProfileDraft, type PersonProfileDraft } from "../../lib/personProfile.tsx";
import { kanaToRomaji } from "../../lib/romaji.ts";

// module.tsx はページ一式を読み込むので、人事側から import しても重くならないようここに置く。
// パスと組み立ては @dub/types hrForm が SoT (合格メールもサーバーで同じリンクを作る)。
export const PUBLIC_PARTICIPATION_PATH = hrForm.PUBLIC_PARTICIPATION_PATH;

const PREFIX = "#prefill=";
const MAX_LENGTH = 4000;

function fromBase64Url(encoded: string): string {
  const bin = atob(encoded.replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

export function prefillPath(prefill: hrForm.ParticipationPrefill): string {
  return hrForm.participationPrefillPath(prefill);
}

/** リンクの値を入力欄の下書きにする。ローマ字はふりがなから埋める。読めないリンクは null (空のフォームで始める)。 */
export function parsePrefillHash(hash: string): PersonProfileDraft | null {
  if (!hash.startsWith(PREFIX) || hash.length > MAX_LENGTH) return null;
  try {
    const raw: unknown = JSON.parse(fromBase64Url(hash.slice(PREFIX.length)));
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
    const { value } = member.parsePersonProfilePatch(raw as Record<string, unknown>);
    const draft = toProfileDraft(value);
    if (JSON.stringify(draft) === JSON.stringify(emptyProfileDraft())) return null;
    draft.lastNameRomaji ||= kanaToRomaji(draft.lastNameKana);
    draft.firstNameRomaji ||= kanaToRomaji(draft.firstNameKana);
    return draft;
  } catch {
    return null;
  }
}

export function readPrefillDraft(): PersonProfileDraft | null {
  return typeof window === "undefined" ? null : parsePrefillHash(window.location.hash);
}

/** 読んだら URL から消す (個人情報をアドレスバーと履歴に残さない)。 */
export function clearPrefillHash(): void {
  if (!window.location.hash.startsWith(PREFIX)) return;
  const url = new URL(window.location.href);
  url.hash = "";
  window.history.replaceState(window.history.state, "", url);
}
