import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import {
  BookmarkIcon,
  CalendarDaysIcon,
  CircleStackIcon,
  ClockIcon,
  EnvelopeIcon,
  ExclamationCircleIcon,
  PaperAirplaneIcon,
  RocketLaunchIcon,
  StrikethroughIcon,
} from "@heroicons/react/24/outline";
import {
  FileText,
  Mail,
  RefreshCw,
  Users,
} from "lucide-react";
import {
  emailCenterAPI,
  type EmailCenterCampaign,
  type EmailCenterTemplate,
} from "../../services/api";
import { toast } from "../../lib/toast";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { Button } from "../ui/button";

type EmailTypeOption = {
  id: string;
  label: string;
};

type RecipientMode =
  | "test"
  | "selected_physician"
  | "all_verified_physicians"
  | "sales_reps"
  | "custom";

type RecipientPreview = {
  email: string;
  name?: string;
  type?: string;
  clinicName?: string;
  clinic_name?: string;
  variables?: Record<string, string>;
};

type PreviewRecipientOption = RecipientPreview & {
  id: string;
  label: string;
  variables: Record<string, string>;
};

const SHOW_VARIABLES_PREVIEW_RECIPIENT: PreviewRecipientOption = {
  id: "show_variables",
  label: "Show Variables",
  email: "",
  name: "",
  type: "show_variables",
  variables: {},
};

const SAMPLE_VALUES: Record<string, string> = {
  doctor_name: "Dr. Jane Example",
  clinic_name: "Example Clinic",
  delegate_links_url: "https://trufusionlabs.com/account?tab=delegate-links",
  unsubscribe_url: "https://trufusionlabs.com/api/admin/email/unsubscribe?preview=1",
  survey_link: "https://trufusionlabs.com/surveys/example",
  invite_link: "https://trufusionlabs.com/invitations/example",
  support_email: "support@trufusionlabs.com",
  message_body: "This safe text field is controlled by an approved template.",
};

const RECIPIENT_OPTIONS: Array<{ id: RecipientMode; label: string; description: string }> = [
  { id: "test", label: "Test email only", description: "Queue one recipient for validation." },
  { id: "selected_physician", label: "Selected physician", description: "Send to one physician account by email." },
  { id: "all_verified_physicians", label: "All verified physicians", description: "Queue every verified physician account." },
  { id: "sales_reps", label: "Sales reps", description: "Queue active sales representatives." },
  { id: "custom", label: "Custom email list", description: "Paste approved recipient emails." },
];

const RECIPIENT_MODE_TO_GROUP: Record<RecipientMode, string> = {
  test: "test",
  selected_physician: "physicians",
  all_verified_physicians: "physicians",
  sales_reps: "sales_reps",
  custom: "custom",
};

const CAMPAIGN_TABS = [
  { id: "new", label: "Create a Campaign", Icon: EnvelopeIcon },
  { id: "templates", label: "Templates", Icon: StrikethroughIcon },
  { id: "draft", label: "Drafts", Icon: BookmarkIcon },
  { id: "scheduled", label: "Scheduled", Icon: ClockIcon },
  { id: "sent", label: "Sent", Icon: RocketLaunchIcon },
  { id: "failed", label: "Failed Sends", Icon: ExclamationCircleIcon },
  { id: "logs", label: "Email Logs", Icon: CircleStackIcon },
] as const;

type CampaignTab = (typeof CAMPAIGN_TABS)[number]["id"];

const templateCampaignType = (template?: EmailCenterTemplate | null) =>
  String(template?.campaign_type || template?.campaignType || "").trim();

const templateDefaultSubject = (template?: EmailCenterTemplate | null) =>
  String((template as any)?.default_subject || "").trim();

const formatRecipientListValue = (value?: unknown) => {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry || "").trim()).filter(Boolean).join(", ");
  }
  return String(value || "").trim();
};

const getTemplateVariables = (template?: EmailCenterTemplate | null): string[] =>
  Array.isArray(template?.variables) ? template.variables.filter(Boolean) : [];

const formatDateTime = (value?: string | null) => {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
};

const getErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error || "Request failed");

const formatCount = (value: number) => new Intl.NumberFormat().format(Math.max(0, Math.round(value)));

const countCustomEmails = (value: string) =>
  value
    .split(/[\s,;]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.includes("@")).length;

const scheduleInputToIso = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) {
    throw new Error("Choose a valid scheduled send time.");
  }
  return date.toISOString();
};

const isoToScheduleInput = (value?: string | null) => {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const offsetMs = date.getTimezoneOffset() * 60 * 1000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
};

const DASHBOARD_PANEL_CLASS = "sales-rep-leads-card text-slate-900";
const FIELD_SHELL_CLASS = "rounded-md border border-slate-200/80 bg-white/85 p-3 shadow-sm";
const FIELD_LABEL_CLASS = "mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500";
const FIELD_STACK_CLASS = "grid gap-6";
const INPUT_CLASS = "h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-900 shadow-inner outline-none transition focus:border-slate-500 focus:ring-2 focus:ring-slate-900/10";
const TEXTAREA_CLASS = "w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-inner outline-none transition focus:border-slate-500 focus:ring-2 focus:ring-slate-900/10";
const SELECT_CLASS = "h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-900 shadow-inner outline-none transition focus:border-slate-500 focus:ring-2 focus:ring-slate-900/10";
const ACTION_SELECT_CLASS = "h-9 min-w-[9.5rem] rounded-md border border-slate-300 bg-white px-3 text-sm font-semibold text-black shadow-inner outline-none transition hover:border-slate-500 focus:border-slate-500 focus:ring-2 focus:ring-slate-900/10 disabled:cursor-not-allowed disabled:opacity-50";
const EMPTY_EMAIL_PREVIEW_HTML = "<!doctype html><html><head></head><body></body></html>";
const RECIPIENT_DYNAMIC_VARIABLE_KEYS = new Set([
  "doctor_name",
  "clinic_name",
  "delegate_links_url",
  "unsubscribe_url",
]);
const serializeForInlineScript = (value: unknown) => String(JSON.stringify(value) ?? "null").replace(/</g, "\\u003c");
const EMAIL_PREVIEW_CONTAINMENT_HEAD = `
<meta data-email-center-preview-containment name="viewport" content="width=device-width, initial-scale=1" />
<style data-email-center-preview-containment>
  html,
  body {
    width: 100% !important;
    max-width: 100% !important;
    min-width: 0 !important;
    margin: 0 !important;
    overflow-x: hidden !important;
    background: #ffffff !important;
  }
  body {
    display: block !important;
  }
  html[data-email-center-preview-fit-ready="true"],
  html[data-email-center-preview-fit-ready="true"] body {
    height: 100% !important;
    overflow-x: hidden !important;
    overflow-y: auto !important;
  }
  *,
  *::before,
  *::after {
    box-sizing: border-box !important;
  }
  [data-email-center-preview-fit-stage] {
    align-items: flex-start !important;
    display: block !important;
    max-width: 100vw !important;
    min-width: 0 !important;
    overflow: visible !important;
    position: relative !important;
    width: 100vw !important;
  }
  [data-email-center-preview-fit-content] {
    display: block !important;
    left: 0;
    max-width: none !important;
    min-width: 0 !important;
    position: absolute !important;
    text-align: initial !important;
    top: 0 !important;
    transform-box: border-box !important;
    transform-origin: top left !important;
    width: max-content !important;
  }
  img,
  video {
    max-width: 100% !important;
    height: auto !important;
  }
  td,
  th {
    overflow-wrap: anywhere !important;
  }
</style>
<script data-email-center-preview-containment>
(function () {
  var stage = null;
  var content = null;
  var pending = false;
  var resizeObserver = null;
  var mutationObserver = null;

  function isInjectedPreviewNode(node) {
    return Boolean(
      node &&
      node.nodeType === 1 &&
      (
        node.matches("[data-email-center-preview-containment],[data-email-center-preview-editor],style[data-email-center-preview-editor-style],.email-center-preview-edit-button") ||
        node.closest(".email-center-preview-edit-button,.email-center-preview-variable-button,.email-center-preview-variable-menu,[data-email-center-variable-remove]")
      )
    );
  }

  function isPreviewChromeTarget(target) {
    return Boolean(
      target &&
      target.closest &&
      target.closest(".email-center-preview-edit-button,.email-center-preview-variable-button,.email-center-preview-variable-menu,[data-email-center-variable-remove],[data-email-center-preview-editor]")
    );
  }

  function isEditingTarget(target) {
    return Boolean(
      target &&
      target.closest &&
      target.closest('[contenteditable="true"],[data-email-center-editing="true"]')
    );
  }

  function blockPreviewAction(event) {
    var target = event.target;
    if (isPreviewChromeTarget(target) || isEditingTarget(target)) return;
    if (!target || !target.closest) return;
    var actionTarget = target.closest('a[href],area[href],button,input[type="button"],input[type="submit"],input[type="reset"],[role="button"]');
    if (!actionTarget) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.stopImmediatePropagation) {
      event.stopImmediatePropagation();
    }
  }

  document.addEventListener("click", blockPreviewAction, true);
  document.addEventListener("auxclick", blockPreviewAction, true);
  document.addEventListener("submit", function (event) {
    event.preventDefault();
    event.stopPropagation();
    if (event.stopImmediatePropagation) {
      event.stopImmediatePropagation();
    }
  }, true);

  function wrapPreviewContent() {
    if (!document.body) return false;
    stage = document.querySelector("[data-email-center-preview-fit-stage]");
    content = document.querySelector("[data-email-center-preview-fit-content]");
    if (stage && content) return true;

    stage = document.createElement("div");
    stage.setAttribute("data-email-center-preview-fit-stage", "true");
    content = document.createElement("div");
    content.setAttribute("data-email-center-preview-fit-content", "true");

    Array.prototype.slice.call(document.body.childNodes).forEach(function (node) {
      if (!isInjectedPreviewNode(node)) {
        content.appendChild(node);
      }
    });

    stage.appendChild(content);
    document.body.insertBefore(stage, document.body.firstChild);
    document.documentElement.setAttribute("data-email-center-preview-fit-ready", "true");
    return true;
  }

  function measureContent() {
    content.style.transform = "none";
    content.style.left = "0px";
    content.style.width = "max-content";
    var width = Math.max(content.scrollWidth, content.offsetWidth, 1);
    var height = Math.max(content.scrollHeight, content.offsetHeight, 1);
    Array.prototype.slice.call(content.children).forEach(function (child) {
      width = Math.max(width, child.scrollWidth || 0, child.offsetWidth || 0);
      height = Math.max(height, child.scrollHeight || 0, child.offsetHeight || 0);
    });
    return { width: width, height: height };
  }

  function candidateScore(element, availableWidth) {
    var rect = element.getBoundingClientRect();
    if (rect.width < 120 || rect.height < 80) return -1;
    var style = window.getComputedStyle(element);
    var score = 0;
    var inlineStyle = String(element.getAttribute("style") || "").toLowerCase();
    var maxWidth = String(style.maxWidth || "").toLowerCase();
    if (maxWidth && maxWidth !== "none" && maxWidth !== "100%") score += 120;
    if (/max-width\s*:\s*(?!100%|none)/.test(inlineStyle)) score += 120;
    if (element.getAttribute("width") && element.getAttribute("width") !== "100%") score += 50;
    if (parseFloat(style.borderTopWidth) || parseFloat(style.borderRightWidth) || parseFloat(style.borderBottomWidth) || parseFloat(style.borderLeftWidth)) score += 80;
    if (style.boxShadow && style.boxShadow !== "none") score += 70;
    if (parseFloat(style.borderRadius)) score += 30;
    if (String(style.marginLeft) === "auto" && String(style.marginRight) === "auto") score += 30;
    if (element.tagName === "TABLE") score += 20;
    if (rect.width >= availableWidth - 2 && score < 100) score -= 100;
    return score;
  }

  function findPrimaryContentElement(availableWidth) {
    var candidates = Array.prototype.slice.call(content.querySelectorAll("table,div,section,article,main"));
    var best = null;
    var bestScore = -1;
    candidates.forEach(function (element) {
      var score = candidateScore(element, availableWidth);
      if (score > bestScore) {
        bestScore = score;
        best = element;
      }
    });
    return bestScore > 0 ? best : null;
  }

  function measureVisibleBounds(availableWidth) {
    var contentRect = content.getBoundingClientRect();
    var primary = findPrimaryContentElement(availableWidth);
    if (primary) {
      var primaryRect = primary.getBoundingClientRect();
      return {
        left: primaryRect.left - contentRect.left,
        right: primaryRect.right - contentRect.left,
        top: primaryRect.top - contentRect.top,
        bottom: primaryRect.bottom - contentRect.top
      };
    }
    var bounds = { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity };
    Array.prototype.slice.call(content.querySelectorAll("img,p,h1,h2,h3,h4,h5,h6,li,a,td,th,table,div")).forEach(function (element) {
      var rect = element.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return;
      bounds.left = Math.min(bounds.left, rect.left - contentRect.left);
      bounds.right = Math.max(bounds.right, rect.right - contentRect.left);
      bounds.top = Math.min(bounds.top, rect.top - contentRect.top);
      bounds.bottom = Math.max(bounds.bottom, rect.bottom - contentRect.top);
    });
    if (!Number.isFinite(bounds.left) || bounds.right <= bounds.left) {
      return { left: 0, right: Math.max(content.offsetWidth, 1), top: 0, bottom: Math.max(content.offsetHeight, 1) };
    }
    return bounds;
  }

  function fitPreviewContent() {
    pending = false;
    if (!wrapPreviewContent()) return;
    var availableWidth = Math.max(document.documentElement.clientWidth || window.innerWidth || 0, 1);
    var measured = measureContent();
    var bounds = measureVisibleBounds(availableWidth);
    var visibleWidth = Math.max(bounds.right - bounds.left, 1);
    var visibleHeight = Math.max(bounds.bottom - bounds.top, measured.height, 1);
    var scale = Math.min(1, availableWidth / visibleWidth);
    if (!Number.isFinite(scale) || scale <= 0) scale = 1;
    var offsetX = ((availableWidth - visibleWidth * scale) / 2) - bounds.left * scale;
    content.style.transform = "scale(" + scale + ")";
    content.style.left = offsetX + "px";
    stage.style.width = availableWidth + "px";
    stage.style.height = Math.ceil(visibleHeight * scale) + "px";
  }

  function scheduleFit() {
    if (pending) return;
    pending = true;
    window.requestAnimationFrame(fitPreviewContent);
  }

  function start() {
    if (!wrapPreviewContent()) return;
    scheduleFit();
    window.addEventListener("resize", scheduleFit);
    window.addEventListener("load", scheduleFit);
    document.addEventListener("load", scheduleFit, true);
    if ("ResizeObserver" in window) {
      resizeObserver = new ResizeObserver(scheduleFit);
      resizeObserver.observe(content);
    }
    if ("MutationObserver" in window) {
      mutationObserver = new MutationObserver(scheduleFit);
      mutationObserver.observe(content, {
        childList: true,
        characterData: true,
        subtree: true
      });
    }
    window.setTimeout(scheduleFit, 60);
    window.setTimeout(scheduleFit, 250);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
</script>`;

const buildEmailPreviewEditorAssets = (variableMap: Record<string, string>) => {
  const lockedVariables = Object.entries(variableMap || {})
    .map(([key, value]) => ({
      key: String(key || "").trim(),
      value: String(value || "").trim(),
    }))
    .filter((entry) => entry.key);

  return `
<style data-email-center-preview-editor-style>
  :root {
    --brand-blue-2: rgb(60, 103, 183);
    --brand-blue-2-rgb: 60, 103, 183;
  }
  .email-center-preview-edit-button {
    align-items: center;
    background: #0b0679;
    border: 0;
    border-radius: 999px;
    box-shadow: 0 10px 25px rgba(15, 23, 42, 0.22);
    color: #ffffff;
    cursor: pointer;
    display: none;
    height: 34px;
    justify-content: center;
    padding: 0;
    position: fixed;
    width: 34px;
    z-index: 2147483647;
  }
  .email-center-preview-edit-button svg {
    height: 17px;
    pointer-events: none;
    width: 17px;
  }
  .email-center-preview-variable-button {
    align-items: center;
    background: rgba(148, 163, 184, 0.12);
    border: 0;
    border-radius: 5px;
    color: rgb(100, 116, 139);
    cursor: pointer;
    display: none;
    font: inherit;
    height: var(--email-center-variable-button-size, 1lh);
    justify-content: center;
    line-height: 1;
    margin: 0 0.18em;
    min-height: 1em;
    min-width: 1em;
    padding: 0;
    position: static;
    transition: background 150ms ease, color 150ms ease, opacity 150ms ease;
    vertical-align: text-bottom;
    width: var(--email-center-variable-button-size, 1lh);
    z-index: 2147483646;
  }
  .email-center-preview-variable-button:hover,
  .email-center-preview-variable-button:focus-visible,
  .email-center-preview-variable-button[data-open="true"] {
    background: rgba(148, 163, 184, 0.2);
    color: rgb(71, 85, 105);
    outline: none;
  }
  .email-center-preview-variable-button svg {
    height: var(--email-center-variable-button-icon-size, 0.66em);
    pointer-events: none;
    width: var(--email-center-variable-button-icon-size, 0.66em);
  }
  .email-center-preview-variable-menu {
    background: rgba(248, 250, 252, 0.98);
    border: 1px solid rgba(148, 163, 184, 0.55);
    border-radius: 12px;
    box-shadow: 0 18px 42px rgba(15, 23, 42, 0.22);
    color: rgb(30, 41, 59);
    display: none;
    max-height: min(18rem, calc(100vh - 2rem));
    min-width: 14rem;
    overflow: auto;
    padding: 0.35rem;
    position: fixed;
    z-index: 2147483646;
  }
  .email-center-preview-variable-menu[data-open="true"] {
    display: grid;
    gap: 0.125rem;
  }
  .email-center-preview-variable-menu__item {
    align-items: center;
    background: transparent;
    border: 0;
    border-radius: 8px;
    color: rgb(51, 65, 85);
    cursor: pointer;
    display: flex;
    font: 600 12px/1.2 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
    justify-content: flex-start;
    padding: 0.5rem 0.65rem;
    text-align: left;
    white-space: nowrap;
    width: 100%;
  }
  .email-center-preview-variable-menu__item:hover,
  .email-center-preview-variable-menu__item:focus-visible {
    background: rgba(var(--brand-blue-2-rgb), 0.12);
    color: var(--brand-blue-2);
    outline: none;
  }
  [data-email-center-edit-target="true"] {
    outline: 2px solid rgba(11, 6, 121, 0.42) !important;
    outline-offset: 3px !important;
  }
  [data-email-center-editing="true"] {
    outline: 2px solid #0b0679 !important;
    outline-offset: 3px !important;
  }
  img[data-email-center-image-uploading="true"] {
    opacity: 0.62 !important;
    outline: 2px solid rgba(60, 103, 183, 0.55) !important;
    outline-offset: 3px !important;
  }
  [data-email-center-variable-state="display"] {
    display: inline !important;
  }
  [data-email-center-variable-state="editing"] {
    align-items: center !important;
    background: rgba(11, 6, 121, 0.1) !important;
    border: 1px solid rgba(11, 6, 121, 0.35) !important;
    border-radius: 999px !important;
    color: #0b0679 !important;
    display: inline-flex !important;
    font: 600 0.82em/1.2 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace !important;
    gap: 0.35em !important;
    margin: 0 0.12em !important;
    padding: 0.08em 0.22em 0.08em 0.45em !important;
    user-select: none !important;
    vertical-align: baseline !important;
    white-space: nowrap !important;
  }
  [data-email-center-variable-state="editing"] [data-email-center-variable-remove] {
    align-items: center !important;
    background: #ffffff !important;
    border: 1px solid rgba(11, 6, 121, 0.35) !important;
    border-radius: 999px !important;
    color: #0b0679 !important;
    cursor: pointer !important;
    display: inline-flex !important;
    font: 700 0.9em/1 Arial, sans-serif !important;
    height: 1.25em !important;
    justify-content: center !important;
    margin: 0 !important;
    padding: 0 !important;
    width: 1.25em !important;
  }
  [data-email-center-variable-state="editing"] [data-email-center-variable-remove]:hover,
  [data-email-center-variable-state="editing"] [data-email-center-variable-remove]:focus-visible {
    background: #0b0679 !important;
    color: #ffffff !important;
    outline: none !important;
  }
</style>
<script data-email-center-preview-editor>
(function () {
  var MESSAGE_TYPE = "trufusion-email-center-preview-edited";
  var IMAGE_UPLOAD_REQUEST_TYPE = "trufusion-email-center-preview-image-upload-request";
  var IMAGE_UPLOAD_RESPONSE_TYPE = "trufusion-email-center-preview-image-upload-response";
  var EDITABLE_SELECTOR = "h1,h2,h3,h4,h5,h6,p,li,a,span,td,th,img";
  var VARIABLES = ${serializeForInlineScript(lockedVariables)};
  var VARIABLE_PLACEHOLDER_PATTERN = /{{\\s*([a-zA-Z0-9_]+)\\s*}}/g;
  var button = document.createElement("button");
  var variableButton = document.createElement("button");
  var variableMenu = document.createElement("div");
  var imageUploadInput = document.createElement("input");
  var activeTarget = null;
  var editingTarget = null;
  var editingRequiredVariableIds = [];
  var editingLastSafeHtml = "";
  var variableMarkerSequence = 0;
  var savedSelectionRange = null;
  var variableMenuOpen = false;
  var variableUiPointerDown = false;
  var suppressNextVariableUiClick = false;
  var imageUploadRequestSequence = 0;
  var pendingImageUploads = {};

  button.type = "button";
  button.className = "email-center-preview-edit-button";
  button.setAttribute("aria-label", "Edit section");
  button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
  variableButton.type = "button";
  variableButton.className = "email-center-preview-variable-button timestamp-chip__add-button";
  variableButton.setAttribute("aria-label", "Add variable");
  variableButton.setAttribute("aria-expanded", "false");
  variableButton.setAttribute("aria-haspopup", "menu");
  variableButton.setAttribute("contenteditable", "false");
  variableButton.setAttribute("title", "Add variable");
  variableButton.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="M5 12h14"/></svg>';
  variableMenu.className = "email-center-preview-variable-menu";
  variableMenu.setAttribute("role", "menu");
  variableMenu.setAttribute("aria-label", "Variables");
  variableMenu.setAttribute("contenteditable", "false");
  imageUploadInput.type = "file";
  imageUploadInput.accept = "image/png,image/jpeg,image/gif,image/webp";
  imageUploadInput.style.display = "none";
  imageUploadInput.setAttribute("aria-hidden", "true");
  document.addEventListener("DOMContentLoaded", function () {
    document.body.appendChild(button);
    document.body.appendChild(variableButton);
    document.body.appendChild(variableMenu);
    document.body.appendChild(imageUploadInput);
  });

  function isInjectedNode(element) {
    return Boolean(
      element &&
      element.closest &&
      element.closest(".email-center-preview-edit-button,.email-center-preview-variable-button,.email-center-preview-variable-menu,script,style,head,meta")
    );
  }

  function isVariableUiTarget(element) {
    return Boolean(
      element &&
      element.closest &&
      element.closest(".email-center-preview-variable-button,.email-center-preview-variable-menu")
    );
  }

  function containsVariableValue(value) {
    var text = String(value || "");
    if (!text) return false;
    VARIABLE_PLACEHOLDER_PATTERN.lastIndex = 0;
    if (VARIABLE_PLACEHOLDER_PATTERN.test(text)) return true;
    return VARIABLES.some(function (variable) {
      return variable.value && text.indexOf(variable.value) !== -1;
    });
  }

  function getVariableByKey(key) {
    key = String(key || "").trim();
    for (var index = 0; index < VARIABLES.length; index += 1) {
      if (VARIABLES[index].key === key) return VARIABLES[index];
    }
    return null;
  }

  function variableLabel(variable) {
    return "{{ " + String(variable.key || "").trim() + " }}";
  }

  function markerVariable(marker) {
    return {
      key: marker.getAttribute("data-email-center-variable") || "",
      value: marker.getAttribute("data-email-center-variable-value") || ""
    };
  }

  function clearElementChildren(element) {
    while (element.firstChild) {
      element.removeChild(element.firstChild);
    }
  }

  function renderEditingVariableMarker(marker) {
    var variable = markerVariable(marker);
    var label = document.createElement("span");
    var removeButton = document.createElement("button");
    clearElementChildren(marker);
    marker.setAttribute("data-email-center-variable-state", "editing");
    marker.setAttribute("contenteditable", "false");
    marker.setAttribute("title", "Variable: " + variable.key);
    label.setAttribute("data-email-center-variable-label", "true");
    label.textContent = variableLabel(variable);
    removeButton.type = "button";
    removeButton.setAttribute("data-email-center-variable-remove", "true");
    removeButton.setAttribute("contenteditable", "false");
    removeButton.setAttribute("aria-label", "Remove " + variableLabel(variable));
    removeButton.textContent = "X";
    marker.appendChild(label);
    marker.appendChild(removeButton);
  }

  function renderDisplayVariableMarker(marker) {
    var variable = markerVariable(marker);
    clearElementChildren(marker);
    marker.setAttribute("data-email-center-variable-state", "display");
    marker.setAttribute("contenteditable", "false");
    marker.setAttribute("title", "Variable: " + variable.key);
    marker.textContent = variable.value || variableLabel(variable);
  }

  function findNextVariableToken(text, startIndex) {
    var best = null;
    VARIABLE_PLACEHOLDER_PATTERN.lastIndex = startIndex;
    var placeholderMatch = VARIABLE_PLACEHOLDER_PATTERN.exec(text);
    if (placeholderMatch) {
      var placeholderVariable = getVariableByKey(placeholderMatch[1]);
      if (placeholderVariable) {
        best = {
          index: placeholderMatch.index,
          length: placeholderMatch[0].length,
          variable: placeholderVariable
        };
      }
    }
    VARIABLES.forEach(function (variable) {
      if (!variable.value) return;
      var valueIndex = text.indexOf(variable.value, startIndex);
      if (valueIndex === -1) return;
      if (!best || valueIndex < best.index || (valueIndex === best.index && variable.value.length > best.length)) {
        best = {
          index: valueIndex,
          length: variable.value.length,
          variable: variable
        };
      }
    });
    return best;
  }

  function makeVariableMarker(variable) {
    var marker = document.createElement("span");
    var id = "email-variable-" + String(variableMarkerSequence += 1);
    marker.setAttribute("data-email-center-variable", variable.key);
    marker.setAttribute("data-email-center-variable-id", id);
    marker.setAttribute("data-email-center-variable-value", variable.value || "");
    renderEditingVariableMarker(marker);
    return marker;
  }

  function hasSelectableVariables() {
    return VARIABLES.length > 0;
  }

  function selectionBelongsToEditingTarget(range) {
    if (!editingTarget || !range) return false;
    var container = range.commonAncestorContainer;
    return container === editingTarget || editingTarget.contains(container.nodeType === 1 ? container : container.parentNode);
  }

  function currentEditingRange() {
    if (!editingTarget) return null;
    var selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return savedSelectionRange && selectionBelongsToEditingTarget(savedSelectionRange)
      ? savedSelectionRange.cloneRange()
      : null;
    var range = selection.getRangeAt(0);
    if (!selectionBelongsToEditingTarget(range)) return savedSelectionRange && selectionBelongsToEditingTarget(savedSelectionRange)
      ? savedSelectionRange.cloneRange()
      : null;
    return range.cloneRange();
  }

  function saveCurrentEditingSelection() {
    var range = currentEditingRange();
    if (!range) return null;
    savedSelectionRange = range.cloneRange();
    return savedSelectionRange;
  }

  function restoreSavedSelection() {
    if (!editingTarget || !savedSelectionRange || !selectionBelongsToEditingTarget(savedSelectionRange)) return false;
    var selection = window.getSelection();
    if (!selection) return false;
    selection.removeAllRanges();
    selection.addRange(savedSelectionRange.cloneRange());
    return true;
  }

  function caretRectForRange(range) {
    if (!range) return null;
    var measuringRange = range.cloneRange();
    measuringRange.collapse(false);
    var rects = measuringRange.getClientRects();
    if (rects && rects.length > 0) {
      return rects[rects.length - 1];
    }
    var marker = document.createElement("span");
    marker.textContent = "\\u200b";
    marker.style.display = "inline-block";
    marker.style.width = "0";
    marker.style.lineHeight = "1";
    measuringRange.insertNode(marker);
    var rect = marker.getBoundingClientRect();
    if (marker.parentNode) {
      marker.parentNode.removeChild(marker);
    }
    restoreSavedSelection();
    return rect;
  }

  function removeVariableButtonFromDocument() {
    if (variableButton.parentNode) {
      variableButton.parentNode.removeChild(variableButton);
    }
    variableButton.style.display = "none";
  }

  function elementForRange(range) {
    if (!range) return editingTarget;
    var node = range.endContainer || range.startContainer;
    if (!node) return editingTarget;
    if (node.nodeType === 1) return node;
    return node.parentElement || editingTarget;
  }

  function lineHeightForRange(range) {
    var element = elementForRange(range);
    var style = window.getComputedStyle(element || editingTarget);
    var lineHeight = parseFloat(style.lineHeight);
    if (!Number.isFinite(lineHeight)) {
      var fontSize = parseFloat(style.fontSize);
      lineHeight = Number.isFinite(fontSize) ? fontSize * 1.2 : 16;
    }
    return Math.max(10, lineHeight);
  }

  function sizeVariableButtonForRange(range) {
    var lineHeight = lineHeightForRange(range);
    variableButton.style.setProperty("--email-center-variable-button-size", lineHeight + "px");
    variableButton.style.setProperty("--email-center-variable-button-icon-size", Math.max(8, lineHeight * 0.62) + "px");
  }

  function closeVariableMenu() {
    variableMenuOpen = false;
    variableMenu.removeAttribute("data-open");
    variableButton.removeAttribute("data-open");
    variableButton.setAttribute("aria-expanded", "false");
  }

  function positionVariableMenu() {
    if (!variableMenuOpen) return;
    var buttonRect = variableButton.getBoundingClientRect();
    var menuWidth = Math.max(variableMenu.offsetWidth || 224, 224);
    var menuHeight = Math.max(variableMenu.offsetHeight || 120, 120);
    var left = Math.max(8, Math.min(window.innerWidth - menuWidth - 8, buttonRect.left));
    var top = buttonRect.bottom + 8;
    if (top + menuHeight > window.innerHeight - 8) {
      top = Math.max(8, buttonRect.top - menuHeight - 8);
    }
    variableMenu.style.left = left + "px";
    variableMenu.style.top = top + "px";
  }

  function positionVariableButton() {
    if (!editingTarget || !hasSelectableVariables()) {
      hideVariableUi();
      return;
    }
    var range = saveCurrentEditingSelection();
    if (!range) {
      hideVariableUi();
      return;
    }
    removeVariableButtonFromDocument();
    sizeVariableButtonForRange(range);
    var insertionRange = range.cloneRange();
    insertionRange.collapse(false);
    insertionRange.insertNode(variableButton);
    variableButton.style.display = "inline-flex";
    restoreSavedSelection();
    positionVariableMenu();
  }

  function hideVariableUi() {
    removeVariableButtonFromDocument();
    closeVariableMenu();
  }

  function renderVariableMenu() {
    while (variableMenu.firstChild) {
      variableMenu.removeChild(variableMenu.firstChild);
    }
    VARIABLES.forEach(function (variable) {
      var option = document.createElement("button");
      option.type = "button";
      option.className = "email-center-preview-variable-menu__item";
      option.setAttribute("role", "menuitem");
      option.setAttribute("data-email-center-variable-option", variable.key);
      option.textContent = variableLabel(variable);
      variableMenu.appendChild(option);
    });
  }

  function openVariableMenu() {
    if (!editingTarget || !hasSelectableVariables()) return;
    renderVariableMenu();
    variableMenuOpen = true;
    variableMenu.setAttribute("data-open", "true");
    variableButton.setAttribute("data-open", "true");
    variableButton.setAttribute("aria-expanded", "true");
    positionVariableMenu();
  }

  function toggleVariableMenu() {
    if (variableMenuOpen) {
      closeVariableMenu();
    } else {
      openVariableMenu();
    }
  }

  function variableFromOption(option) {
    var key = option && option.getAttribute("data-email-center-variable-option");
    return getVariableByKey(key);
  }

  function insertVariableAtCursor(variable) {
    if (!editingTarget || !variable) return;
    restoreSavedSelection();
    var selection = window.getSelection();
    var range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
    if (!selectionBelongsToEditingTarget(range)) {
      placeCaretAtEnd(editingTarget);
      selection = window.getSelection();
      range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
    }
    if (!range) return;
    range.deleteContents();
    var marker = makeVariableMarker(variable);
    var spacer = document.createTextNode(" ");
    range.insertNode(spacer);
    range.insertNode(marker);
    range.setStartAfter(spacer);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    saveCurrentEditingSelection();
    markEditingHtmlSafe();
    postHtmlUpdate();
    closeVariableMenu();
    positionVariableButton();
  }

  function shouldSkipTextNode(node) {
    var parent = node && node.parentElement;
    return Boolean(
      !parent ||
      parent.closest("[data-email-center-variable],script,style,head,meta,.email-center-preview-edit-button,.email-center-preview-variable-button,.email-center-preview-variable-menu")
    );
  }

  function wrapVariablesInTextNode(textNode) {
    if (shouldSkipTextNode(textNode)) return 0;
    var text = textNode.nodeValue || "";
    if (!text.trim()) return 0;
    var fragment = document.createDocumentFragment();
    var cursor = 0;
    var count = 0;
    var match = null;
    while ((match = findNextVariableToken(text, cursor))) {
      if (match.index > cursor) {
        fragment.appendChild(document.createTextNode(text.slice(cursor, match.index)));
      }
      fragment.appendChild(makeVariableMarker(match.variable));
      cursor = match.index + match.length;
      count += 1;
    }
    if (!count) return 0;
    if (cursor < text.length) {
      fragment.appendChild(document.createTextNode(text.slice(cursor)));
    }
    textNode.parentNode.replaceChild(fragment, textNode);
    return count;
  }

  function wrapVariables(target) {
    Array.prototype.slice.call(target.querySelectorAll("[data-email-center-variable]")).forEach(renderEditingVariableMarker);
    var walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
    var nodes = [];
    var node = null;
    while ((node = walker.nextNode())) {
      nodes.push(node);
    }
    return nodes.reduce(function (count, textNode) {
      return count + wrapVariablesInTextNode(textNode);
    }, 0);
  }

  function showVariableMarkersAsDisplay(root) {
    Array.prototype.slice.call(root.querySelectorAll("[data-email-center-variable]")).forEach(renderDisplayVariableMarker);
  }

  function unwrapVariableMarkers(root, usePlaceholders) {
    Array.prototype.slice.call(root.querySelectorAll("[data-email-center-variable]")).forEach(function (marker) {
      var key = marker.getAttribute("data-email-center-variable") || "";
      var value = marker.getAttribute("data-email-center-variable-value") || "";
      var text = usePlaceholders && key ? "{{ " + key + " }}" : value;
      marker.parentNode.replaceChild(document.createTextNode(text), marker);
    });
  }

  function targetHasProtectedVariables(target) {
    return Boolean(target && target.querySelector && target.querySelector("[data-email-center-variable]"));
  }

  function attributeHasVariable(element, attributeName) {
    return containsVariableValue(element.getAttribute && element.getAttribute(attributeName));
  }

  function hasEditableContent(element) {
    if (!element || isInjectedNode(element)) return false;
    if (element.tagName === "IMG") return true;
    var rect = element.getBoundingClientRect();
    if (rect.width < 12 || rect.height < 12) return false;
    return Boolean((element.innerText || element.textContent || "").trim());
  }

  function findEditableTarget(start) {
    var element = start && start.nodeType === 1 ? start : start && start.parentElement;
    while (element && element !== document.documentElement) {
      if (element.hasAttribute && element.hasAttribute("data-email-center-variable")) {
        element = element.parentElement;
        continue;
      }
      if (element.matches && element.matches(EDITABLE_SELECTOR) && hasEditableContent(element)) {
        return element;
      }
      element = element.parentElement;
    }
    return null;
  }

  function clearActiveTarget() {
    if (activeTarget && activeTarget !== editingTarget) {
      activeTarget.removeAttribute("data-email-center-edit-target");
    }
    activeTarget = null;
    button.style.display = "none";
  }

  function positionButton(target) {
    var rect = target.getBoundingClientRect();
    var top = Math.max(8, Math.min(window.innerHeight - 42, rect.top + 8));
    var left = Math.max(8, Math.min(window.innerWidth - 42, rect.right - 42));
    button.style.top = top + "px";
    button.style.left = left + "px";
    button.style.display = "inline-flex";
  }

  function setActiveTarget(target) {
    if (!target || target === activeTarget) {
      if (target) positionButton(target);
      return;
    }
    if (activeTarget && activeTarget !== editingTarget) {
      activeTarget.removeAttribute("data-email-center-edit-target");
    }
    activeTarget = target;
    if (activeTarget !== editingTarget) {
      activeTarget.setAttribute("data-email-center-edit-target", "true");
    }
    positionButton(activeTarget);
  }

  function cleanHtml() {
    var clone = document.documentElement.cloneNode(true);
    clone.querySelectorAll(".email-center-preview-edit-button,.email-center-preview-variable-button,.email-center-preview-variable-menu,[data-email-center-preview-editor],style[data-email-center-preview-editor-style],style[data-email-center-preview-containment],meta[data-email-center-preview-containment],script[data-email-center-preview-containment]").forEach(function (node) {
      node.remove();
    });
    var fitStage = clone.querySelector("[data-email-center-preview-fit-stage]");
    var fitContent = clone.querySelector("[data-email-center-preview-fit-content]");
    if (fitStage && fitContent && fitStage.parentNode) {
      while (fitContent.firstChild) {
        fitStage.parentNode.insertBefore(fitContent.firstChild, fitStage);
      }
      fitStage.remove();
    }
    unwrapVariableMarkers(clone, true);
    clone.querySelectorAll("[data-email-center-edit-target],[data-email-center-editing],[data-email-center-image-uploading],[contenteditable]").forEach(function (node) {
      node.removeAttribute("data-email-center-edit-target");
      node.removeAttribute("data-email-center-editing");
      node.removeAttribute("data-email-center-image-uploading");
      node.removeAttribute("contenteditable");
    });
    clone.removeAttribute("data-email-center-preview-fit-ready");
    return "<!DOCTYPE html>\\n" + clone.outerHTML;
  }

  function postHtmlUpdate() {
    window.parent.postMessage({ type: MESSAGE_TYPE, html: cleanHtml() }, "*");
  }

  function selectTargetContents(target) {
    var selection = window.getSelection();
    if (!selection) return;
    var range = document.createRange();
    range.selectNodeContents(target);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function placeCaretAtEnd(target) {
    var selection = window.getSelection();
    if (!selection) return;
    var range = document.createRange();
    range.selectNodeContents(target);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function selectEditableContents(target) {
    if (targetHasProtectedVariables(target)) {
      placeCaretAtEnd(target);
      return;
    }
    selectTargetContents(target);
  }

  function promptImageAlt(target) {
    if (!target || attributeHasVariable(target, "alt")) return;
    var nextAlt = window.prompt("Image alt text", target.getAttribute("alt") || "");
    if (nextAlt !== null) {
      target.setAttribute("alt", nextAlt);
    }
  }

  function requestImageReplacement(target) {
    if (!target || target.tagName !== "IMG") return;
    var requestId = "image_upload_" + String(imageUploadRequestSequence += 1) + "_" + String(Date.now());
    pendingImageUploads[requestId] = target;
    imageUploadInput.value = "";
    imageUploadInput.onchange = function () {
      var file = imageUploadInput.files && imageUploadInput.files[0];
      if (!file) {
        delete pendingImageUploads[requestId];
        return;
      }
      target.setAttribute("data-email-center-image-uploading", "true");
      window.parent.postMessage({
        type: IMAGE_UPLOAD_REQUEST_TYPE,
        requestId: requestId,
        file: file,
        filename: file.name || "",
        mimeType: file.type || ""
      }, "*");
    };
    imageUploadInput.click();
  }

  function stopEditing() {
    if (!editingTarget) return;
    editingTarget.removeAttribute("contenteditable");
    editingTarget.removeAttribute("data-email-center-editing");
    if (editingTarget !== activeTarget) {
      editingTarget.removeAttribute("data-email-center-edit-target");
    }
    postHtmlUpdate();
    showVariableMarkersAsDisplay(editingTarget);
    editingTarget = null;
    editingRequiredVariableIds = [];
    editingLastSafeHtml = "";
    savedSelectionRange = null;
    hideVariableUi();
  }

  function startEditing(target) {
    if (!target) return;
    if (target.tagName === "IMG") {
      requestImageReplacement(target);
      return;
    }
    if (target.tagName === "A" && !attributeHasVariable(target, "href")) {
      var nextHref = window.prompt("Link URL", target.getAttribute("href") || "");
      if (nextHref !== null) {
        target.setAttribute("href", nextHref.trim());
      }
    }
    stopEditing();
    editingTarget = target;
    wrapVariables(editingTarget);
    editingRequiredVariableIds = Array.prototype.slice.call(editingTarget.querySelectorAll("[data-email-center-variable]")).map(function (marker) {
      return marker.getAttribute("data-email-center-variable-id") || "";
    }).filter(Boolean);
    editingLastSafeHtml = editingTarget.innerHTML;
    editingTarget.setAttribute("contenteditable", "true");
    editingTarget.setAttribute("data-email-center-editing", "true");
    editingTarget.setAttribute("data-email-center-edit-target", "true");
    editingTarget.focus({ preventScroll: true });
    selectEditableContents(editingTarget);
    saveCurrentEditingSelection();
    positionVariableButton();
  }

  function getRequiredVariableMarker(id) {
    return editingTarget ? editingTarget.querySelector('[data-email-center-variable-id="' + id + '"]') : null;
  }

  function hasRequiredVariableMarkers() {
    return editingRequiredVariableIds.every(function (id) {
      var marker = getRequiredVariableMarker(id);
      var key = marker ? marker.getAttribute("data-email-center-variable") || "" : "";
      var label = marker ? marker.querySelector("[data-email-center-variable-label]") : null;
      return Boolean(
        marker &&
        marker.getAttribute("contenteditable") === "false" &&
        marker.getAttribute("data-email-center-variable-state") === "editing" &&
        key &&
        label &&
        label.textContent === variableLabel({ key: key })
      );
    });
  }

  function editingHtmlWithoutPreviewChrome() {
    if (!editingTarget) return "";
    var clone = editingTarget.cloneNode(true);
    clone.querySelectorAll(".email-center-preview-variable-button,.email-center-preview-variable-menu").forEach(function (node) {
      node.remove();
    });
    return clone.innerHTML;
  }

  function markEditingHtmlSafe() {
    if (!editingTarget) return;
    editingLastSafeHtml = editingHtmlWithoutPreviewChrome();
  }

  function removeRequiredVariableId(id) {
    editingRequiredVariableIds = editingRequiredVariableIds.filter(function (existingId) {
      return existingId !== id;
    });
  }

  function removeVariableMarker(marker) {
    if (!editingTarget || !marker) return;
    var key = marker.getAttribute("data-email-center-variable") || "";
    var label = key ? "{{ " + key + " }}" : "this variable";
    if (!window.confirm("Remove " + label + " from this email section?")) return;
    removeRequiredVariableId(marker.getAttribute("data-email-center-variable-id") || "");
    marker.parentNode.removeChild(marker);
    markEditingHtmlSafe();
    postHtmlUpdate();
    placeCaretAtEnd(editingTarget);
  }

  function restoreLastSafeEditingHtml() {
    if (!editingTarget || !editingLastSafeHtml) return;
    editingTarget.innerHTML = editingLastSafeHtml;
    placeCaretAtEnd(editingTarget);
  }

  function nodeTouchesVariable(node) {
    if (!node) return false;
    if (node.nodeType === 1) {
      if (node.matches && node.matches("[data-email-center-variable]")) return true;
      return Boolean(node.querySelector && node.querySelector("[data-email-center-variable]"));
    }
    return Boolean(node.parentElement && node.parentElement.closest("[data-email-center-variable]"));
  }

  function rangeTouchesVariable(range) {
    if (!editingTarget) return false;
    var markers = Array.prototype.slice.call(editingTarget.querySelectorAll("[data-email-center-variable]"));
    return markers.some(function (marker) {
      try {
        return range.intersectsNode(marker);
      } catch (_error) {
        return false;
      }
    });
  }

  function deepestBoundaryNode(node, direction) {
    var current = node;
    while (current && current.nodeType === 1 && current.childNodes && current.childNodes.length) {
      current = direction === "backward"
        ? current.childNodes[current.childNodes.length - 1]
        : current.childNodes[0];
    }
    return current;
  }

  function previousNode(node) {
    if (!node || node === editingTarget) return null;
    if (node.previousSibling) return deepestBoundaryNode(node.previousSibling, "backward");
    return previousNode(node.parentNode);
  }

  function nextNode(node) {
    if (!node || node === editingTarget) return null;
    if (node.nextSibling) return deepestBoundaryNode(node.nextSibling, "forward");
    return nextNode(node.parentNode);
  }

  function adjacentCaretNode(range, direction) {
    var container = range.startContainer;
    var offset = range.startOffset;
    if (container.nodeType === 3) {
      if (direction === "backward") {
        return offset > 0 ? null : previousNode(container);
      }
      return offset < (container.nodeValue || "").length ? null : nextNode(container);
    }
    if (container.nodeType === 1) {
      if (direction === "backward") {
        return offset > 0
          ? deepestBoundaryNode(container.childNodes[offset - 1], "backward")
          : previousNode(container);
      }
      return offset < container.childNodes.length
        ? deepestBoundaryNode(container.childNodes[offset], "forward")
        : nextNode(container);
    }
    return null;
  }

  function selectionTouchesVariable(inputType) {
    if (!editingTarget) return false;
    var selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return false;
    for (var index = 0; index < selection.rangeCount; index += 1) {
      var range = selection.getRangeAt(index);
      if (!editingTarget.contains(range.commonAncestorContainer)) continue;
      if (!range.collapsed && rangeTouchesVariable(range)) return true;
      if (range.collapsed && inputType === "deleteContentBackward" && nodeTouchesVariable(adjacentCaretNode(range, "backward"))) return true;
      if (range.collapsed && inputType === "deleteContentForward" && nodeTouchesVariable(adjacentCaretNode(range, "forward"))) return true;
    }
    return false;
  }

  window.addEventListener("message", function (event) {
    var data = event.data || {};
    if (!data || data.type !== IMAGE_UPLOAD_RESPONSE_TYPE) return;
    var requestId = String(data.requestId || "");
    var target = pendingImageUploads[requestId];
    if (!target) return;
    delete pendingImageUploads[requestId];
    target.removeAttribute("data-email-center-image-uploading");
    if (!data.ok) {
      window.alert(String(data.error || "Image upload failed."));
      return;
    }
    var url = String(data.url || "").trim();
    if (!url) {
      window.alert("Image upload did not return a usable URL.");
      return;
    }
    target.setAttribute("src", url);
    target.removeAttribute("srcset");
    target.removeAttribute("data-src");
    promptImageAlt(target);
    postHtmlUpdate();
  });

  document.addEventListener("mousemove", function (event) {
    if (editingTarget || event.target === button || button.contains(event.target)) return;
    var target = findEditableTarget(event.target);
    if (target) {
      setActiveTarget(target);
    } else {
      clearActiveTarget();
    }
  });

  document.addEventListener("mouseleave", function () {
    if (!editingTarget) clearActiveTarget();
  });

  document.addEventListener("pointerdown", function (event) {
    var removeButton = event.target && event.target.closest && event.target.closest("[data-email-center-variable-remove]");
    if (!removeButton) return;
    event.preventDefault();
  }, true);

  document.addEventListener("pointerdown", function (event) {
    if (isVariableUiTarget(event.target)) {
      variableUiPointerDown = true;
      suppressNextVariableUiClick = true;
      window.setTimeout(function () {
        variableUiPointerDown = false;
      }, 0);
      window.setTimeout(function () {
        suppressNextVariableUiClick = false;
      }, 400);
      event.preventDefault();
      event.stopPropagation();
      if (event.stopImmediatePropagation) {
        event.stopImmediatePropagation();
      }
      var option = event.target && event.target.closest && event.target.closest("[data-email-center-variable-option]");
      if (option) {
        insertVariableAtCursor(variableFromOption(option));
        return;
      }
      if (event.target === variableButton || variableButton.contains(event.target)) {
        restoreSavedSelection();
        toggleVariableMenu();
      }
      return;
    }
    if (variableMenuOpen) {
      closeVariableMenu();
    }
  }, true);

  document.addEventListener("click", function (event) {
    var removeButton = event.target && event.target.closest && event.target.closest("[data-email-center-variable-remove]");
    if (!removeButton) return;
    event.preventDefault();
    event.stopPropagation();
    removeVariableMarker(removeButton.closest("[data-email-center-variable]"));
  }, true);

  document.addEventListener("click", function (event) {
    if (!isVariableUiTarget(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.stopImmediatePropagation) {
      event.stopImmediatePropagation();
    }
    if (suppressNextVariableUiClick) {
      suppressNextVariableUiClick = false;
      return;
    }
    var option = event.target && event.target.closest && event.target.closest("[data-email-center-variable-option]");
    if (option) {
      insertVariableAtCursor(variableFromOption(option));
      return;
    }
    if (event.target === variableButton || variableButton.contains(event.target)) {
      restoreSavedSelection();
      toggleVariableMenu();
    }
  }, true);

  document.addEventListener("selectionchange", function () {
    if (!editingTarget) return;
    window.requestAnimationFrame(positionVariableButton);
  });

  document.addEventListener("beforeinput", function (event) {
    if (!editingTarget) return;
    if (selectionTouchesVariable(event.inputType || "")) {
      event.preventDefault();
    }
  }, true);

  document.addEventListener("input", function () {
    if (!editingTarget) return;
    if (!hasRequiredVariableMarkers()) {
      restoreLastSafeEditingHtml();
      return;
    }
    markEditingHtmlSafe();
    postHtmlUpdate();
    saveCurrentEditingSelection();
    positionVariableButton();
  }, true);

  document.addEventListener("keydown", function (event) {
    if (!editingTarget) return;
    if (event.key === "Backspace" && selectionTouchesVariable("deleteContentBackward")) {
      event.preventDefault();
      return;
    }
    if (event.key === "Delete" && selectionTouchesVariable("deleteContentForward")) {
      event.preventDefault();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      if (variableMenuOpen) {
        closeVariableMenu();
        return;
      }
      stopEditing();
      clearActiveTarget();
    }
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      stopEditing();
    }
    window.setTimeout(positionVariableButton, 0);
  });

  document.addEventListener("focusout", function (event) {
    if (variableUiPointerDown) return;
    if (editingTarget && !editingTarget.contains(event.relatedTarget) && !isVariableUiTarget(event.relatedTarget)) {
      window.setTimeout(stopEditing, 0);
    }
  }, true);

  document.addEventListener("mouseup", function () {
    if (!editingTarget) return;
    saveCurrentEditingSelection();
    positionVariableButton();
  }, true);

  document.addEventListener("keyup", function () {
    if (!editingTarget) return;
    saveCurrentEditingSelection();
    positionVariableButton();
  }, true);

  window.addEventListener("scroll", positionVariableButton, true);
  window.addEventListener("resize", positionVariableButton);

  button.addEventListener("click", function (event) {
    event.preventDefault();
    event.stopPropagation();
    startEditing(activeTarget);
  });
})();
</script>`;
};

const buildEmailPreviewSrcDoc = (
  html: string,
  options: { editable?: boolean; variables?: Record<string, string> } = {},
) => {
  const source = html.trim() || EMPTY_EMAIL_PREVIEW_HTML;
  const headAssets = options.editable
    ? `${EMAIL_PREVIEW_CONTAINMENT_HEAD}${buildEmailPreviewEditorAssets(options.variables || {})}`
    : EMAIL_PREVIEW_CONTAINMENT_HEAD;
  let nextSource = source;
  if (/<\/head\s*>/i.test(source)) {
    nextSource = source.replace(/<\/head\s*>/i, `${headAssets}</head>`);
  } else if (/<html[^>]*>/i.test(source)) {
    nextSource = source.replace(/<html([^>]*)>/i, `<html$1><head>${headAssets}</head>`);
  } else {
    nextSource = `<!doctype html><html><head>${headAssets}</head><body>${source}</body></html>`;
  }
  return nextSource;
};

const parseRecipientEmails = (value: string) =>
  Array.from(
    new Set(
      value
        .split(/[\s,;]+/)
        .map((entry) => entry.trim().toLowerCase())
        .filter((entry) => entry.includes("@")),
    ),
  );

const firstText = (...values: unknown[]) =>
  values
    .map((value) => String(value || "").trim())
    .find(Boolean) || "";

const getRecipientClinicName = (recipient: RecipientPreview) =>
  firstText(
    (recipient as any).clinicName,
    (recipient as any).clinic_name,
    (recipient as any).officeName,
    (recipient as any).office_name,
    (recipient as any).practiceName,
    (recipient as any).practice_name,
    (recipient as any).companyName,
    (recipient as any).company_name,
    (recipient as any).company,
    (recipient as any).npiClinicName,
    (recipient as any).npi_clinic_name,
  );

const previewVariablesForRecipient = (recipient: RecipientPreview): Record<string, string> => {
  const type = String(recipient.type || "").trim().toLowerCase();
  const name = String(recipient.name || "").trim();
  const email = String(recipient.email || "").trim();
  const suppliedVariables = recipient.variables && typeof recipient.variables === "object" ? recipient.variables : {};
  const isSample = type === "sample";
  const defaultName = isSample
    ? SAMPLE_VALUES.doctor_name
    : type === "physician" || type === "doctor"
      ? "Doctor"
      : "there";
  return {
    doctor_name: suppliedVariables.doctor_name || name || defaultName,
    clinic_name: suppliedVariables.clinic_name || getRecipientClinicName(recipient) || (isSample ? SAMPLE_VALUES.clinic_name : "your practice"),
    delegate_links_url: suppliedVariables.delegate_links_url || SAMPLE_VALUES.delegate_links_url,
    unsubscribe_url: suppliedVariables.unsubscribe_url || (email
      ? `${SAMPLE_VALUES.unsubscribe_url}&email=${encodeURIComponent(email)}`
      : SAMPLE_VALUES.unsubscribe_url),
  };
};

const previewRecipientLabel = (recipient: RecipientPreview) => {
  const name = String(recipient.name || "").trim();
  const email = String(recipient.email || "").trim();
  if (name && email) return `${name} (${email})`;
  return email || name || "Sample recipient";
};

const toPreviewRecipientOption = (
  recipient: RecipientPreview,
  idPrefix: string,
  index: number,
): PreviewRecipientOption => {
  const email = String(recipient.email || "").trim();
  const name = String(recipient.name || "").trim();
  const type = String(recipient.type || "").trim() || "custom";
  const normalized: RecipientPreview = { ...recipient, email, name, type };
  return {
    ...normalized,
    id: `${idPrefix}:${email || name || index}`,
    label: previewRecipientLabel(normalized),
    variables: previewVariablesForRecipient(normalized),
  };
};

const getCampaignProgress = (campaign: EmailCenterCampaign) => {
  const counts = campaign.counts || {};
  const sent = Number(counts.sent || 0);
  const failed = Number(counts.failed || 0) + Number(counts.bounced || 0);
  const unsubscribed = Number(counts.unsubscribed || 0);
  const pending = Number(counts.pending || 0);
  const processing = Number(counts.processing || 0);
  const checking = Number(counts.sent_pending_bounce_check || 0);
  const total = Math.max(Number(campaign.recipientCount || 0), sent + failed + unsubscribed + pending + processing + checking, 0);
  const completed = Math.min(total, sent + failed + unsubscribed);
  const percent = total > 0 ? Math.round((completed / total) * 100) : 0;
  const segment = (value: number) => (total > 0 ? `${Math.max(0, Math.min(100, (value / total) * 100))}%` : "0%");
  return {
    sent,
    failed,
    unsubscribed,
    pending,
    processing,
    checking,
    total,
    completed,
    percent,
    sentWidth: segment(sent),
    failedWidth: segment(failed),
    unsubscribedWidth: segment(unsubscribed),
  };
};

const campaignMatchesView = (campaign: EmailCenterCampaign, status?: string) => {
  if (!status || status === "logs") return true;
  if (status === "sent") {
    return campaign.status === "sending" || campaign.status === "sent";
  }
  return campaign.status === status;
};

type ScrollElementSnapshot = {
  element: Element;
  scrollLeft: number;
  scrollTop: number;
};

type PreviewScrollSnapshot = {
  id: number;
  frameX: number;
  frameY: number;
  windowX: number;
  windowY: number;
  elements: ScrollElementSnapshot[];
};

export function EmailCenter() {
  const [activeTab, setActiveTab] = useState<CampaignTab>("new");
  const [emailTypes, setEmailTypes] = useState<EmailTypeOption[]>([]);
  const [templates, setTemplates] = useState<EmailCenterTemplate[]>([]);
  const [selectedType, setSelectedType] = useState("announcement");
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [subject, setSubject] = useState("");
  const [variables, setVariables] = useState<Record<string, string>>({});
  const [previewHtml, setPreviewHtml] = useState("");
  const [previewLoading, setPreviewLoading] = useState(false);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [templateError, setTemplateError] = useState<string | null>(null);
  const [recipientMode, setRecipientMode] = useState<RecipientMode>("test");
  const [previewRecipientKey, setPreviewRecipientKey] = useState(SHOW_VARIABLES_PREVIEW_RECIPIENT.id);
  const [testEmail, setTestEmail] = useState("");
  const [selectedPhysicianEmail, setSelectedPhysicianEmail] = useState("");
  const [customEmails, setCustomEmails] = useState("");
  const [ccRecipients, setCcRecipients] = useState("");
  const [bccRecipients, setBccRecipients] = useState("");
  const [testRecipientEmail, setTestRecipientEmail] = useState("");
  const [testToken, setTestToken] = useState("");
  const [testTokenExpiresAt, setTestTokenExpiresAt] = useState<string | null>(null);
  const [sendingTest, setSendingTest] = useState(false);
  const [confirmationText, setConfirmationText] = useState("");
  const [scheduledAt, setScheduledAt] = useState("");
  const [savingCampaign, setSavingCampaign] = useState(false);
  const [pendingCampaignMode, setPendingCampaignMode] = useState<"send" | "schedule" | null>(null);
  const [pendingPreparedDraft, setPendingPreparedDraft] = useState<EmailCenterCampaign | null>(null);
  const [deletingCampaignId, setDeletingCampaignId] = useState<string | null>(null);
  const [campaigns, setCampaigns] = useState<EmailCenterCampaign[]>([]);
  const [campaignsLoading, setCampaignsLoading] = useState(false);
  const [campaignsRefreshing, setCampaignsRefreshing] = useState(false);
  const [campaignError, setCampaignError] = useState<string | null>(null);
  const [bulkRecipientEstimate, setBulkRecipientEstimate] = useState<{
    count: number | null;
    recipients: RecipientPreview[];
    loading: boolean;
    error: string | null;
  }>({ count: null, recipients: [], loading: false, error: null });
  const emailCenterRootRef = useRef<HTMLElement | null>(null);
  const scheduledAtInputRef = useRef<HTMLInputElement | null>(null);
  const scheduledAtDraftRef = useRef("");
  const emailCenterTabsContainerRef = useRef<HTMLDivElement | null>(null);
  const editablePreviewFrameRef = useRef<HTMLIFrameElement | null>(null);
  const editedPreviewHtmlRef = useRef("");
  const pendingDraftCustomHtmlRef = useRef("");
  const pendingEmailCampaignRefreshRef = useRef(false);
  const pendingPreviewScrollRestoreRef = useRef<PreviewScrollSnapshot | null>(null);
  const previewScrollRestoreSequenceRef = useRef(0);
  const hasCampaignRowsRef = useRef(false);
  const [previewEdited, setPreviewEdited] = useState(false);
  const [emailCenterTabIndicator, setEmailCenterTabIndicator] = useState<{
    left: number;
    width: number;
    opacity: number;
  }>({ left: 0, width: 0, opacity: 0 });

  const resetPreviewEdits = useCallback(() => {
    editedPreviewHtmlRef.current = "";
    setPreviewEdited(false);
  }, []);

  const getCustomHtmlOverride = useCallback(
    () => (previewEdited ? editedPreviewHtmlRef.current.trim() : ""),
    [previewEdited],
  );

  const capturePreviewScrollSnapshot = useCallback((): PreviewScrollSnapshot => {
    const scrollElements = new Map<Element, ScrollElementSnapshot>();
    const addScrollElement = (element: Element | null | undefined) => {
      if (!element || scrollElements.has(element)) return;
      scrollElements.set(element, {
        element,
        scrollLeft: element.scrollLeft,
        scrollTop: element.scrollTop,
      });
    };

    addScrollElement(document.scrollingElement);
    let parent = emailCenterRootRef.current?.parentElement || null;
    while (parent) {
      if (parent.scrollHeight > parent.clientHeight || parent.scrollWidth > parent.clientWidth) {
        addScrollElement(parent);
      }
      parent = parent.parentElement;
    }

    let frameX = 0;
    let frameY = 0;
    try {
      const frameWindow = editablePreviewFrameRef.current?.contentWindow;
      const frameDocument = frameWindow?.document;
      frameX = frameWindow?.scrollX ?? frameDocument?.documentElement?.scrollLeft ?? 0;
      frameY = frameWindow?.scrollY ?? frameDocument?.documentElement?.scrollTop ?? 0;
    } catch (_error) {
      frameX = 0;
      frameY = 0;
    }

    return {
      id: previewScrollRestoreSequenceRef.current + 1,
      frameX,
      frameY,
      windowX: window.scrollX,
      windowY: window.scrollY,
      elements: Array.from(scrollElements.values()),
    };
  }, []);

  const restorePreviewScrollSnapshot = useCallback((snapshot: PreviewScrollSnapshot) => {
    if (pendingPreviewScrollRestoreRef.current?.id !== snapshot.id) return;
    snapshot.elements.forEach(({ element, scrollLeft, scrollTop }) => {
      element.scrollLeft = scrollLeft;
      element.scrollTop = scrollTop;
    });
    window.scrollTo(snapshot.windowX, snapshot.windowY);
    try {
      const frameWindow = editablePreviewFrameRef.current?.contentWindow;
      frameWindow?.scrollTo(snapshot.frameX, snapshot.frameY);
    } catch (_error) {
      // Ignore iframe restore failures; the outer page scroll still needs to remain stable.
    }
  }, []);

  const schedulePreviewScrollRestore = useCallback(
    (snapshot: PreviewScrollSnapshot) => {
      restorePreviewScrollSnapshot(snapshot);
      window.requestAnimationFrame(() => {
        restorePreviewScrollSnapshot(snapshot);
        window.requestAnimationFrame(() => restorePreviewScrollSnapshot(snapshot));
      });
      window.setTimeout(() => restorePreviewScrollSnapshot(snapshot), 80);
      window.setTimeout(() => {
        restorePreviewScrollSnapshot(snapshot);
        if (pendingPreviewScrollRestoreRef.current?.id === snapshot.id) {
          pendingPreviewScrollRestoreRef.current = null;
        }
      }, 300);
    },
    [restorePreviewScrollSnapshot],
  );

  const handlePreviewRecipientChange = useCallback(
    (nextPreviewRecipientKey: string) => {
      const snapshot = capturePreviewScrollSnapshot();
      previewScrollRestoreSequenceRef.current = snapshot.id;
      pendingPreviewScrollRestoreRef.current = snapshot;
      setPreviewRecipientKey(nextPreviewRecipientKey);
      schedulePreviewScrollRestore(snapshot);
    },
    [capturePreviewScrollSnapshot, schedulePreviewScrollRestore],
  );

  const handleEditablePreviewFrameLoad = useCallback(() => {
    const snapshot = pendingPreviewScrollRestoreRef.current;
    if (snapshot) {
      schedulePreviewScrollRestore(snapshot);
    }
  }, [schedulePreviewScrollRestore]);

  const updateEmailCenterTabIndicator = useCallback(() => {
    const container = emailCenterTabsContainerRef.current;
    if (!container) return;
    const activeBtn =
      container.querySelector<HTMLButtonElement>(`button[data-email-center-tab="${activeTab}"]`)
      || container.querySelector<HTMLButtonElement>("button[data-email-center-tab]");
    if (!activeBtn) return;
    const inset = 8;
    const scrollLeft = container.scrollLeft || 0;
    const left = Math.max(0, activeBtn.offsetLeft - scrollLeft + inset);
    const width = Math.max(0, activeBtn.offsetWidth - inset * 2);
    setEmailCenterTabIndicator({ left, width, opacity: 1 });
  }, [activeTab]);

  const setEmailCenterTabsContainerRef = useCallback(
    (node: HTMLDivElement | null) => {
      emailCenterTabsContainerRef.current = node;
      if (!node) return;
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          updateEmailCenterTabIndicator();
        });
      });
    },
    [updateEmailCenterTabIndicator],
  );

  const navigateToCampaignTab = useCallback((tab: CampaignTab) => {
    setActiveTab(tab);
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        emailCenterRootRef.current?.scrollIntoView({ block: "start", inline: "nearest" });
        emailCenterTabsContainerRef.current
          ?.querySelector<HTMLButtonElement>(`button[data-email-center-tab="${tab}"]`)
          ?.scrollIntoView({ block: "nearest", inline: "center" });
      });
    });
  }, []);

  useEffect(() => {
    const handlePreviewEditorMessage = (event: MessageEvent) => {
      if (event.source !== editablePreviewFrameRef.current?.contentWindow) return;
      const data = event.data as {
        type?: string;
        html?: unknown;
        requestId?: unknown;
        file?: unknown;
      } | null;
      if (!data) return;
      if (data.type === "trufusion-email-center-preview-edited") {
        editedPreviewHtmlRef.current = String(data.html || "");
        setPreviewEdited(true);
        setTestToken("");
        setTestTokenExpiresAt(null);
        return;
      }
      if (data.type !== "trufusion-email-center-preview-image-upload-request") return;
      const requestId = String(data.requestId || "");
      const sourceWindow = event.source as Window | null;
      const respond = (payload: Record<string, unknown>) => {
        sourceWindow?.postMessage(
          {
            type: "trufusion-email-center-preview-image-upload-response",
            requestId,
            ...payload,
          },
          "*",
        );
      };
      if (!requestId) return;
      if (typeof File === "undefined" || !(data.file instanceof File)) {
        respond({ ok: false, error: "Select a valid image file." });
        return;
      }
      void emailCenterAPI
        .uploadImageAsset(data.file)
        .then((response: any) => {
          const url = String(response?.url || "").trim();
          if (!url) {
            throw new Error("Image upload did not return a URL.");
          }
          respond({ ok: true, url });
        })
        .catch((error) => {
          const message = getErrorMessage(error);
          respond({ ok: false, error: message });
          toast.error(message);
        });
    };
    window.addEventListener("message", handlePreviewEditorMessage);
    return () => window.removeEventListener("message", handlePreviewEditorMessage);
  }, []);

  const selectedTemplate = useMemo(
    () => templates.find((template) => template.id === selectedTemplateId) || null,
    [selectedTemplateId, templates],
  );

  const allowedRecipientOptions = useMemo(() => {
    const allowedGroups = new Set(
      Array.isArray(selectedTemplate?.allowed_recipient_groups)
        ? selectedTemplate.allowed_recipient_groups.map((group) => String(group || "").trim()).filter(Boolean)
        : [],
    );
    if (allowedGroups.size === 0) return RECIPIENT_OPTIONS;
    return RECIPIENT_OPTIONS.filter((option) => allowedGroups.has(RECIPIENT_MODE_TO_GROUP[option.id]));
  }, [selectedTemplate]);

  const selectedRecipientOption = useMemo(
    () => allowedRecipientOptions.find((option) => option.id === recipientMode) || allowedRecipientOptions[0] || null,
    [allowedRecipientOptions, recipientMode],
  );

  const templatesForType = useMemo(
    () => templates.filter((template) => templateCampaignType(template) === selectedType),
    [selectedType, templates],
  );

  const effectiveTestRecipientEmail = useMemo(
    () => testEmail.trim() || testRecipientEmail.trim(),
    [testEmail, testRecipientEmail],
  );

  const isBulkRecipientMode = recipientMode === "all_verified_physicians" || recipientMode === "sales_reps";
  const requiresPreflightTest = recipientMode !== "test";

  const previewRecipientOptions = useMemo(() => {
    let recipients: RecipientPreview[] = [];
    if (recipientMode === "test") {
      const email = effectiveTestRecipientEmail.trim();
      if (email) {
        recipients = [{ email, name: "Test Recipient", type: "test" }];
      }
    } else if (recipientMode === "selected_physician") {
      const email = selectedPhysicianEmail.trim();
      if (email) {
        recipients = [{ email, type: "physician" }];
      }
    } else if (recipientMode === "custom") {
      recipients = parseRecipientEmails(customEmails).map((email) => ({ email, type: "custom" }));
    } else if (isBulkRecipientMode) {
      recipients = bulkRecipientEstimate.recipients;
    }

    if (recipients.length === 0) {
      recipients = [{ email: "", name: SAMPLE_VALUES.doctor_name, type: "sample" }];
    }

    return [
      SHOW_VARIABLES_PREVIEW_RECIPIENT,
      ...recipients.map((recipient, index) => toPreviewRecipientOption(recipient, recipientMode, index)),
    ];
  }, [
    bulkRecipientEstimate.recipients,
    customEmails,
    effectiveTestRecipientEmail,
    isBulkRecipientMode,
    recipientMode,
    selectedPhysicianEmail,
  ]);

  useEffect(() => {
    if (previewRecipientOptions.some((option) => option.id === previewRecipientKey)) {
      return;
    }
    setPreviewRecipientKey(previewRecipientOptions[0]?.id || SHOW_VARIABLES_PREVIEW_RECIPIENT.id);
  }, [previewRecipientKey, previewRecipientOptions]);

  const selectedPreviewRecipient = useMemo(
    () => previewRecipientOptions.find((option) => option.id === previewRecipientKey) || previewRecipientOptions[0] || null,
    [previewRecipientKey, previewRecipientOptions],
  );

  const previewVariables = useMemo(() => {
    if (selectedPreviewRecipient?.type === SHOW_VARIABLES_PREVIEW_RECIPIENT.type) {
      return Object.fromEntries(
        getTemplateVariables(selectedTemplate).map((variable) => [variable, `{{ ${variable} }}`]),
      );
    }
    const nextVariables = { ...variables };
    const templateVariables = new Set(getTemplateVariables(selectedTemplate));
    const selectedVariables = selectedPreviewRecipient?.variables || {};
    Array.from(RECIPIENT_DYNAMIC_VARIABLE_KEYS).forEach((key) => {
      if (templateVariables.has(key) && selectedVariables[key]) {
        nextVariables[key] = selectedVariables[key];
      }
    });
    return nextVariables;
  }, [selectedPreviewRecipient, selectedTemplate, variables]);

  const templatePreviewSrcDoc = useMemo(() => buildEmailPreviewSrcDoc(previewHtml), [previewHtml]);
  const editablePreviewSrcDoc = useMemo(
    () => buildEmailPreviewSrcDoc(previewHtml, { editable: true, variables: previewVariables }),
    [previewHtml, previewVariables],
  );

  const recipientEstimate = useMemo(() => {
    if (recipientMode === "test") return effectiveTestRecipientEmail ? "1" : "0";
    if (recipientMode === "selected_physician") return selectedPhysicianEmail.trim() ? "1" : "0";
    if (recipientMode === "custom") return formatCount(countCustomEmails(customEmails));
    if (isBulkRecipientMode) {
      if (bulkRecipientEstimate.loading) return "Loading...";
      if (bulkRecipientEstimate.error) return "Unavailable";
      return formatCount(bulkRecipientEstimate.count ?? 0);
    }
    return "0";
  }, [
    bulkRecipientEstimate.count,
    bulkRecipientEstimate.error,
    bulkRecipientEstimate.loading,
    customEmails,
    effectiveTestRecipientEmail,
    isBulkRecipientMode,
    recipientMode,
    selectedPhysicianEmail,
  ]);

  const loadTemplates = useCallback(async () => {
    setTemplatesLoading(true);
    setTemplateError(null);
    try {
      const response = (await emailCenterAPI.getTemplates()) as any;
      const nextTemplates = Array.isArray(response?.templates) ? response.templates : [];
      const nextTypes = Array.isArray(response?.emailTypes) ? response.emailTypes : [];
      setTemplates(nextTemplates);
      setEmailTypes(nextTypes);
      const first = nextTemplates.find((template: EmailCenterTemplate) => template.id === "delegate_links_announcement")
        || nextTemplates[0];
      if (first) {
        setSelectedType(templateCampaignType(first) || "announcement");
        setSelectedTemplateId(first.id);
      }
    } catch (error) {
      setTemplateError(getErrorMessage(error));
    } finally {
      setTemplatesLoading(false);
    }
  }, []);

  const loadCampaigns = useCallback(async (status?: string, options?: { silent?: boolean }) => {
    const silent = options?.silent === true;
    if (!silent) {
      setCampaignsLoading(true);
    } else {
      setCampaignsRefreshing(true);
    }
    setCampaignError(null);
    try {
      const response = (await emailCenterAPI.listCampaigns(status && status !== "logs" ? status : undefined)) as any;
      const nextCampaigns = Array.isArray(response?.campaigns) ? response.campaigns : [];
      hasCampaignRowsRef.current = nextCampaigns.length > 0;
      setCampaigns(nextCampaigns);
    } catch (error) {
      setCampaignError(getErrorMessage(error));
    } finally {
      if (!silent) {
        setCampaignsLoading(false);
      } else {
        setCampaignsRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    void loadTemplates();
    void loadCampaigns();
  }, [loadCampaigns, loadTemplates]);

  useLayoutEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        updateEmailCenterTabIndicator();
      });
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [updateEmailCenterTabIndicator]);

  useEffect(() => {
    updateEmailCenterTabIndicator();
    const onResize = () => updateEmailCenterTabIndicator();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
    };
  }, [updateEmailCenterTabIndicator]);

  useEffect(() => {
    const container = emailCenterTabsContainerRef.current;
    if (!container) return;
    const handleScroll = () => {
      updateEmailCenterTabIndicator();
    };
    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      container.removeEventListener("scroll", handleScroll);
    };
  }, [updateEmailCenterTabIndicator]);

  useEffect(() => {
    if (activeTab === "new" || activeTab === "templates") {
      return;
    }
    const status = activeTab === "logs" ? undefined : activeTab;
    pendingEmailCampaignRefreshRef.current = false;
    void loadCampaigns(status, { silent: hasCampaignRowsRef.current });
  }, [activeTab, loadCampaigns]);

  useEffect(() => {
    if (activeTab === "new" || activeTab === "templates") {
      return;
    }
    const isDocumentHidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";
    const refreshCurrentView = () => {
      if (isDocumentHidden()) {
        pendingEmailCampaignRefreshRef.current = true;
        return;
      }
      pendingEmailCampaignRefreshRef.current = false;
      void loadCampaigns(activeTab === "logs" ? undefined : activeTab, { silent: true });
    };
    const handleResourceChanged = (event: Event) => {
      const resource = String(
        ((event as CustomEvent<{ resource?: string }>).detail?.resource || ""),
      );
      if (resource === "email-campaigns") {
        refreshCurrentView();
      }
    };
    const flushPendingResourceChange = () => {
      if (!pendingEmailCampaignRefreshRef.current || isDocumentHidden()) {
        return;
      }
      refreshCurrentView();
    };
    window.addEventListener("trufusion:resource-changed", handleResourceChanged);
    document.addEventListener("visibilitychange", flushPendingResourceChange);
    window.addEventListener("focus", flushPendingResourceChange);
    return () => {
      window.removeEventListener("trufusion:resource-changed", handleResourceChanged);
      document.removeEventListener("visibilitychange", flushPendingResourceChange);
      window.removeEventListener("focus", flushPendingResourceChange);
    };
  }, [activeTab, loadCampaigns]);

  useEffect(() => {
    if (!isBulkRecipientMode || !selectedTemplateId) {
      setBulkRecipientEstimate({ count: null, recipients: [], loading: false, error: null });
      return;
    }

    let active = true;
    const timer = window.setTimeout(() => {
      setBulkRecipientEstimate({ count: null, recipients: [], loading: true, error: null });
      void emailCenterAPI
        .estimateRecipients({
          templateId: selectedTemplateId,
          recipientSelection: { mode: recipientMode },
        })
        .then((response: any) => {
          if (!active) return;
          const count = Number(response?.recipientCount ?? response?.count ?? 0);
          const recipients = Array.isArray(response?.recipients)
            ? response.recipients
                .map((recipient: any) => ({
                  email: String(recipient?.email || "").trim(),
                  name: String(recipient?.name || "").trim(),
                  type: String(recipient?.type || "").trim(),
                  clinicName: String(recipient?.clinicName || recipient?.clinic_name || "").trim(),
                  variables: recipient?.variables && typeof recipient.variables === "object"
                    ? Object.fromEntries(
                        Object.entries(recipient.variables).map(([key, value]) => [key, String(value || "")]),
                      )
                    : undefined,
                }))
                .filter((recipient: RecipientPreview) => recipient.email)
            : [];
          setBulkRecipientEstimate({
            count: Number.isFinite(count) ? count : 0,
            recipients,
            loading: false,
            error: null,
          });
        })
        .catch((error) => {
          if (!active) return;
          setBulkRecipientEstimate({
            count: null,
            recipients: [],
            loading: false,
            error: getErrorMessage(error),
          });
        });
    }, 150);

    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [isBulkRecipientMode, recipientMode, selectedTemplateId]);

  useEffect(() => {
    if (!selectedTemplate) return;
    resetPreviewEdits();
    const nextVariables: Record<string, string> = {};
    getTemplateVariables(selectedTemplate).forEach((variable) => {
      nextVariables[variable] = SAMPLE_VALUES[variable] || "";
    });
    setVariables(nextVariables);
    setSubject(templateDefaultSubject(selectedTemplate));
    setTestToken("");
    setTestTokenExpiresAt(null);
    setConfirmationText("");
    setScheduledAt("");
    setCcRecipients("");
    setBccRecipients("");
  }, [resetPreviewEdits, selectedTemplate]);

  useEffect(() => {
    if (allowedRecipientOptions.some((option) => option.id === recipientMode)) {
      return;
    }
    setRecipientMode(allowedRecipientOptions[0]?.id || "test");
  }, [allowedRecipientOptions, recipientMode]);

  useEffect(() => {
    if (!pendingPreparedDraft || !selectedTemplate) return;
    if (pendingPreparedDraft.templateId !== selectedTemplate.id) return;
    setSubject(pendingPreparedDraft.subject || templateDefaultSubject(selectedTemplate));
    setVariables(
      typeof pendingPreparedDraft.variables === "object" && pendingPreparedDraft.variables
        ? pendingPreparedDraft.variables
        : {},
    );
    setScheduledAt(isoToScheduleInput(pendingPreparedDraft.scheduledAt));
    setCcRecipients(formatRecipientListValue(pendingPreparedDraft.ccRecipients));
    setBccRecipients(formatRecipientListValue(pendingPreparedDraft.bccRecipients));
    setTestToken("");
    setTestTokenExpiresAt(null);
    setConfirmationText("");
    setPendingPreparedDraft(null);
    toast.success("Draft loaded. Review recipients before sending.");
  }, [pendingPreparedDraft, selectedTemplate]);

  useEffect(() => {
    if (templatesForType.length === 0) return;
    if (!templatesForType.some((template) => template.id === selectedTemplateId)) {
      setSelectedTemplateId(templatesForType[0].id);
    }
  }, [selectedTemplateId, templatesForType]);

  useEffect(() => {
    setTestToken("");
    setTestTokenExpiresAt(null);
  }, [
    bccRecipients,
    ccRecipients,
    customEmails,
    effectiveTestRecipientEmail,
    previewVariables,
    recipientMode,
    selectedPhysicianEmail,
    selectedTemplateId,
    subject,
    variables,
  ]);

  useEffect(() => {
    if (!selectedTemplateId) return;
    let active = true;
    const timer = window.setTimeout(() => {
      const pendingDraftCustomHtml = pendingDraftCustomHtmlRef.current.trim();
      const activeCustomHtml = pendingDraftCustomHtml || getCustomHtmlOverride();
      setPreviewLoading(true);
      void emailCenterAPI
        .previewTemplate(
          selectedTemplateId,
          previewVariables,
          activeCustomHtml ? { customHtml: activeCustomHtml } : undefined,
        )
        .then((response: any) => {
          if (!active) return;
          const normalizedCustomHtml = String(response?.customHtml || activeCustomHtml || "").trim();
          if (normalizedCustomHtml) {
            pendingDraftCustomHtmlRef.current = "";
            editedPreviewHtmlRef.current = normalizedCustomHtml;
            setPreviewEdited(true);
          } else {
            resetPreviewEdits();
          }
          setPreviewHtml(String(response?.html || ""));
        })
        .catch((error) => {
          if (!active) return;
          setPreviewHtml("");
          setTemplateError(getErrorMessage(error));
        })
        .finally(() => {
          if (active) setPreviewLoading(false);
        });
    }, 250);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [getCustomHtmlOverride, previewVariables, resetPreviewEdits, selectedTemplateId]);

  const selectTemplate = (templateId: string) => {
    const template = templates.find((entry) => entry.id === templateId);
    if (template) {
      setSelectedType(templateCampaignType(template) || selectedType);
    }
    setSelectedTemplateId(templateId);
  };

  const buildRecipientSelection = () => {
    if (recipientMode === "test") {
      return { mode: recipientMode, testEmail: effectiveTestRecipientEmail };
    }
    if (recipientMode === "selected_physician") {
      return { mode: recipientMode, selectedPhysicianEmail };
    }
    if (recipientMode === "custom") {
      return { mode: recipientMode, customEmails };
    }
    return { mode: recipientMode };
  };

  const handleSendTest = async () => {
    if (!selectedTemplate) {
      toast.error("Select an email template first.");
      return;
    }
    if (!testRecipientEmail.trim()) {
      toast.error("Enter a test email address first.");
      return;
    }
    if (sendingTest) return;
    setSendingTest(true);
    try {
      const customHtml = getCustomHtmlOverride();
      const response = (await emailCenterAPI.sendTest({
        templateId: selectedTemplate.id,
        subject,
        variables: previewVariables,
        customHtml: customHtml || undefined,
        recipientSelection: buildRecipientSelection(),
        ccRecipients: ccRecipients.trim() || undefined,
        bccRecipients: bccRecipients.trim() || undefined,
        recipientEmail: testRecipientEmail,
      })) as any;
      setTestToken(String(response?.testToken || ""));
      setTestTokenExpiresAt(response?.expiresAt || null);
      toast.success("Test email sent");
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setSendingTest(false);
    }
  };

  const openSendConfirmation = (mode: "send" | "schedule") => {
    if (!selectedTemplate) {
      toast.error("Select an email template first.");
      return;
    }
    if (mode === "schedule") {
      scheduledAtDraftRef.current = scheduledAt;
    }
    setConfirmationText("");
    setPendingCampaignMode(mode);
  };

  const createCampaign = async (mode: "draft" | "send" | "schedule") => {
    if (!selectedTemplate) {
      toast.error("Select an email template first.");
      return;
    }
    if (mode !== "draft" && confirmationText !== "SEND") {
      toast.error("Type SEND to confirm this campaign.");
      return;
    }
    if (mode !== "draft" && requiresPreflightTest && !testToken) {
      toast.error("Send a test email before continuing.");
      return;
    }
    let scheduleIso: string | null = null;
    if (mode === "schedule") {
      const selectedScheduledAt = (scheduledAtInputRef.current?.value || scheduledAtDraftRef.current || scheduledAt).trim();
      if (!selectedScheduledAt) {
        toast.error("Choose a scheduled send time first.");
        return;
      }
      scheduledAtDraftRef.current = selectedScheduledAt;
      setScheduledAt(selectedScheduledAt);
      try {
        scheduleIso = scheduleInputToIso(selectedScheduledAt);
      } catch (error) {
        toast.error(getErrorMessage(error));
        return;
      }
      if (!scheduleIso) {
        toast.error("Choose a scheduled send time first.");
        return;
      }
    }
    if (savingCampaign) return;
    setSavingCampaign(true);
    try {
      const customHtml = getCustomHtmlOverride();
      await emailCenterAPI.createCampaign({
        templateId: selectedTemplate.id,
        subject,
        variables: previewVariables,
        customHtml: customHtml || undefined,
        recipientSelection: buildRecipientSelection(),
        ccRecipients: ccRecipients.trim() || undefined,
        bccRecipients: bccRecipients.trim() || undefined,
        status: mode === "draft" ? "draft" : undefined,
        scheduledAt: scheduleIso,
        confirmationText,
        testToken,
      });
      toast.success(mode === "draft" ? "Draft saved" : mode === "schedule" ? "Campaign scheduled" : "Campaign queued");
      setConfirmationText("");
      setPendingCampaignMode(null);
      if (mode === "schedule") {
        scheduledAtDraftRef.current = "";
        setScheduledAt("");
      }
      const nextTab: CampaignTab = mode === "draft" ? "draft" : mode === "schedule" ? "scheduled" : "sent";
      navigateToCampaignTab(nextTab);
      await loadCampaigns(nextTab === "logs" ? undefined : nextTab);
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setSavingCampaign(false);
    }
  };

  const handleConfirmCampaignClick = () => {
    if (!pendingCampaignMode) return;
    if (pendingCampaignMode === "schedule") {
      if (scheduledAtInputRef.current) {
        scheduledAtDraftRef.current = scheduledAtInputRef.current.value || scheduledAtDraftRef.current;
        scheduledAtInputRef.current.blur();
      }
      window.setTimeout(() => {
        void createCampaign("schedule");
      }, 0);
      return;
    }
    void createCampaign(pendingCampaignMode);
  };

  const deleteDraftCampaign = async (campaign: EmailCenterCampaign) => {
    if (!campaign?.id || campaign.status !== "draft") return;
    const label = campaign.subject || campaign.templateId || "this draft";
    if (!window.confirm(`Delete draft "${label}"? This cannot be undone.`)) return;
    setDeletingCampaignId(campaign.id);
    try {
      await emailCenterAPI.deleteCampaign(campaign.id);
      toast.success("Draft deleted");
      setCampaigns((current) => current.filter((item) => item.id !== campaign.id));
      await loadCampaigns(activeTab === "logs" ? undefined : activeTab);
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setDeletingCampaignId(null);
    }
  };

  const prepareDraftCampaign = (campaign: EmailCenterCampaign) => {
    if (!campaign?.id || campaign.status !== "draft") return;
    const templateId = String(campaign.templateId || "");
    const template = templates.find((entry) => entry.id === templateId);
    if (!template) {
      toast.error("Draft template is not available in the approved manifest.");
      return;
    }
    pendingDraftCustomHtmlRef.current = String(campaign.customHtml || "");
    setPendingPreparedDraft(campaign);
    setSelectedType(templateCampaignType(template) || selectedType);
    setSelectedTemplateId(template.id);
    setActiveTab("new");
  };

  const handleCampaignAction = (campaign: EmailCenterCampaign, action: string) => {
    if (action === "prepare") {
      prepareDraftCampaign(campaign);
      return;
    }
    if (action === "delete") {
      void deleteDraftCampaign(campaign);
    }
  };

  const renderCampaignList = (status?: string) => {
    const visible = status && status !== "logs"
      ? campaigns.filter((campaign) => campaignMatchesView(campaign, status))
      : campaigns;
    return (
      <div className={clsx(DASHBOARD_PANEL_CLASS, "space-y-4")}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h4 className="text-base font-semibold text-slate-900">
              {status === "logs" ? "Recent Email Activity" : "Campaigns"}
            </h4>
            <p className="text-sm text-slate-600">
              {status === "logs" ? "Recent campaign audit trail summary." : "Queued campaign records from the backend."}
            </p>
          </div>
          {campaignsRefreshing && (
            <div className="flex shrink-0 justify-end pt-0.5">
              <span className="inline-flex items-center rounded-md border border-slate-200 bg-white/85 px-3 py-2 text-xs font-semibold text-slate-600 shadow-sm">
                Updating
              </span>
            </div>
          )}
        </div>
        {campaignError && (
          <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            {campaignError}
          </div>
        )}
        {campaignsLoading ? (
          <div className="rounded-md border border-slate-200 bg-white px-4 py-6 text-sm text-slate-500">
            Loading campaigns...
          </div>
        ) : visible.length === 0 ? (
          <div className="rounded-md border border-slate-200 bg-white px-4 py-6 text-sm text-slate-500">
            No campaigns in this view.
          </div>
        ) : (
          <div className="overflow-x-auto rounded-md border border-slate-200 bg-white">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-3 py-2">Subject</th>
                  <th className="px-3 py-2">Template</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2 text-right">Recipients</th>
                  <th className="px-3 py-2">Progress</th>
                  <th className="px-3 py-2">Created</th>
                  <th className="px-3 py-2">Scheduled</th>
                  <th className="px-3 py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {visible.map((campaign) => {
                  const progress = getCampaignProgress(campaign);
                  const isDraft = campaign.status === "draft";
                  return (
                    <tr key={campaign.id}>
                      <td className="px-3 py-2 font-medium text-slate-900">{campaign.subject || "Untitled"}</td>
                      <td className="px-3 py-2 text-slate-600">{campaign.templateId}</td>
                      <td className="px-3 py-2">
                        <span className="inline-flex rounded-md bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-700">
                          {campaign.status || "unknown"}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-slate-700">
                        {campaign.recipientCount ?? 0}
                      </td>
                      <td className="min-w-[220px] px-3 py-2">
                        {isDraft ? (
                          <span className="inline-flex rounded-md border border-slate-200 bg-white px-2 py-1 text-xs font-semibold text-slate-600">
                            Draft not queued
                          </span>
                        ) : (
                          <>
                            <div className="mb-1 flex items-center justify-between gap-3 text-xs text-slate-600">
                              <span className="font-semibold text-slate-800">{progress.percent}% complete</span>
                              <span className="tabular-nums">
                                {progress.completed}/{progress.total}
                              </span>
                            </div>
                            <div className="flex h-2 w-full overflow-hidden rounded-full bg-slate-200" aria-hidden="true">
                              <span className="h-full bg-emerald-500" style={{ width: progress.sentWidth }} />
                              <span className="h-full bg-red-500" style={{ width: progress.failedWidth }} />
                              <span className="h-full bg-amber-400" style={{ width: progress.unsubscribedWidth }} />
                            </div>
                            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-slate-500">
                              <span>Sent {progress.sent}</span>
                              {progress.processing > 0 && <span>Processing {progress.processing}</span>}
                              {progress.checking > 0 && <span>Checking {progress.checking}</span>}
                              <span>Pending {progress.pending}</span>
                              {progress.failed > 0 && <span>Failed {progress.failed}</span>}
                              {progress.unsubscribed > 0 && <span>Unsubscribed {progress.unsubscribed}</span>}
                            </div>
                          </>
                        )}
                      </td>
                      <td className="px-3 py-2 text-slate-600">{formatDateTime(campaign.createdAt)}</td>
                      <td className="px-3 py-2 text-slate-600">{formatDateTime(campaign.scheduledAt)}</td>
                      <td className="px-3 py-2 text-right">
                        {isDraft ? (
                          <select
                            value=""
                            onChange={(event) => {
                              handleCampaignAction(campaign, event.target.value);
                              event.currentTarget.value = "";
                            }}
                            disabled={deletingCampaignId === campaign.id}
                            className={ACTION_SELECT_CLASS}
                            aria-label={`Actions for ${campaign.subject || campaign.templateId || "draft campaign"}`}
                          >
                            <option value="" disabled>
                              Action
                            </option>
                            <option value="prepare">Prepare</option>
                            <option value="delete">
                              {deletingCampaignId === campaign.id ? "Deleting..." : "Delete draft"}
                            </option>
                          </select>
                        ) : (
                          <select value="" disabled className={ACTION_SELECT_CLASS} aria-label="No campaign actions available">
                            <option value="">Action</option>
                          </select>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    );
  };

  return (
    <section ref={emailCenterRootRef} className="email-center-root admin-tab-panel-enter w-full min-w-0">
      <Dialog
        open={pendingCampaignMode !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPendingCampaignMode(null);
            setConfirmationText("");
          }
        }}
      >
        <DialogContent
          className="email-center-confirm-dialog max-w-md"
          containerClassName="email-center-confirm-dialog-layer fixed inset-0 flex items-center justify-center px-3 py-6 sm:px-4 sm:py-8"
          containerStyle={{ overscrollBehavior: "contain" }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {pendingCampaignMode === "schedule" ? "Confirm Scheduled Campaign" : "Confirm Campaign Send"}
            </DialogTitle>
            <DialogDescription>
              You are about to {pendingCampaignMode === "schedule" ? "schedule" : "send"} "
              {selectedTemplate?.name || "this campaign"}" to {recipientEstimate} recipients.
              {pendingCampaignMode === "schedule" ? " Choose a send time and type SEND to confirm." : " Type SEND to confirm."}
            </DialogDescription>
          </DialogHeader>
          {pendingCampaignMode === "schedule" && (
            <label className={FIELD_SHELL_CLASS}>
              <span className={FIELD_LABEL_CLASS}>Scheduled send time</span>
              <input
                ref={scheduledAtInputRef}
                type="datetime-local"
                name="scheduledAt"
                defaultValue={scheduledAt}
                onInput={(event) => {
                  scheduledAtDraftRef.current = event.currentTarget.value;
                  setScheduledAt(event.currentTarget.value);
                }}
                onChange={(event) => {
                  scheduledAtDraftRef.current = event.target.value;
                  setScheduledAt(event.target.value);
                }}
                className={INPUT_CLASS}
                autoFocus
              />
            </label>
          )}
          <label className={FIELD_SHELL_CLASS}>
            <span className={FIELD_LABEL_CLASS}>Confirmation</span>
            <input
              value={confirmationText}
              onChange={(event) => setConfirmationText(event.target.value)}
              placeholder="SEND"
              className={clsx(INPUT_CLASS, "font-semibold tracking-wide")}
              autoFocus={pendingCampaignMode !== "schedule"}
            />
          </label>
          {requiresPreflightTest && !testToken && (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-900">
              Send a test email before this campaign can be queued.
            </div>
          )}
          <DialogFooter className="email-center-action-row">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setPendingCampaignMode(null);
                setConfirmationText("");
              }}
              className="email-center-home-button squircle-sm gap-2"
            >
              <span>Cancel</span>
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleConfirmCampaignClick}
              disabled={savingCampaign}
              className="email-center-home-button squircle-sm gap-2"
            >
              {pendingCampaignMode === "schedule" ? (
                <CalendarDaysIcon className="h-4 w-4" aria-hidden="true" />
              ) : (
                <PaperAirplaneIcon className="h-4 w-4" aria-hidden="true" />
              )}
              <span>{pendingCampaignMode === "schedule" ? "Schedule send" : "Send now"}</span>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3 px-1">
          <div>
            <h3 className="text-xl font-semibold text-slate-950">Admin Email Center</h3>
            <p className="text-sm text-slate-600">
              Approved templates live in the backend; send history lives in the campaign queue.
            </p>
          </div>
        </div>

        <div className="relative mb-3 w-full account-tab-shell">
          <div
            className="w-full account-tab-scroll-container"
            ref={setEmailCenterTabsContainerRef}
            onScroll={updateEmailCenterTabIndicator}
          >
            <div className="flex items-center gap-4 pb-0 account-tab-row">
              {CAMPAIGN_TABS.map((tab) => {
                const isActive = activeTab === tab.id;
                const TabIcon = tab.Icon;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    className={clsx(
                      "relative inline-flex min-h-[2.5rem] items-center gap-2 px-3 pb-1 pt-2 text-sm font-semibold whitespace-nowrap !text-black transition-colors hover:!text-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-black/30 flex-shrink-0",
                      isActive && "!text-black",
                    )}
                    data-email-center-tab={tab.id}
                    aria-pressed={isActive}
                    onClick={() => {
                      setActiveTab(tab.id);
                    }}
                  >
                    <span className="inline-flex items-center gap-2 !text-black" data-email-center-tab-content>
                      <span className="relative inline-flex h-5 w-5 shrink-0 items-center justify-center overflow-visible">
                        <TabIcon
                          className="shrink-0 text-current"
                          aria-hidden="true"
                          style={{ width: "1.6rem", height: "1.6rem" }}
                        />
                      </span>
                      <span className="inline-flex items-center !text-black">{tab.label}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
          <span
            aria-hidden="true"
            className="account-tab-underline-indicator"
            style={{
              left: emailCenterTabIndicator.left,
              width: emailCenterTabIndicator.width,
              opacity: emailCenterTabIndicator.opacity,
            }}
          />
        </div>

        {activeTab === "templates" && (
          <div className="grid gap-8 xl:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
            <section className={clsx(DASHBOARD_PANEL_CLASS, "space-y-5")}>
              <div>
                <h4 className="text-base font-semibold text-slate-950">Approved Template</h4>
                <p className="text-sm text-slate-600">
                  Select an approved backend template to inspect its rendered HTML.
                </p>
              </div>
              {templateError && (
                <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                  {templateError}
                </div>
              )}
              <label className={FIELD_SHELL_CLASS}>
                <span className={FIELD_LABEL_CLASS}>Template</span>
                <select
                  value={selectedTemplateId}
                  onChange={(event) => selectTemplate(event.target.value)}
                  className={SELECT_CLASS}
                  disabled={templatesLoading || templates.length === 0}
                >
                  {templates.map((template) => (
                    <option key={template.id} value={template.id}>
                      {template.name}
                    </option>
                  ))}
                </select>
              </label>
              {selectedTemplate && (
                <div className="space-y-4 rounded-md border border-slate-200/80 bg-white/85 p-4 text-sm text-slate-700 shadow-sm">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <h5 className="text-base font-semibold text-slate-950">{selectedTemplate.name}</h5>
                      {selectedTemplate.id === "delegate_links_announcement" && (
                        <span className="rounded-md bg-blue-50 px-2 py-1 text-xs font-semibold text-blue-800">
                          First
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-slate-600">{selectedTemplate.description}</p>
                  </div>
                  <div className="grid gap-3">
                    <div>
                      <span className={FIELD_LABEL_CLASS}>File</span>
                      <div className="break-all text-xs text-slate-600">{selectedTemplate.file}</div>
                    </div>
                    <div>
                      <span className={FIELD_LABEL_CLASS}>Type</span>
                      <div className="text-slate-800">{templateCampaignType(selectedTemplate) || "template"}</div>
                    </div>
                    <div>
                      <span className={FIELD_LABEL_CLASS}>Variables</span>
                      <div className="flex flex-wrap gap-2">
                        {getTemplateVariables(selectedTemplate).map((variable) => (
                          <span
                            key={variable}
                            className="rounded-md border border-slate-200 bg-white px-2 py-1 text-xs font-semibold text-slate-600"
                          >
                            {variable}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </section>

            <section className={clsx(DASHBOARD_PANEL_CLASS, "min-w-0")}>
              <div className="mb-3 flex items-center justify-between gap-2">
                <div>
                  <h4 className="text-base font-semibold text-slate-950">HTML Preview</h4>
                  <p className="text-sm text-slate-600">{selectedTemplate?.description || "Select a template."}</p>
                </div>
                {previewLoading && <RefreshCw className="h-4 w-4 animate-spin text-slate-400" aria-hidden="true" />}
              </div>
              <iframe
                title="Email template HTML preview"
                sandbox="allow-scripts"
                srcDoc={templatePreviewSrcDoc}
                className="email-center-preview-frame email-center-preview-frame--templates rounded-md border border-slate-300 bg-white shadow-inner"
              />
            </section>
          </div>
        )}

        {activeTab !== "new" && activeTab !== "templates" && renderCampaignList(activeTab)}

        {activeTab === "new" && (
          <div className="space-y-8">
            <div className="space-y-8">
              <section className={DASHBOARD_PANEL_CLASS}>
                <div className="mb-4 flex items-center gap-2">
                  <FileText className="h-5 w-5 text-slate-950" aria-hidden="true" />
                  <h4 className="text-base font-semibold text-slate-950">Template</h4>
                </div>
                <div className="email-center-template-stack">
                  {templateError && (
                    <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                      {templateError}
                    </div>
                  )}
                  <div className="email-center-template-grid">
                    <label className={FIELD_SHELL_CLASS}>
                      <span className={FIELD_LABEL_CLASS}>Email type</span>
                      <select
                        value={selectedType}
                        onChange={(event) => setSelectedType(event.target.value)}
                        className={SELECT_CLASS}
                        disabled={templatesLoading}
                      >
                        {emailTypes.map((type) => (
                          <option key={type.id} value={type.id}>{type.label}</option>
                        ))}
                      </select>
                    </label>
                    <label className={FIELD_SHELL_CLASS}>
                      <span className={FIELD_LABEL_CLASS}>Template</span>
                      <select
                        value={selectedTemplateId}
                        onChange={(event) => selectTemplate(event.target.value)}
                        className={SELECT_CLASS}
                        disabled={templatesLoading || templatesForType.length === 0}
                      >
                        {templatesForType.map((template) => (
                          <option key={template.id} value={template.id}>{template.name}</option>
                        ))}
                      </select>
                    </label>
                  </div>
                </div>
              </section>

              <section className={DASHBOARD_PANEL_CLASS}>
                <div className="mb-4 flex items-center gap-2">
                  <Users className="h-5 w-5 text-slate-950" aria-hidden="true" />
                  <h4 className="text-base font-semibold text-slate-950">Subject and Recipients</h4>
                </div>
                <div className="email-center-recipient-stack">
                  <label className={FIELD_SHELL_CLASS}>
                    <span className={FIELD_LABEL_CLASS}>Subject</span>
                    <input
                      value={subject}
                      onChange={(event) => setSubject(event.target.value)}
                      className={INPUT_CLASS}
                    />
                  </label>
                  <label className={FIELD_SHELL_CLASS}>
                    <span className={FIELD_LABEL_CLASS}>Recipients</span>
                    <select
                      value={recipientMode}
                      onChange={(event) => setRecipientMode(event.target.value as RecipientMode)}
                      className={SELECT_CLASS}
                    >
                      {allowedRecipientOptions.map((option) => (
                        <option key={option.id} value={option.id}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                    {selectedRecipientOption?.description && (
                      <span className="mt-2 block text-xs text-slate-600">{selectedRecipientOption.description}</span>
                    )}
                  </label>
                  <div className="email-center-recipient-details">
                    {recipientMode === "test" && (
                      <label className={FIELD_SHELL_CLASS}>
                        <span className={FIELD_LABEL_CLASS}>Test recipient</span>
                        <input
                          value={testEmail}
                          onChange={(event) => setTestEmail(event.target.value)}
                          placeholder="admin@example.com"
                          className={INPUT_CLASS}
                        />
                      </label>
                    )}
                    {recipientMode === "selected_physician" && (
                      <label className={FIELD_SHELL_CLASS}>
                        <span className={FIELD_LABEL_CLASS}>Physician email</span>
                        <input
                          value={selectedPhysicianEmail}
                          onChange={(event) => setSelectedPhysicianEmail(event.target.value)}
                          placeholder="doctor@example.com"
                          className={INPUT_CLASS}
                        />
                      </label>
                    )}
                    {recipientMode === "custom" && (
                      <label className={FIELD_SHELL_CLASS}>
                        <span className={FIELD_LABEL_CLASS}>Custom email list</span>
                        <textarea
                          value={customEmails}
                          onChange={(event) => setCustomEmails(event.target.value)}
                          rows={4}
                          placeholder="one@example.com, two@example.com"
                          className={TEXTAREA_CLASS}
                        />
                      </label>
                    )}
                    <div className="rounded-md border border-slate-200/80 bg-white/85 px-3 py-2 text-sm text-slate-700 shadow-sm">
                      Recipients: <span className="font-semibold">{recipientEstimate}</span>
                      {isBulkRecipientMode && bulkRecipientEstimate.error ? (
                        <span className="ml-2 text-xs font-medium text-amber-700">
                          {bulkRecipientEstimate.error}
                        </span>
                      ) : null}
                      {isBulkRecipientMode && bulkRecipientEstimate.recipients.length > 0 && (
                        <div className="mt-3 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm leading-6 text-slate-700 shadow-inner">
                          <span className="font-semibold text-slate-900">Email list: </span>
                          {bulkRecipientEstimate.recipients.map((recipient) => recipient.email).join(", ")}
                        </div>
                      )}
                    </div>
                    <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800">
                      <ExclamationCircleIcon className="mt-0.5 h-4 w-4 flex-none" aria-hidden="true" />
                      <span>
                        CC and BCC recipients receive a copy of every individual recipient email in this campaign,
                        not a single campaign summary.
                      </span>
                    </div>
                    <div className="email-center-copy-recipient-grid">
                      <label className={FIELD_SHELL_CLASS}>
                        <span className={FIELD_LABEL_CLASS}>CC Recipients</span>
                        <input
                          value={ccRecipients}
                          onChange={(event) => setCcRecipients(event.target.value)}
                          placeholder="cc@example.com, office@example.com"
                          className={INPUT_CLASS}
                        />
                      </label>
                      <label className={FIELD_SHELL_CLASS}>
                        <span className={FIELD_LABEL_CLASS}>BCC Recipients</span>
                        <input
                          value={bccRecipients}
                          onChange={(event) => setBccRecipients(event.target.value)}
                          placeholder="hidden@example.com"
                          className={INPUT_CLASS}
                        />
                      </label>
                    </div>
                  </div>
                </div>
              </section>

              {requiresPreflightTest && (
                <section className={DASHBOARD_PANEL_CLASS}>
                  <div className="mb-4 flex items-center gap-2">
                    <Mail className="h-5 w-5 text-slate-950" aria-hidden="true" />
                    <h4 className="text-base font-semibold text-slate-950">Test Send</h4>
                  </div>
                  <div className={FIELD_STACK_CLASS}>
                    <label className={FIELD_SHELL_CLASS}>
                      <span className={FIELD_LABEL_CLASS}>Send test to</span>
                      <input
                        value={testRecipientEmail}
                        onChange={(event) => setTestRecipientEmail(event.target.value)}
                        placeholder="admin@example.com"
                        className={INPUT_CLASS}
                      />
                    </label>
                    <div className="email-center-action-row email-center-test-send-action-row">
                      {testToken && (
                        <p className="email-center-test-token-status" role="status">
                          Test send completed. Token expires {formatDateTime(testTokenExpiresAt)}.
                        </p>
                      )}
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={handleSendTest}
                        disabled={sendingTest}
                        className="email-center-home-button squircle-sm gap-2"
                      >
                        <Mail className="h-4 w-4" aria-hidden="true" />
                        <span>{sendingTest ? "Sending..." : "Send test email"}</span>
                      </Button>
                    </div>
                  </div>
                </section>
              )}

              <div className="email-center-preview-send-layout">
                <section className={clsx(DASHBOARD_PANEL_CLASS, "email-center-preview-panel min-w-0")}>
                  <div className="mb-3 flex items-center justify-between gap-2">
                    <div>
                      <h4 className="text-base font-semibold text-slate-950">Preview</h4>
                      <p className="text-sm text-slate-600">{selectedTemplate?.description || "Select a template."}</p>
                    </div>
                    {previewLoading && <RefreshCw className="h-4 w-4 animate-spin text-slate-400" aria-hidden="true" />}
                  </div>
                  <label className="mb-3 block rounded-md border border-slate-200/80 bg-white/85 p-3 shadow-sm">
                    <span className={FIELD_LABEL_CLASS}>Preview recipient</span>
                    <select
                      value={selectedPreviewRecipient?.id || ""}
                      onChange={(event) => handlePreviewRecipientChange(event.target.value)}
                      className={SELECT_CLASS}
                    >
                      {previewRecipientOptions.map((recipient) => (
                        <option key={recipient.id} value={recipient.id}>
                          {recipient.label}
                        </option>
                      ))}
                    </select>
                    {isBulkRecipientMode && bulkRecipientEstimate.loading && (
                      <span className="mt-2 block text-xs font-medium text-slate-500">
                        Loading recipients...
                      </span>
                    )}
                  </label>
                  <iframe
                    ref={editablePreviewFrameRef}
                    title="Email template preview"
                    sandbox="allow-scripts allow-modals"
                    onLoad={handleEditablePreviewFrameLoad}
                    srcDoc={editablePreviewSrcDoc}
                    className="email-center-preview-frame email-center-preview-frame--send rounded-md border border-slate-300 bg-white shadow-inner"
                  />
                </section>

                <section className={clsx(DASHBOARD_PANEL_CLASS, "email-center-send-panel")}>
                  <div className="mb-4 flex items-center gap-2">
                    <PaperAirplaneIcon className="h-5 w-5 text-slate-950" aria-hidden="true" />
                    <h4 className="text-base font-semibold text-slate-950">Send Controls</h4>
                  </div>
                  <div className={FIELD_STACK_CLASS}>
                    <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                      You are about to send "{selectedTemplate?.name || "this campaign"}" to {recipientEstimate} recipients.
                      Continue opens the final SEND confirmation.
                    </div>
                    {requiresPreflightTest && !testToken && (
                      <div className="rounded-md border border-slate-200 bg-white/85 px-3 py-2 text-sm text-slate-700 shadow-sm">
                        Send a test email before continuing to a real send or scheduled send.
                      </div>
                    )}
                    <div className="email-center-action-row">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => createCampaign("draft")}
                        disabled={savingCampaign}
                        className="email-center-home-button squircle-sm gap-2"
                      >
                        <BookmarkIcon className="h-4 w-4" aria-hidden="true" />
                        <span>Save draft</span>
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => openSendConfirmation("send")}
                        disabled={savingCampaign}
                        className="email-center-home-button squircle-sm gap-2"
                      >
                        <PaperAirplaneIcon className="h-4 w-4" aria-hidden="true" />
                        <span>Continue to send now</span>
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => openSendConfirmation("schedule")}
                        disabled={savingCampaign}
                        className="email-center-home-button squircle-sm gap-2"
                      >
                        <CalendarDaysIcon className="h-4 w-4" aria-hidden="true" />
                        <span>Continue to schedule</span>
                      </Button>
                    </div>
                  </div>
                </section>
              </div>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
