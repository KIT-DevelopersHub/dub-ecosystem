// Display constants for the "Dubを操作" approval screen.
import type { OpRisk, Verdict } from "./operateApi.ts";

export const CONFIRM_PHRASE = "実行";
export const API_PATH_PREFIX = "/api/v1";

/** Prefix shown before a call's path: the Dub gateway's, or none for commander-service. */
export const apiPathPrefix = (api: "commander" | undefined): string => (api === "commander" ? "" : API_PATH_PREFIX);

export const RISK_LABEL: Record<OpRisk, string> = { low: "低", mid: "中", high: "高" };
export const RISK_TONE: Record<OpRisk, "success" | "warning" | "danger"> = { low: "success", mid: "warning", high: "danger" };
export const VERDICT_TONE: Record<Verdict, "success" | "warning" | "danger"> = { done: "success", partial: "warning", failed: "danger" };
