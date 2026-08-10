// Always-mounted banner for the admin shell top. Polls the mail-gateway rate-limit
// status and delegates rendering to @dub/ui's RateLimitNotice, which renders NOTHING
// while `active` is false — so mounting this unconditionally at the top of the shell is
// safe and it only appears when メール送信API is actually throttled.
//
// Fail-safe: while loading or if the status fetch errors (e.g. the gateway route is not
// wired yet), `data` is undefined and the banner stays hidden rather than alarming.
import { RateLimitNotice } from "@dub/ui";
import { useMailRateLimitStatus } from "../hooks/useRosterApi";

export function MailRateLimitBanner() {
  const { data } = useMailRateLimitStatus();
  const rateLimit = data?.rateLimit;
  return (
    <RateLimitNotice
      serviceLabel="メール送信API"
      active={rateLimit?.active ?? false}
      recoversAt={rateLimit?.recoversAt ?? null}
      testId="fe7-mail-rate-limit-banner"
    />
  );
}
