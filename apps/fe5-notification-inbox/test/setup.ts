import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
import { useUnreadStore } from "../src/store/unread-store";

afterEach(() => {
  cleanup();
  // Reset the shared singleton store between tests.
  useUnreadStore.setState({ count: 0, initialized: false });
});
