import "@testing-library/jest-dom/vitest";

// jsdom's URL.createObjectURL/revokeObjectURL throw "Not implemented". The mail attachment
// UI uses them for image thumbnails/previews; stub them so component tests don't crash.
if (typeof URL !== "undefined") {
  // Always assign (jsdom ships a throwing "Not implemented" stub, not a usable one).
  URL.createObjectURL = () => "blob:mock";
  URL.revokeObjectURL = () => {};
}

// jsdom lacks matchMedia (used by theme "system" resolution). Provide a stub.
if (typeof window !== "undefined" && !window.matchMedia) {
  window.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  });
}
