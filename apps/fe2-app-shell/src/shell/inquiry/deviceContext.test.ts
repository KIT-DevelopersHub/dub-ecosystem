import { describe, it, expect } from "vitest";
import { describeDevice, parseDubAppMark, type DeviceEnv } from "./deviceContext.ts";

const IPHONE_SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";
const IPHONE_APP =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 DubApp/ios 1.0.2 (6)";
const ANDROID_APP =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/131.0.0.0 Mobile Safari/537.36 DubApp/android 1.0.2 (6)";
const MAC_APP = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) DubApp/macos 1.0.2 (6)";
const WIN_CHROME =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const MAC_SAFARI =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15";
const ANDROID_CHROME =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";

const env = (userAgent: string, over: Partial<DeviceEnv> = {}): DeviceEnv => ({
  userAgent,
  maxTouchPoints: 0,
  width: 1440,
  height: 900,
  ...over,
});

describe("parseDubAppMark", () => {
  it("reads platform, version and build from the app's UA mark", () => {
    expect(parseDubAppMark(IPHONE_APP)).toEqual({ platform: "ios", version: "1.0.2", build: "6" });
    expect(parseDubAppMark("x DubApp/windows 2.0.0")).toEqual({ platform: "windows", version: "2.0.0" });
  });
  it("is null for a plain browser or an unknown platform", () => {
    expect(parseDubAppMark(IPHONE_SAFARI)).toBeNull();
    expect(parseDubAppMark("x DubApp/linux 1.0.0 (1)")).toBeNull();
  });
});

describe("describeDevice: client 区分", () => {
  it("the app mark decides ios-app / android-app / desktop-app (no guessing)", () => {
    expect(describeDevice(env(IPHONE_APP, { maxTouchPoints: 5, width: 390, height: 844 }))).toEqual({
      client: "ios-app",
      os: "iOS",
      osVersion: "18.1",
      browser: "WebView",
      screenWidth: 390,
      screenHeight: 844,
      appVersion: "1.0.2",
      appBuild: "6",
      userAgent: IPHONE_APP,
    });
    expect(describeDevice(env(ANDROID_APP, { maxTouchPoints: 5, width: 412, height: 915 })).client).toBe("android-app");
    expect(describeDevice(env(MAC_APP)).client).toBe("desktop-app");
    expect(describeDevice(env("Mozilla/5.0 (Windows NT 10.0; Win64; x64) DubApp/windows 1.0.2 (6)")).client).toBe("desktop-app");
  });

  it("without the mark: mobile UA -> web-mobile, desktop UA -> web-pc", () => {
    expect(describeDevice(env(IPHONE_SAFARI, { maxTouchPoints: 5, width: 390, height: 844 }))).toMatchObject({
      client: "web-mobile",
      os: "iOS",
      osVersion: "18.1",
      browser: "Safari 18.1",
    });
    expect(describeDevice(env(ANDROID_CHROME))).toMatchObject({ client: "web-mobile", os: "Android", osVersion: "14", browser: "Chrome 131" });
    expect(describeDevice(env(WIN_CHROME))).toMatchObject({ client: "web-pc", os: "Windows", osVersion: "10.0", browser: "Chrome 131" });
    expect(describeDevice(env(MAC_SAFARI))).toMatchObject({ client: "web-pc", os: "macOS", browser: "Safari 18.1" });
    expect(describeDevice(env(MAC_SAFARI)).appVersion).toBeUndefined();
  });

  it("iPadOS Safari (Mac UA + touch) and a narrow touch screen count as web-mobile", () => {
    expect(describeDevice(env(MAC_SAFARI, { maxTouchPoints: 5, width: 1024, height: 1366 }))).toMatchObject({ client: "web-mobile", os: "iPadOS" });
    expect(describeDevice(env("Mozilla/5.0 (X11; Linux x86_64)", { maxTouchPoints: 1, width: 600 })).client).toBe("web-mobile");
    // a narrow window on a non-touch PC stays web-pc
    expect(describeDevice(env(WIN_CHROME, { width: 500 })).client).toBe("web-pc");
  });

  it("omits what it cannot know (no UA, no viewport)", () => {
    expect(describeDevice({ userAgent: "", maxTouchPoints: 0, width: 0, height: 0 })).toEqual({ client: "web-pc" });
  });
});
