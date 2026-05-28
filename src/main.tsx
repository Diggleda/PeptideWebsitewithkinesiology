
import React from "react";
import { createRoot } from "react-dom/client";
import { createPortal } from "react-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster, toast as sonnerToast, useSonner } from "sonner@2.0.3";
import App from "./App.tsx";
import "./index.css";
import "react-day-picker/dist/style.css";
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

const forceFavicon = () => {
  ensureHeadLink('link[rel="icon"]', { rel: "icon", href: "/favicon.ico" });
  ensureHeadLink('link[rel="shortcut icon"]', { rel: "shortcut icon", href: "/favicon.ico" });
  ensureHeadLink('link[rel="apple-touch-icon"]', {
    rel: "apple-touch-icon",
    href: "/Trufusionpeptides_icon.png",
  });
};

forceFavicon();

function ToastPortal() {
  const { toasts } = useSonner();

  const handleToastClick = React.useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (typeof window === "undefined" || !window.matchMedia("(hover: hover) and (pointer: fine)").matches) {
        return;
      }

      const target = event.target instanceof HTMLElement ? event.target : null;
      if (!target) return;
      if (target.closest("a,button,input,textarea,select,[role='button'],[data-button],[data-close-button]")) {
        return;
      }

      const toastElement = target.closest<HTMLElement>("[data-sonner-toast]");
      if (!toastElement || toastElement.dataset.dismissible === "false") {
        return;
      }

      const toastIndex = Number(toastElement.dataset.index);
      const positionedToasts = toasts.filter((toastItem) => !toastItem.position || toastItem.position === "top-center");
      const toastToDismiss = Number.isInteger(toastIndex) ? positionedToasts[toastIndex] : null;
      if (toastToDismiss?.id !== undefined) {
        sonnerToast.dismiss(toastToDismiss.id);
      }
    },
    [toasts],
  );

  if (typeof document === "undefined") {
    return null;
  }

  return createPortal(
    <div className="toast-portal-layer" onClick={handleToastClick}>
      <Toaster
        richColors
        position="top-center"
        expand
        visibleToasts={10}
        swipeDirections={["top"]}
        toastOptions={{ dismissible: true }}
      />
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
  
