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
  Eye,
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

const RECIPIENT_DYNAMIC_VARIABLES = new Set([
  "doctor_name",
  "clinic_name",
  "delegate_links_url",
  "unsubscribe_url",
]);

const CAMPAIGN_TABS = [
  { id: "new", label: "New Campaign", Icon: EnvelopeIcon },
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

const getPersonalizationVariables = (template: EmailCenterTemplate | null): string[] => {
  const templateVariables = getTemplateVariables(template);
  return templateVariables.filter((variable) => !RECIPIENT_DYNAMIC_VARIABLES.has(variable));
};

const getDynamicTemplateVariables = (template?: EmailCenterTemplate | null): string[] =>
  getTemplateVariables(template).filter((variable) => RECIPIENT_DYNAMIC_VARIABLES.has(variable));

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
const FIELD_GRID_CLASS = "grid gap-x-7 gap-y-6 sm:grid-cols-2";
const FIELD_STACK_CLASS = "grid gap-6";
const INPUT_CLASS = "h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-900 shadow-inner outline-none transition focus:border-slate-500 focus:ring-2 focus:ring-slate-900/10";
const TEXTAREA_CLASS = "w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-inner outline-none transition focus:border-slate-500 focus:ring-2 focus:ring-slate-900/10";
const SELECT_CLASS = "h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-900 shadow-inner outline-none transition focus:border-slate-500 focus:ring-2 focus:ring-slate-900/10";
const ACTION_SELECT_CLASS = "h-9 min-w-[9.5rem] rounded-md border border-slate-300 bg-white px-3 text-sm font-semibold text-black shadow-inner outline-none transition hover:border-slate-500 focus:border-slate-500 focus:ring-2 focus:ring-slate-900/10 disabled:cursor-not-allowed disabled:opacity-50";

const getCampaignProgress = (campaign: EmailCenterCampaign) => {
  const counts = campaign.counts || {};
  const sent = Number(counts.sent || 0);
  const failed = Number(counts.failed || 0) + Number(counts.bounced || 0);
  const unsubscribed = Number(counts.unsubscribed || 0);
  const pending = Number(counts.pending || 0);
  const total = Math.max(Number(campaign.recipientCount || 0), sent + failed + unsubscribed + pending, 0);
  const completed = Math.min(total, sent + failed + unsubscribed);
  const percent = total > 0 ? Math.round((completed / total) * 100) : 0;
  const segment = (value: number) => (total > 0 ? `${Math.max(0, Math.min(100, (value / total) * 100))}%` : "0%");
  return {
    sent,
    failed,
    unsubscribed,
    pending: Math.max(0, total - completed),
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
  const [emailCenterTabIndicator, setEmailCenterTabIndicator] = useState<{
    left: number;
    width: number;
    opacity: number;
  }>({ left: 0, width: 0, opacity: 0 });

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

  const personalizationVariables = useMemo(
    () => getPersonalizationVariables(selectedTemplate),
    [selectedTemplate],
  );

  const dynamicTemplateVariables = useMemo(
    () => getDynamicTemplateVariables(selectedTemplate),
    [selectedTemplate],
  );

  const effectiveTestRecipientEmail = useMemo(
    () => testEmail.trim() || testRecipientEmail.trim(),
    [testEmail, testRecipientEmail],
  );

  const isBulkRecipientMode = recipientMode === "all_verified_physicians" || recipientMode === "sales_reps";
  const requiresPreflightTest = recipientMode !== "test";

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
  }, [selectedTemplate]);

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
      setPreviewLoading(true);
      void emailCenterAPI
        .previewTemplate(selectedTemplateId, variables)
        .then((response: any) => {
          if (!active) return;
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
  }, [selectedTemplateId, variables]);

  const updateVariable = (key: string, value: string) => {
    setVariables((current) => ({ ...current, [key]: value }));
  };

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
      const response = (await emailCenterAPI.sendTest({
        templateId: selectedTemplate.id,
        subject,
        variables,
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
      await emailCenterAPI.createCampaign({
        templateId: selectedTemplate.id,
        subject,
        variables,
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
    <section ref={emailCenterRootRef} className="admin-tab-panel-enter w-full min-w-0">
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
                sandbox=""
                srcDoc={previewHtml || "<!doctype html><html><body></body></html>"}
                className="h-[760px] w-full rounded-md border border-slate-300 bg-white shadow-inner"
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

              <section className={DASHBOARD_PANEL_CLASS}>
                <div className="mb-4 flex items-center gap-2">
                  <Eye className="h-5 w-5 text-slate-950" aria-hidden="true" />
                  <h4 className="text-base font-semibold text-slate-950">Personalization</h4>
                </div>
                {personalizationVariables.length === 0 ? (
                  <div className="rounded-md border border-slate-200 bg-white/85 px-3 py-2 text-sm text-slate-600 shadow-sm">
                    This template uses recipient details automatically for the selected audience.
                  </div>
                ) : (
                  <div className="space-y-4">
                    {dynamicTemplateVariables.length > 0 && (
                      <div className="rounded-md border border-slate-200 bg-white/85 px-3 py-2 text-sm text-slate-700 shadow-sm">
                        <span className="font-semibold text-slate-900">Recipient data:</span>{" "}
                        {dynamicTemplateVariables.map((variable) => variable.replace(/_/g, " ")).join(", ")}
                      </div>
                    )}
                    <div className={FIELD_GRID_CLASS}>
                      {personalizationVariables.map((variable) => (
                        <label key={variable} className={FIELD_SHELL_CLASS}>
                          <span className={FIELD_LABEL_CLASS}>
                            {variable.replace(/_/g, " ")}
                          </span>
                          {variable === "message_body" ? (
                            <textarea
                              value={variables[variable] || ""}
                              onChange={(event) => updateVariable(variable, event.target.value)}
                              rows={4}
                              className={TEXTAREA_CLASS}
                            />
                          ) : (
                            <input
                              value={variables[variable] || ""}
                              onChange={(event) => updateVariable(variable, event.target.value)}
                              className={INPUT_CLASS}
                            />
                          )}
                        </label>
                      ))}
                    </div>
                  </div>
                )}
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
                    <div className="email-center-action-row">
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
                    {testToken && (
                      <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
                        Test send completed. Token expires {formatDateTime(testTokenExpiresAt)}.
                      </div>
                    )}
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
                  <iframe
                    title="Email template preview"
                    sandbox=""
                    srcDoc={previewHtml || "<!doctype html><html><body></body></html>"}
                    className="email-center-preview-frame rounded-md border border-slate-300 bg-white shadow-inner"
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
