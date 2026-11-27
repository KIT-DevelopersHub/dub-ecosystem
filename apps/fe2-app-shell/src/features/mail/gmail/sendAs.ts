// 共用アドレスから送る (0027): the Froms the signed-in user may pick in compose, and the shared
// mailbox signature that goes with one. The server checks the pick again on every send.
import { useEffect, useState } from "react";
import type { mail } from "@dub/types";
import { useMailApi } from "../MailProvider.tsx";
import type { MailApi } from "../mailApi.tsx";

// One request per api (session), shared by every compose window.
const cache = new WeakMap<MailApi, Promise<mail.MailSendAsOption[]>>();

/** The user's own address first, then shared mailboxes. null while loading; [] when the server
 *  has none to offer (or cannot answer, in which case compose keeps the default From). */
export function useSendAs(): mail.MailSendAsOption[] | null {
  const api = useMailApi();
  const [items, setItems] = useState<mail.MailSendAsOption[] | null>(null);
  useEffect(() => {
    if (!api.listSendAs) {
      setItems([]);
      return;
    }
    let alive = true;
    let p = cache.get(api);
    if (!p) {
      p = api.listSendAs().catch(() => {
        cache.delete(api);
        return [];
      });
      cache.set(api, p);
    }
    void p.then((list) => alive && setItems(list));
    return () => {
      alive = false;
    };
  }, [api]);
  return items;
}

/** Label of one From option: `表示名 <address>` for a shared mailbox, the address otherwise. */
export function sendAsLabel(o: mail.MailSendAsOption): string {
  return o.displayName ? `${o.displayName} <${o.address}>` : o.address;
}

/**
 * Swap the signature when the From changes: the previous one comes out (only if it is still
 * exactly where it was put) and the next one goes in once. A new mail gets it at the end; a
 * forward above the forwarded text.
 */
export function swapSignature(body: string, atTop: boolean, prev: string | undefined, next: string | undefined): string {
  let b = body;
  if (prev) {
    const block = `\n\n${prev}`;
    if (atTop) {
      if (b.startsWith(block)) b = b.slice(block.length);
    } else if (b.endsWith(block)) {
      b = b.slice(0, -block.length);
    }
  }
  if (next && !b.includes(next)) b = atTop ? `\n\n${next}${b}` : `${b.replace(/\s+$/, "")}\n\n${next}`;
  return b;
}
