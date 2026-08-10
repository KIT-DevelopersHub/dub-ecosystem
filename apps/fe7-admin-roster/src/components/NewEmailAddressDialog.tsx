import { useState } from "react";
import { Modal, TextField, Button, FormField } from "@dub/ui";
import { useCreateEmailAddress } from "../hooks/useRosterApi";
import { useToast } from "../hooks/useToast";
import { EMAIL_ROUTING_DOMAIN } from "../contracts/pending";
import { presentError, fieldErrorMap } from "../lib/errorDisplay";

const actionsRow: React.CSSProperties = { display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 };
const suffixRow: React.CSSProperties = { display: "flex", gap: 6, alignItems: "center" };
const suffixStyle: React.CSSProperties = { color: "var(--dub-color-fg-muted, #57606a)", whiteSpace: "nowrap" };
const formErrorStyle: React.CSSProperties = { color: "var(--dub-color-danger-600)", fontSize: 13, margin: "8px 0 0" };

// Issue a new @developershub.jp address (creates a Cloudflare Email Routing rule
// forwarding `localPart@developershub.jp` -> `destination`).
export function NewEmailAddressDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [localPart, setLocalPart] = useState("");
  const [destination, setDestination] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const create = useCreateEmailAddress();
  const { toast } = useToast();

  function reset() {
    setLocalPart("");
    setDestination("");
    setFieldErrors({});
    setFormError(null);
  }

  function submit() {
    setFieldErrors({});
    setFormError(null);
    create.mutate(
      { localPart: localPart.trim(), destination: destination.trim() },
      {
        onSuccess: (addr) => {
          toast({ kind: "success", title: "アドレスを発行しました", description: addr.address });
          reset();
          onClose();
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
      <FormField label="転送先（destination）" htmlFor="fe7-email-destination" error={fieldErrors.destination}>
        <TextField
          id="fe7-email-destination"
          type="email"
          value={destination}
          onChange={(v) => setDestination(v)}
          placeholder="team@example.com"
          testId="fe7-email-destination"
        />
      </FormField>
      {formError ? (
        <p style={formErrorStyle} role="alert">
          {formError}
        </p>
      ) : null}
      <div style={actionsRow}>
        <Button variant="secondary" onClick={onClose} testId="fe7-email-cancel">
          キャンセル
        </Button>
        <Button
          variant="primary"
          onClick={submit}
          disabled={create.isPending || !localPart.trim() || !destination.trim()}
          testId="fe7-email-submit"
        >
          発行する
        </Button>
      </div>
    </Modal>
  );
}
