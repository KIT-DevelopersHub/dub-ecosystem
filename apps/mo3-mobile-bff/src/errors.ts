// MO3-specific error factories. Common codes come from @dub/errors; MOBILE_* are
// the service-owned open-half codes (SCREAMING_SNAKE, theme3). Wire form is the
// unified ErrorResponse — dubErrorHandler serializes every throw.
import { DubError, errors } from "@dub/errors";

export type MobileErrorCode =
  | "MOBILE_DEVICE_NOT_FOUND"
  | "MOBILE_NOT_IMPLEMENTED"
  | "MOBILE_SYNC_CURSOR_EXPIRED"
  | "MOBILE_MUTATION_UNSUPPORTED_TYPE";

export const mobileErrors = {
  /** 404 — DELETE/GET of a device that does not exist or is not the caller's. */
  deviceNotFound(deviceId: string): DubError {
    return new DubError("MOBILE_DEVICE_NOT_FOUND", `device not found: ${deviceId}`, {
      status: 404,
      details: { deviceId },
    });
  },
  /** 501 — sync/mutations are contract-frozen (P0b) but not implemented in P0. */
  notImplemented(feature: string): DubError {
    return new DubError("MOBILE_NOT_IMPLEMENTED", `${feature} is contract-frozen; implemented in a later wave`, {
      status: 501,
      retryable: false,
    });
  },
  /** 403 — /internal/* reached without the x-dub-internal Service-Binding marker. */
  internalOnly(): DubError {
    return errors.forbidden("internal endpoint: Service Binding only");
  },
  /** 400 — /sync cursor is unparseable (tampered) or from an incompatible version. */
  syncCursorExpired(): DubError {
    return new DubError("MOBILE_SYNC_CURSOR_EXPIRED", "sync cursor is invalid or expired", {
      status: 400,
      retryable: false,
    });
  },
  /** 400 — /mutations carried an op outside the supported registry. */
  mutationUnsupportedType(op: string): DubError {
    return new DubError("MOBILE_MUTATION_UNSUPPORTED_TYPE", `unsupported mutation op: ${op}`, {
      status: 400,
      retryable: false,
    });
  },
};
