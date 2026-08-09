import type { ErrorResponse } from "@dub/errors";
import type { Transport, TransportRequest, TransportResponse } from "../src/transport.js";

export function ok(body: unknown, status = 200): TransportResponse {
  return { status, headers: {}, body };
}

export function errBody(code: string, message = code, extra: Partial<ErrorResponse["error"]> = {}): ErrorResponse {
  return { error: { code, message, retryable: false, ...extra } };
}

/** Transport driven by a queue of responses (or thrown errors) per call. */
export function scriptedTransport(
  script: Array<TransportResponse | Error | ((req: TransportRequest) => TransportResponse)>,
): { transport: Transport; calls: TransportRequest[] } {
  const calls: TransportRequest[] = [];
  let i = 0;
  const transport: Transport = async (req) => {
    calls.push(req);
    const step = script[Math.min(i, script.length - 1)];
    i += 1;
    if (step instanceof Error) throw step;
    if (typeof step === "function") return step(req);
    return step as TransportResponse;
  };
  return { transport, calls };
}
