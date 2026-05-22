
import React from "react";
import { createRoot } from "react-dom/client";
import { createPortal } from "react-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "sonner@2.0.3";
import App from "./App.tsx";
import "./index.css";
import "react-day-picker/dist/style.css";
import { resolveStaticAssetUrl } from "./lib/assetUrl";
import { queryClient } from "./lib/queryClient";

// Defensive runtime bridge for any emitted bundle code that still references
// the React global instead of the imported module binding.
if (typeof globalThis !== "undefined") {
  (globalThis as typeof globalThis & { React?: typeof React }).React = React;
}

if (typeof window !== "undefined" && typeof console !== "undefined") {
  const originalWarn = console.warn.bind(console);
  console.warn = (...args: unknown[]) => {
    const first = typeof args[0] === "string" ? args[0] : "";
    if (first.includes("window.styleMedia is a deprecated draft version of window.matchMedia API")) {
      return;
    }
    originalWarn(...args);
  };
}

const ensureHeadLink = (selector: string, attrs: Record<string, string>) => {
  const head = document.head || document.querySelector("head");
  if (!head) return;
  let link = document.querySelector(selector) as HTMLLinkElement | null;
  if (!link) {
    link = document.createElement("link");
    head.appendChild(link);
  }
  Object.entries(attrs).forEach(([key, value]) => link!.setAttribute(key, value));
};

const appendUrlParam = (value: string, key: string, paramValue: string) => {
  const hashIndex = value.indexOf("#");
  const hash = hashIndex >= 0 ? value.slice(hashIndex) : "";
  const base = hashIndex >= 0 ? value.slice(0, hashIndex) : value;
  const separator = base.includes("?") ? "&" : "?";
  return `${base}${separator}${encodeURIComponent(key)}=${encodeURIComponent(paramValue)}${hash}`;
};

const forceFavicon = () => {
  const stamp = String(Date.now());
  const ico = appendUrlParam(resolveStaticAssetUrl("/favicon.ico"), "ts", stamp);
  ensureHeadLink('link[rel="icon"][sizes="any"]', { rel: "icon", sizes: "any", href: ico });
  ensureHeadLink('link[rel="shortcut icon"]', { rel: "shortcut icon", href: ico });
  ensureHeadLink('link[rel="icon"][sizes="32x32"]', {
    rel: "icon",
    type: "image/png",
    sizes: "32x32",
    href: appendUrlParam(resolveStaticAssetUrl("/favicon.ico"), "ts", stamp),
  });
  ensureHeadLink('link[rel="icon"][sizes="16x16"]', {
    rel: "icon",
    type: "image/png",
    sizes: "16x16",
    href: appendUrlParam(resolveStaticAssetUrl("/favicon.ico"), "ts", stamp),
  });
  ensureHeadLink('link[rel="apple-touch-icon"]', {
    rel: "apple-touch-icon",
    sizes: "180x180",
    href: appendUrlParam(resolveStaticAssetUrl("/favicon.ico"), "ts", stamp),
  });
};

forceFavicon();

function ToastPortal() {
  if (typeof document === "undefined") {
    return null;
  }

  return createPortal(
    <div className="toast-portal-layer">
      <Toaster richColors position="top-center" expand visibleToasts={10} />
    </div>,
    document.body,
  );
}

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <App />
    <ToastPortal />
  </QueryClientProvider>
);
  
