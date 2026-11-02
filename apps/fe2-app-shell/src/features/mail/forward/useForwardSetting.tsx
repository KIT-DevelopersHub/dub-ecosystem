// Opt-in auto-forward (Gmail 自動転送) state + mutations. Optimistic per FRONTEND_GUIDE §5.3:
// the setting changes first, the gateway call follows, a failure restores the snapshot and
// surfaces a message. Loaded only while the settings dialog is open.
import { useCallback, useEffect, useRef, useState } from "react";
import type { mail } from "@dub/types";
import { useMailApi } from "../MailProvider.tsx";

export type ForwardLoad = "loading" | "ready" | "failed";

export interface ForwardSettingState {
  load: ForwardLoad;
  setting: mail.MailForwardSetting | null;
  /** Last mutation failure (Japanese copy), cleared by the next action. */
  error: string | null;
  refresh(): void;
  register(target: string): void;
  setEnabled(enabled: boolean): void;
  remove(): void;
}

const MESSAGES: Record<string, string> = {
  MAIL_INVALID_REQUEST: "このアドレスは転送先に使えません（@developershub.jp や自分の Dub アドレスは不可）。",
  MAIL_FORWARD_TARGET_IN_USE: "このアドレスは他のアカウントまたは組織の設定で使われています。",
  MAIL_FORWARD_RATE_LIMITED: "確認メールの送信が多すぎます。しばらく待ってからお試しください。",
  MAIL_EMAIL_ROUTING_UNCONFIGURED: "現在この機能は利用できません（管理者の設定待ち）。",
  MAIL_FORWARD_DISABLED: "現在この機能は停止されています。",
  MAIL_FORWARD_NOT_FOUND: "転送先が登録されていません。",
};

export function forwardErrorMessage(err: unknown, fallback: string): string {
  const code = (err as { code?: unknown } | null)?.code;
  return (typeof code === "string" && MESSAGES[code]) || fallback;
}

const NONE = (available: boolean): mail.MailForwardSetting => ({
  target: null,
  status: "none",
  enabled: false,
  active: false,
  available,
  requestedAt: null,
  verifiedAt: null,
  lastResult: null,
  lastError: null,
  lastAt: null,
});

export function useForwardSetting(open: boolean): ForwardSettingState {
  const api = useMailApi();
  const [load, setLoad] = useState<ForwardLoad>("loading");
  const [setting, setSetting] = useState<mail.MailForwardSetting | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Responses from a superseded request (e.g. a refresh racing a toggle) are dropped.
  const seq = useRef(0);

  const fetchNow = useCallback(() => {
    const id = ++seq.current;
    api
      .getForward()
      .then((s) => {
        if (id !== seq.current) return;
        setSetting(s);
        setLoad("ready");
      })
      .catch(() => {
        if (id !== seq.current) return;
        setLoad((l) => (l === "ready" ? l : "failed"));
      });
  }, [api]);

  useEffect(() => {
    if (!open) return;
    fetchNow();
    // Coming back from the Gmail tab after clicking the verification link re-checks.
    const onFocus = (): void => fetchNow();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [open, fetchNow]);

  const mutate = useCallback(
    (optimistic: mail.MailForwardSetting, call: () => Promise<mail.MailForwardSetting>, failText: string) => {
      const snapshot = setting;
      const id = ++seq.current;
      setError(null);
      setSetting(optimistic);
      call()
        .then((s) => {
          if (id === seq.current) setSetting(s);
        })
        .catch((err: unknown) => {
          if (id !== seq.current) return;
          setSetting(snapshot);
          setError(forwardErrorMessage(err, failText));
        });
    },
    [setting],
  );

  const register = useCallback(
    (raw: string) => {
      const target = raw.trim().toLowerCase();
      if (!target) return;
      const base = setting ?? NONE(true);
      mutate(
        { ...base, target, status: "pending", enabled: true, active: false, requestedAt: new Date().toISOString(), verifiedAt: null, lastResult: null, lastError: null, lastAt: null },
        () => api.registerForward({ target }),
        "確認メールを送信できませんでした。",
      );
    },
    [api, mutate, setting],
  );

  const setEnabled = useCallback(
    (enabled: boolean) => {
      if (!setting || setting.status === "none") return;
      mutate(
        { ...setting, enabled, active: enabled && setting.status === "verified" && setting.available },
        () => api.updateForward({ enabled }),
        enabled ? "自動転送をオンにできませんでした。" : "自動転送をオフにできませんでした。",
      );
    },
    [api, mutate, setting],
  );

  const remove = useCallback(() => {
    if (!setting || setting.status === "none") return;
    mutate(NONE(setting.available), () => api.removeForward(), "転送先の登録を解除できませんでした。");
  }, [api, mutate, setting]);

  return { load, setting, error, refresh: fetchNow, register, setEnabled, remove };
}
