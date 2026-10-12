/// <reference lib="dom" />
// UI 確認用 demo ページ（demo.html）。インメモリ API で動き、実 daemon / service には繋がない。
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import cssText from "@dub/tokens/css";
import { CommanderWorkspace } from "../App.tsx";
import { makeDemo } from "./demoApi.ts";

const style = document.createElement("style");
style.textContent = cssText;
document.head.appendChild(style);

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("#root not found");

const { api, client } = makeDemo();

createRoot(rootEl).render(
  <StrictMode>
    <div
      style={{
        maxWidth: 1920,
        margin: "0 auto",
        padding: 24,
        fontFamily: "var(--dub-font-family-sans, system-ui, sans-serif)",
        color: "var(--dub-color-text-primary, #e6e6e6)",
        background: "var(--dub-color-surface-base, #0f1115)",
        minHeight: "100vh",
      }}
    >
      <h1 style={{ fontSize: 18, margin: "0 0 4px" }}>Commander（合体 UI の確認用 demo・データは架空）</h1>
      <CommanderWorkspace api={api} client={client} boardPollMs={1000} />
    </div>
  </StrictMode>,
);
