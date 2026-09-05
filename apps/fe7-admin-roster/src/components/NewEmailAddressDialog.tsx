import { useState } from "react";
import { Modal, TextField, Button, FormField } from "@dub/ui";
import { DialogActions, FormError } from "@dub/app-ui";
import { useCreateEmailAddress } from "../hooks/useRosterApi";
import { useToast } from "../hooks/useToast";
import { EMAIL_ROUTING_DOMAIN } from "../contracts/pending";
import { presentError, fieldErrorMap } from "../lib/errorDisplay";

const suffixRow: React.CSSProperties = { display: "flex", gap: 6, alignItems: "center" };
const suffixStyle: React.CSSProperties = { color: "var(--dub-color-text-muted)", whiteSpace: "nowrap" };
const hintStyle: React.CSSProperties = { margin: "8px 0 0", color: "var(--dub-color-text-muted)", fontSize: "0.85em" };

// Issue a new @developershub.jp address (creates a Cloudflare Email Routing rule
// forwarding `localPart@developershub.jp` -> the mail Worker). The forward target is
// fixed to the mail Worker, so the dialog only asks for the local part.
export function NewEmailAddressDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  /** Fired after a successful issue (e.g. to re-sync the roster with the new address). */
  onCreated?: () => void;
}) {
  const [localPart, setLocalPart] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const create = useCreateEmailAddress();
  const { toast } = useToast();

  function reset() {
    setLocalPart("");
    setFieldErrors({});
    setFormError(null);
  }

  function submit() {
    setFieldErrors({});
    setFormError(null);
    create.mutate(
      { localPart: localPart.trim() },
      {
        onSuccess: (addr) => {
          toast({ kind: "success", title: "アドレスを発行しました", description: addr.address });
          reset();
          onClose();
          onCreated?.();
        },
        onError: (err) => {
          const p = presentError(err);
          if (p.kind === "field-errors") setFieldErrors(fieldErrorMap(p.fields));
          else if ("message" in p) setFormError(p.message);
        },
      },
    );
  }

  return (
    <Modal title="メールアドレスを発行" open={open} onClose={onClose} testId="fe7-email-new-dialog">
      <FormField label="ローカル部" htmlFor="fe7-email-localpart" error={fieldErrors.localPart}>
        <div style={suffixRow}>
          <TextField
            id="fe7-email-localpart"
            value={localPart}
            onChange={(v) => setLocalPart(v)}
            placeholder="info"
            testId="fe7-email-localpart"
          />
          <span style={suffixStyle} data-testid="fe7-email-domain-suffix">
            @{EMAIL_ROUTING_DOMAIN}
          </span>
        </div>
      </FormField>
      <p style={hintStyle} data-testid="fe7-email-forward-hint">
        受信したメールは自動的に mail アプリに届きます（転送先の指定は不要です）。
      </p>
      <FormError>{formError}</FormError>
      <DialogActions>
        <Button variant="secondary" onClick={onClose} testId="fe7-email-cancel">
          キャンセル
        </Button>
        <Button
          variant="primary"
          onClick={submit}
          disabled={create.isPending || !localPart.trim()}
          testId="fe7-email-submit"
        >
          発行する
        </Button>
      </DialogActions>
    </Modal>
  );
}
