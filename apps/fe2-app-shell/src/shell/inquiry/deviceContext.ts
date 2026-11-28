// Device context auto-attached to every 問い合わせ / フィードバック (notification.FeedbackDevice),
// so an admin can tell which device a bug came from. The user types nothing.
//
// App vs web is never guessed: the Dub app (apps/de1-desktop, all four OSes) appends
// `DubApp/<platform> <version> (<build>)` to its WebView UA. Only without that mark does the
// UA + viewport decide web-mobile / web-pc.
import { notification } from "@dub/types";

export interface DeviceEnv {
  userAgent: string;
  /** navigator.maxTouchPoints (iPadOS Safari reports a Mac UA; touch tells them apart). */
  maxTouchPoints: number;
  /** Viewport in CSS px. */
  width: number;
  height: number;
}

export interface DubAppMark {
  platform: notification.DubAppPlatform;
  version: string;
  build?: string;
}

const APP_MARK_RE = new RegExp(
  `\\b${notification.DUB_APP_UA_TOKEN}/(${notification.DUB_APP_PLATFORMS.join("|")}) ([^\\s()]+)(?: \\(([^)\\s]+)\\))?`,
);

/** The Dub app's UA mark, or null in a plain browser. */
export function parseDubAppMark(ua: string): DubAppMark | null {
  const m = APP_MARK_RE.exec(ua);
  if (!m) return null;
  const mark: DubAppMark = { platform: m[1] as notification.DubAppPlatform, version: m[2]! };
  if (m[3]) mark.build = m[3];
  return mark;
}

const APP_CLIENT: Record<notification.DubAppPlatform, notification.FeedbackClient> = {
  ios: "ios-app",
  android: "android-app",
  macos: "desktop-app",
  windows: "desktop-app",
};

/** Narrower than this with a touch screen reads as a phone/tablet even without a mobile UA. */
const MOBILE_MAX_WIDTH = 768;

function isIpadAsMac(env: DeviceEnv): boolean {
  return /Macintosh/.test(env.userAgent) && env.maxTouchPoints > 1;
}

function osOf(env: DeviceEnv): { os?: string; osVersion?: string } {
  const ua = env.userAgent;
  let m: RegExpExecArray | null;
  if ((m = /(iPhone|iPad|iPod)[^)]*? OS (\d+(?:_\d+)*)/.exec(ua))) {
    return { os: m[1] === "iPad" ? "iPadOS" : "iOS", osVersion: m[2]!.replace(/_/g, ".") };
  }
  if (isIpadAsMac(env)) return { os: "iPadOS" };
  if ((m = /Android (\d+(?:\.\d+)*)/.exec(ua))) return { os: "Android", osVersion: m[1]! };
  if (/Android/.test(ua)) return { os: "Android" };
  if ((m = /Windows NT (\d+\.\d+)/.exec(ua))) return { os: "Windows", osVersion: m[1]! };
  if ((m = /Mac OS X (\d+(?:[_.]\d+)*)/.exec(ua))) return { os: "macOS", osVersion: m[1]!.replace(/_/g, ".") };
  if (/CrOS/.test(ua)) return { os: "ChromeOS" };
  if (/Linux/.test(ua)) return { os: "Linux" };
  return {};
}

function browserOf(ua: string): string | undefined {
  const rules: [RegExp, string][] = [
    [/Edg(?:A|iOS)?\/(\d+)/, "Edge"],
    [/OPR\/(\d+)/, "Opera"],
    [/SamsungBrowser\/(\d+)/, "Samsung Internet"],
    [/(?:Firefox|FxiOS)\/(\d+)/, "Firefox"],
    [/CriOS\/(\d+)/, "Chrome"],
    [/Chrome\/(\d+)/, "Chrome"],
    [/Version\/(\d+(?:\.\d+)?).*Safari/, "Safari"],
  ];
  for (const [re, name] of rules) {
    const m = re.exec(ua);
    if (m) return `${name} ${m[1]}`;
  }
  return undefined;
}

/** Pure: classify + describe a device from its UA and viewport. */
export function describeDevice(env: DeviceEnv): notification.FeedbackDevice {
  const ua = env.userAgent;
  const mark = parseDubAppMark(ua);
  const mobileUa = /Mobi|Android|iPhone|iPad|iPod/.test(ua) || isIpadAsMac(env);
  const client: notification.FeedbackClient = mark
    ? APP_CLIENT[mark.platform]
    : mobileUa || (env.maxTouchPoints > 0 && env.width > 0 && env.width < MOBILE_MAX_WIDTH)
      ? "web-mobile"
      : "web-pc";

  const out: notification.FeedbackDevice = { client, ...osOf(env) };
  const browser = mark ? "WebView" : browserOf(ua);
  if (browser) out.browser = browser;
  if (env.width > 0 && env.height > 0) {
    out.screenWidth = Math.round(env.width);
    out.screenHeight = Math.round(env.height);
  }
  if (mark) {
    out.appVersion = mark.version;
    if (mark.build) out.appBuild = mark.build;
  }
  if (ua) out.userAgent = ua;
  return out;
}

/** Snapshot the current browser's device context. */
export function captureDeviceContext(): notification.FeedbackDevice {
  const nav = globalThis.navigator as Navigator | undefined;
  return describeDevice({
    userAgent: nav?.userAgent ?? "",
    maxTouchPoints: nav?.maxTouchPoints ?? 0,
    width: globalThis.innerWidth ?? 0,
    height: globalThis.innerHeight ?? 0,
  });
}
