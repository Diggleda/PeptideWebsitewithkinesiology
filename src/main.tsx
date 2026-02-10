
import { createRoot } from "react-dom/client";
import { Toaster } from "sonner@2.0.3";
import App from "./App.tsx";
import "./index.css";
import "react-day-picker/dist/style.css";

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
  const stamp = String(Date.now());
  const ico = `/peppro-favicon-v3.ico?ts=${stamp}`;
  ensureHeadLink('link[rel="icon"][sizes="any"]', { rel: "icon", sizes: "any", href: ico });
  ensureHeadLink('link[rel="shortcut icon"]', { rel: "shortcut icon", href: ico });
  ensureHeadLink('link[rel="icon"][sizes="32x32"]', {
    rel: "icon",
    type: "image/png",
    sizes: "32x32",
    href: `/peppro-favicon-v3-32x32.png?ts=${stamp}`,
  });
  ensureHeadLink('link[rel="icon"][sizes="16x16"]', {
    rel: "icon",
    type: "image/png",
    sizes: "16x16",
    href: `/peppro-favicon-v3-16x16.png?ts=${stamp}`,
  });
  ensureHeadLink('link[rel="apple-touch-icon"]', {
    rel: "apple-touch-icon",
    sizes: "180x180",
    href: `/peppro-apple-touch-icon-v3.png?ts=${stamp}`,
  });
};

forceFavicon();

createRoot(document.getElementById("root")!).render(
  <>
    <App />
    <Toaster richColors position="top-center" expand visibleToasts={10} />
  </>
);
  
