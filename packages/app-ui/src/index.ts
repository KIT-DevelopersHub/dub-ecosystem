// @dub/app-ui — DevHub application composite layer (②).
//
// Domain-aware, DATA-INJECTED React components built by composing @dub/ui
// primitives (①) + @dub/tokens. Reused across the FE2〜FE7 apps. This package
// never fetches data, owns no router, and holds no app state — callers pass data
// (roles, candidates, values) and behavior in via props/children/hooks.
//
// See docs/FRONTEND_GUIDE.md for the taxonomy and the "how to add a composite"
// procedure.

export {
  EmailAddressSelect,
  type EmailAddressSelectProps,
} from "./components/EmailAddressSelect";
export {
  useEmailAddressInput,
  defaultFormatToken,
  type EmailToken,
  type EmailParseResult,
  type UseEmailAddressInputArgs,
  type EmailAddressInput,
} from "./hooks/useEmailAddressInput";

export { RolePicker, type RolePickerProps, type RoleOption } from "./components/RolePicker";
export { DialogActions, type DialogActionsProps } from "./components/DialogActions";
export { FormError, type FormErrorProps } from "./components/FormError";
