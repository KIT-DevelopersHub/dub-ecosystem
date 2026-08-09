// Test doubles: a MockWebServer-analog fetch (queued responses + request log).
import type { FetchFn } from "../src/http";

export interface RecordedRequest {
  url: string;
  method: string;
  authorization: string | null;
  body: unknown;
}

export interface MockResponse {
  status: number;
  body?: unknown; // serialized to JSON when defined
  headers?: Record<string, string>;
  networkError?: unknown; // if set, fetch rejects (transport failure)
}

export interface MockServer {
  fetch: FetchFn;
  requests: RecordedRequest[];
  enqueue: (...responses: MockResponse[]) => void;
}

export function makeMockServer(...initial: MockResponse[]): MockServer {
  const queue: MockResponse[] = [...initial];
  const requests: RecordedRequest[] = [];

  const fetch: FetchFn = async (url, init) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    let body: unknown = undefined;
    if (typeof init.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    requests.push({
      url,
      method: init.method ?? "GET",
      authorization: headers["authorization"] ?? null,
      body,
    });

    const next = queue.shift();
    if (!next) throw new Error(`MockServer: no queued response for ${init.method} ${url}`);
    if (next.networkError !== undefined) throw next.networkError;

    const text = next.body !== undefined ? JSON.stringify(next.body) : "";
    return new Response(text.length > 0 ? text : null, {
      status: next.status,
      headers: next.headers ?? {},
    });
  };

  return {
    fetch,
    requests,
    enqueue: (...responses: MockResponse[]) => queue.push(...responses),
  };
}

export function errorBody(code: string, details?: unknown, requestId = "req_test") {
  return { error: { code, message: `${code} occurred`, details, requestId, retryable: false } };
}
