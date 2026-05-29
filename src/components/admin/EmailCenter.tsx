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
        node.closest(".email-center-preview-edit-button")
      )
    );
  }

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
  [data-email-center-edit-target="true"] {
    outline: 2px solid rgba(11, 6, 121, 0.42) !important;
    outline-offset: 3px !important;
  }
  [data-email-center-editing="true"] {
    outline: 2px solid #0b0679 !important;
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
  var EDITABLE_SELECTOR = "h1,h2,h3,h4,h5,h6,p,li,a,span,td,th,img";
  var VARIABLES = ${serializeForInlineScript(lockedVariables)};
  var VARIABLE_PLACEHOLDER_PATTERN = /{{\\s*([a-zA-Z0-9_]+)\\s*}}/g;
  var button = document.createElement("button");
  var activeTarget = null;
  var editingTarget = null;
  var editingRequiredVariableIds = [];
  var editingLastSafeHtml = "";
  var variableMarkerSequence = 0;

  button.type = "button";
  button.className = "email-center-preview-edit-button";
  button.setAttribute("aria-label", "Edit section");
  button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
  document.addEventListener("DOMContentLoaded", function () {
    document.body.appendChild(button);
  });

  function isInjectedNode(element) {
    return Boolean(
      element &&
      element.closest &&
      element.closest(".email-center-preview-edit-button,script,style,head,meta")
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

  function shouldSkipTextNode(node) {
    var parent = node && node.parentElement;
    return Boolean(
      !parent ||
      parent.closest("[data-email-center-variable],script,style,head,meta,.email-center-preview-edit-button")
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
    clone.querySelectorAll(".email-center-preview-edit-button,[data-email-center-preview-editor],style[data-email-center-preview-editor-style],style[data-email-center-preview-containment],meta[data-email-center-preview-containment],script[data-email-center-preview-containment]").forEach(function (node) {
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
    clone.querySelectorAll("[data-email-center-edit-target],[data-email-center-editing],[contenteditable]").forEach(function (node) {
      node.removeAttribute("data-email-center-edit-target");
      node.removeAttribute("data-email-center-editing");
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
  }

  function startEditing(target) {
    if (!target) return;
    if (target.tagName === "IMG") {
      if (!attributeHasVariable(target, "src")) {
        var nextSrc = window.prompt("Image URL", target.getAttribute("src") || "");
        if (nextSrc !== null && nextSrc.trim()) {
          target.setAttribute("src", nextSrc.trim());
        }
      }
      if (!attributeHasVariable(target, "alt")) {
        var nextAlt = window.prompt("Image alt text", target.getAttribute("alt") || "");
        if (nextAlt !== null) {
          target.setAttribute("alt", nextAlt);
        }
      }
      postHtmlUpdate();
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

  function markEditingHtmlSafe() {
    if (!editingTarget) return;
    editingLastSafeHtml = editingTarget.innerHTML;
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

  document.addEventListener("click", function (event) {
    var removeButton = event.target && event.target.closest && event.target.closest("[data-email-center-variable-remove]");
    if (!removeButton) return;
    event.preventDefault();
    event.stopPropagation();
    removeVariableMarker(removeButton.closest("[data-email-center-variable]"));
  }, true);

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
      stopEditing();
      clearActiveTarget();
    }
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      stopEditing();
    }
  });

  document.addEventListener("focusout", function (event) {
    if (editingTarget && !editingTarget.contains(event.relatedTarget)) {
      window.setTimeout(stopEditing, 0);
    }
  }, true);

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
  const total = Math.max(Number(campaign.recipientCount || 0), sent + failed + unsubscribed + pending + processing, 0);
  const completed = Math.min(total, sent + failed + unsubscribed);
  const percent = total > 0 ? Math.round((completed / total) * 100) : 0;
  const segment = (value: number) => (total > 0 ? `${Math.max(0, Math.min(100, (value / total) * 100))}%` : "0%");
  return {
    sent,
    failed,
    unsubscribed,
    pending,
    processing,
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
  const [previewRecipientKey, setPreviewRecipientKey] = useState("test:sample");
  const [testEmail, setTestEmail] = useState("");
  const [selectedPhysicianEmail, setSelectedPhysicianEmail] = useState("");
  const [customEmails, setCustomEmails] = useState("");
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
  const [campaignsAutoUpdating, setCampaignsAutoUpdating] = useState(false);
  const [campaignError, setCampaignError] = useState<string | null>(null);
  const [bulkRecipientEstimate, setBulkRecipientEstimate] = useState<{
    count: number | null;
    recipients: RecipientPreview[];
    loading: boolean;
    error: string | null;
  }>({ count: null, recipients: [], loading: false, error: null });
  const emailCenterRootRef = useRef<HTMLElement | null>(null);
  const emailCenterTabsContainerRef = useRef<HTMLDivElement | null>(null);
  const editablePreviewFrameRef = useRef<HTMLIFrameElement | null>(null);
  const editedPreviewHtmlRef = useRef("");
  const pendingDraftCustomHtmlRef = useRef("");
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

  useEffect(() => {
    const handlePreviewEditorMessage = (event: MessageEvent) => {
      if (event.source !== editablePreviewFrameRef.current?.contentWindow) return;
      const data = event.data as { type?: string; html?: unknown } | null;
      if (!data || data.type !== "trufusion-email-center-preview-edited") return;
      editedPreviewHtmlRef.current = String(data.html || "");
      setPreviewEdited(true);
      setTestToken("");
      setTestTokenExpiresAt(null);
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

    return recipients.map((recipient, index) => toPreviewRecipientOption(recipient, recipientMode, index));
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
    setPreviewRecipientKey(previewRecipientOptions[0]?.id || "test:sample");
  }, [previewRecipientKey, previewRecipientOptions]);

  const selectedPreviewRecipient = useMemo(
    () => previewRecipientOptions.find((option) => option.id === previewRecipientKey) || previewRecipientOptions[0] || null,
    [previewRecipientKey, previewRecipientOptions],
  );

  const previewVariables = useMemo(() => {
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
      setCampaignsAutoUpdating(true);
    }
    setCampaignError(null);
    try {
      const response = (await emailCenterAPI.listCampaigns(status && status !== "logs" ? status : undefined)) as any;
      setCampaigns(Array.isArray(response?.campaigns) ? response.campaigns : []);
    } catch (error) {
      setCampaignError(getErrorMessage(error));
    } finally {
      if (!silent) {
        setCampaignsLoading(false);
      } else {
        setCampaignsAutoUpdating(false);
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
    void loadCampaigns(status, { silent: campaigns.length > 0 });
  }, [activeTab, campaigns.length, loadCampaigns]);

  useEffect(() => {
    if (activeTab === "new" || activeTab === "templates") {
      return;
    }
    const refreshCurrentView = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        return;
      }
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
    window.addEventListener("trufusion:resource-changed", handleResourceChanged);
    document.addEventListener("visibilitychange", refreshCurrentView);
    window.addEventListener("focus", refreshCurrentView);
    return () => {
      window.removeEventListener("trufusion:resource-changed", handleResourceChanged);
      document.removeEventListener("visibilitychange", refreshCurrentView);
      window.removeEventListener("focus", refreshCurrentView);
    };
  }, [activeTab, loadCampaigns]);

  useEffect(() => {
    if (activeTab === "new" || activeTab === "templates") {
      return;
    }
    const interval = window.setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        return;
      }
      void loadCampaigns(activeTab === "logs" ? undefined : activeTab, { silent: true });
    }, 5000);
    return () => {
      window.clearInterval(interval);
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
  }, [selectedTemplateId, subject, variables]);

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
      if (!scheduledAt) {
        toast.error("Choose a scheduled send time first.");
        return;
      }
      try {
        scheduleIso = scheduleInputToIso(scheduledAt);
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
    const scrollSnapshot = {
      x: window.scrollX,
      y: window.scrollY,
    };
    setSavingCampaign(true);
    try {
      const customHtml = getCustomHtmlOverride();
      await emailCenterAPI.createCampaign({
        templateId: selectedTemplate.id,
        subject,
        variables: previewVariables,
        customHtml: customHtml || undefined,
        recipientSelection: buildRecipientSelection(),
        status: mode === "draft" ? "draft" : undefined,
        scheduledAt: scheduleIso,
        confirmationText,
        testToken,
      });
      toast.success(mode === "draft" ? "Draft saved" : mode === "schedule" ? "Campaign scheduled" : "Campaign queued");
      setConfirmationText("");
      setPendingCampaignMode(null);
      if (mode === "schedule") {
        setScheduledAt("");
      }
      const nextTab: CampaignTab = mode === "draft" ? "draft" : mode === "schedule" ? "scheduled" : "sent";
      setActiveTab(nextTab);
      await loadCampaigns(nextTab === "logs" ? undefined : nextTab);
      if (mode !== "draft") {
        window.requestAnimationFrame(() => {
          window.scrollTo(scrollSnapshot.x, scrollSnapshot.y);
        });
      }
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setSavingCampaign(false);
    }
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
        <div className="flex flex-wrap items-center gap-2">
          <div>
            <h4 className="text-base font-semibold text-slate-900">
              {status === "logs" ? "Recent Email Activity" : "Campaigns"}
            </h4>
            <p className="text-sm text-slate-600">
              {status === "logs" ? "Recent campaign audit trail summary." : "Queued campaign records from the backend."}
            </p>
          </div>
          {campaignsAutoUpdating && (
            <div className="ml-auto flex w-full justify-end sm:w-auto">
              <span className="inline-flex items-center rounded-md border border-slate-200 bg-white/85 px-3 py-2 text-xs font-semibold text-slate-600 shadow-sm">
                Auto-updating
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
                type="datetime-local"
                value={scheduledAt}
                onChange={(event) => setScheduledAt(event.target.value)}
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
              onClick={() => {
                if (!pendingCampaignMode) return;
                void createCampaign(pendingCampaignMode);
              }}
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
                  <label className={FIELD_SHELL_CLASS}>
                    <span className={FIELD_LABEL_CLASS}>Subject</span>
                    <input
                      value={subject}
                      onChange={(event) => setSubject(event.target.value)}
                      className={INPUT_CLASS}
                    />
                  </label>
                </div>
              </section>

              <section className={DASHBOARD_PANEL_CLASS}>
                <div className="mb-4 flex items-center gap-2">
                  <Users className="h-5 w-5 text-slate-950" aria-hidden="true" />
                  <h4 className="text-base font-semibold text-slate-950">Recipients</h4>
                </div>
                <div className="email-center-recipient-stack">
                  <div className="email-center-recipient-option-list">
                    {allowedRecipientOptions.map((option) => (
                      <label
                        key={option.id}
                        className={clsx(
                          "flex cursor-pointer gap-3 rounded-md border p-3 shadow-sm transition",
                          recipientMode === option.id
                            ? "border-[rgb(11,6,121)] bg-white ring-2 ring-[rgba(11,6,121,0.14)]"
                            : "border-slate-200/80 bg-white/85 hover:border-slate-300",
                        )}
                      >
                        <input
                          type="radio"
                          name="recipientMode"
                          value={option.id}
                          checked={recipientMode === option.id}
                          onChange={() => setRecipientMode(option.id)}
                          className="mt-1"
                        />
                        <span>
                          <span className="block text-sm font-semibold text-slate-900">{option.label}</span>
                          <span className="block text-xs text-slate-600">{option.description}</span>
                        </span>
                      </label>
                    ))}
                  </div>
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
                      Estimated recipients: <span className="font-semibold">{recipientEstimate}</span>
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
                      onChange={(event) => setPreviewRecipientKey(event.target.value)}
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
