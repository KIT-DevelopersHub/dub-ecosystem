// transport — the injectable HTTP boundary (mirrors Swift URLSession). Keeping
// it an interface lets ViewModel/ApiClient logic be tested without a network.
export type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE";

export interface TransportRequest {
  method: HttpMethod;
  /** absolute URL (baseUrl + `/m/v1` path + query already applied). */
  url: string;
  headers: Record<string, string>;
  /** JSON-serialisable body, or undefined for GET/DELETE. */
  body?: unknown;
}

export interface TransportResponse {
  status: number;
  headers: Record<string, string>;
  /** already JSON-decoded (null for empty body). */
  body: unknown;
}

/** Throws (rejects) only on transport failure — an HTTP error status is a
 * resolved TransportResponse, not a throw. */
export type Transport = (req: TransportRequest) => Promise<TransportResponse>;
