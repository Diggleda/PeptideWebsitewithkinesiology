import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import {
  BookmarkIcon,
  CircleStackIcon,
  ClockIcon,
  EnvelopeIcon,
  ExclamationCircleIcon,
  RocketLaunchIcon,
  StrikethroughIcon,
} from "@heroicons/react/24/outline";
import {
  CalendarDays,
  CheckCircle2,
  Eye,
  FileText,
  Mail,
  RefreshCw,
  Save,
  Send,
  Users,
} from "lucide-react";
import {
  emailCenterAPI,
  type EmailCenterCampaign,
  type EmailCenterTemplate,
} from "../../services/api";
import { toast } from "../../lib/toast";

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

const formatDateTime = (value?: string | null) => {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
};

const getErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error || "Request failed");

const countCustomEmails = (value: string) =>
  value
    .split(/[\s,;]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.includes("@")).length;

const DASHBOARD_PANEL_CLASS = "sales-rep-leads-card text-slate-900";
const FIELD_SHELL_CLASS = "rounded-md border border-slate-200/80 bg-white/85 p-3 shadow-sm";
const FIELD_LABEL_CLASS = "mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500";
const INPUT_CLASS = "h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-900 shadow-inner outline-none transition focus:border-slate-500 focus:ring-2 focus:ring-slate-900/10";
const TEXTAREA_CLASS = "w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-inner outline-none transition focus:border-slate-500 focus:ring-2 focus:ring-slate-900/10";
const SELECT_CLASS = "h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-900 shadow-inner outline-none transition focus:border-slate-500 focus:ring-2 focus:ring-slate-900/10";

const getCampaignProgress = (campaign: EmailCenterCampaign) => {
  const counts = campaign.counts || {};
  const sent = Number(counts.sent || 0);
  const failed = Number(counts.failed || 0) + Number(counts.bounced || 0);
  const skipped = Number(counts.unsubscribed || 0);
  const pending = Number(counts.pending || 0);
  const total = Math.max(Number(campaign.recipientCount || 0), sent + failed + skipped + pending, 0);
  const completed = Math.min(total, sent + failed + skipped);
  const percent = total > 0 ? Math.round((completed / total) * 100) : 0;
  const segment = (value: number) => (total > 0 ? `${Math.max(0, Math.min(100, (value / total) * 100))}%` : "0%");
  return {
    sent,
    failed,
    skipped,
    pending: Math.max(0, total - completed),
    total,
    completed,
    percent,
    sentWidth: segment(sent),
    failedWidth: segment(failed),
    skippedWidth: segment(skipped),
  };
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
  const [campaigns, setCampaigns] = useState<EmailCenterCampaign[]>([]);
  const [campaignsLoading, setCampaignsLoading] = useState(false);
  const [campaignError, setCampaignError] = useState<string | null>(null);
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

  const templatesForType = useMemo(
    () => templates.filter((template) => templateCampaignType(template) === selectedType),
    [selectedType, templates],
  );

  const recipientEstimate = useMemo(() => {
    if (recipientMode === "test") return testEmail.trim() ? "1" : "0";
    if (recipientMode === "selected_physician") return selectedPhysicianEmail.trim() ? "1" : "0";
    if (recipientMode === "custom") return String(countCustomEmails(customEmails));
    if (recipientMode === "all_verified_physicians") return "all verified physicians";
    return "active sales reps";
  }, [customEmails, recipientMode, selectedPhysicianEmail, testEmail]);

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

  const loadCampaigns = useCallback(async (status?: string) => {
    setCampaignsLoading(true);
    setCampaignError(null);
    try {
      const response = (await emailCenterAPI.listCampaigns(status && status !== "logs" ? status : undefined)) as any;
      setCampaigns(Array.isArray(response?.campaigns) ? response.campaigns : []);
    } catch (error) {
      setCampaignError(getErrorMessage(error));
    } finally {
      setCampaignsLoading(false);
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
    if (activeTab === "new" || activeTab === "templates") return;
    const timer = window.setInterval(() => {
      void loadCampaigns(activeTab === "logs" ? undefined : activeTab);
    }, 10000);
    return () => window.clearInterval(timer);
  }, [activeTab, loadCampaigns]);

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
  }, [selectedTemplate]);

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

  const buildRecipientSelection = () => {
    if (recipientMode === "test") {
      return { mode: recipientMode, testEmail };
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
    if (!selectedTemplate) return;
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

  const createCampaign = async (mode: "draft" | "send" | "schedule") => {
    if (!selectedTemplate) return;
    setSavingCampaign(true);
    try {
      const scheduleIso = mode === "schedule" && scheduledAt ? new Date(scheduledAt).toISOString() : null;
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
      setActiveTab(mode === "draft" ? "draft" : mode === "schedule" ? "scheduled" : "logs");
      await loadCampaigns(mode === "draft" ? "draft" : mode === "schedule" ? "scheduled" : undefined);
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setSavingCampaign(false);
    }
  };

  const renderCampaignList = (status?: string) => {
    const visible = status && status !== "logs"
      ? campaigns.filter((campaign) => campaign.status === status)
      : campaigns;
    return (
      <div className={clsx(DASHBOARD_PANEL_CLASS, "space-y-4")}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h4 className="text-base font-semibold text-slate-900">
              {status === "logs" ? "Recent Email Activity" : "Campaigns"}
            </h4>
            <p className="text-sm text-slate-600">
              {status === "logs" ? "Recent campaign audit trail summary." : "Queued campaign records from the backend."}
            </p>
          </div>
          <button
            type="button"
            onClick={() => loadCampaigns(status)}
            className="inline-flex h-9 items-center gap-2 rounded-md border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-800 hover:bg-slate-50"
          >
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            Refresh
          </button>
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
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {visible.map((campaign) => {
                  const progress = getCampaignProgress(campaign);
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
                        <div className="mb-1 flex items-center justify-between gap-3 text-xs text-slate-600">
                          <span className="font-semibold text-slate-800">{progress.percent}% complete</span>
                          <span className="tabular-nums">
                            {progress.completed}/{progress.total}
                          </span>
                        </div>
                        <div className="flex h-2 w-full overflow-hidden rounded-full bg-slate-200" aria-hidden="true">
                          <span className="h-full bg-emerald-500" style={{ width: progress.sentWidth }} />
                          <span className="h-full bg-red-500" style={{ width: progress.failedWidth }} />
                          <span className="h-full bg-amber-400" style={{ width: progress.skippedWidth }} />
                        </div>
                        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-slate-500">
                          <span>Sent {progress.sent}</span>
                          <span>Pending {progress.pending}</span>
                          {progress.failed > 0 && <span>Failed {progress.failed}</span>}
                          {progress.skipped > 0 && <span>Skipped {progress.skipped}</span>}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-slate-600">{formatDateTime(campaign.createdAt)}</td>
                      <td className="px-3 py-2 text-slate-600">{formatDateTime(campaign.scheduledAt)}</td>
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
    <section className="admin-tab-panel-enter w-full min-w-0">
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3 px-1">
          <div>
            <h3 className="text-xl font-semibold text-slate-950">Admin Email Center</h3>
            <p className="text-sm text-slate-600">
              Approved templates live in the backend; send history lives in the campaign queue.
            </p>
          </div>
          <div className="inline-flex items-center gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-800">
            <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
            Approved templates only
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
                      if (tab.id !== "new" && tab.id !== "templates") {
                        void loadCampaigns(tab.id);
                      }
                    }}
                  >
                    <span className="inline-flex items-center gap-2 !text-black" data-email-center-tab-content>
                      <span className="relative inline-flex h-5 w-5 shrink-0 items-center justify-center overflow-visible">
                        <TabIcon
                          className="shrink-0"
                          aria-hidden="true"
                          style={{ width: "1.6rem", height: "1.6rem", color: "#000000" }}
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
          <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
            {templates.map((template) => (
              <article key={template.id} className={clsx(DASHBOARD_PANEL_CLASS, "p-4")}>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h4 className="font-semibold text-slate-950">{template.name}</h4>
                    <p className="mt-1 text-sm text-slate-600">{template.description}</p>
                  </div>
                  {template.id === "delegate_links_announcement" && (
                    <span className="rounded-md bg-blue-50 px-2 py-1 text-xs font-semibold text-blue-800">
                      First
                    </span>
                  )}
                </div>
                <div className="mt-3 text-xs text-slate-500">
                  {template.file}
                </div>
              </article>
            ))}
          </div>
        )}

        {activeTab !== "new" && activeTab !== "templates" && renderCampaignList(activeTab)}

        {activeTab === "new" && (
          <div className="grid gap-6 xl:grid-cols-[minmax(0,520px)_minmax(0,1fr)]">
            <div className="space-y-6">
              <section className={DASHBOARD_PANEL_CLASS}>
                <div className="mb-4 flex items-center gap-2">
                  <FileText className="h-5 w-5 text-slate-700" aria-hidden="true" />
                  <h4 className="text-base font-semibold text-slate-950">Template</h4>
                </div>
                {templateError && (
                  <div className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                    {templateError}
                  </div>
                )}
                <div className="grid gap-5 sm:grid-cols-2">
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
                      onChange={(event) => setSelectedTemplateId(event.target.value)}
                      className={SELECT_CLASS}
                      disabled={templatesLoading || templatesForType.length === 0}
                    >
                      {templatesForType.map((template) => (
                        <option key={template.id} value={template.id}>{template.name}</option>
                      ))}
                    </select>
                  </label>
                </div>
                <label className={clsx(FIELD_SHELL_CLASS, "mt-5 block")}>
                  <span className={FIELD_LABEL_CLASS}>Subject</span>
                  <input
                    value={subject}
                    onChange={(event) => setSubject(event.target.value)}
                    className={INPUT_CLASS}
                  />
                </label>
              </section>

              <section className={DASHBOARD_PANEL_CLASS}>
                <div className="mb-4 flex items-center gap-2">
                  <Users className="h-5 w-5 text-slate-700" aria-hidden="true" />
                  <h4 className="text-base font-semibold text-slate-950">Recipients</h4>
                </div>
                <div className="grid gap-4">
                  {RECIPIENT_OPTIONS.map((option) => (
                    <label
                      key={option.id}
                      className={clsx(
                        "flex cursor-pointer gap-3 rounded-md border p-3 shadow-sm transition",
                        recipientMode === option.id
                          ? "border-slate-900 bg-white ring-2 ring-slate-900/10"
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
                {recipientMode === "test" && (
                  <label className={clsx(FIELD_SHELL_CLASS, "mt-5 block")}>
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
                  <label className={clsx(FIELD_SHELL_CLASS, "mt-5 block")}>
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
                  <label className={clsx(FIELD_SHELL_CLASS, "mt-5 block")}>
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
                <div className="mt-5 rounded-md border border-slate-200/80 bg-white/85 px-3 py-2 text-sm text-slate-700 shadow-sm">
                  Estimated recipients: <span className="font-semibold">{recipientEstimate}</span>
                </div>
              </section>

              <section className={DASHBOARD_PANEL_CLASS}>
                <div className="mb-4 flex items-center gap-2">
                  <Eye className="h-5 w-5 text-slate-700" aria-hidden="true" />
                  <h4 className="text-base font-semibold text-slate-950">Personalization</h4>
                </div>
                <div className="grid gap-5 sm:grid-cols-2">
                  {getTemplateVariables(selectedTemplate).map((variable) => (
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
              </section>

              <section className={DASHBOARD_PANEL_CLASS}>
                <div className="mb-4 flex items-center gap-2">
                  <Send className="h-5 w-5 text-slate-700" aria-hidden="true" />
                  <h4 className="text-base font-semibold text-slate-950">Send Controls</h4>
                </div>
                <div className="grid gap-5">
                  <label className={FIELD_SHELL_CLASS}>
                    <span className={FIELD_LABEL_CLASS}>Test email address</span>
                    <input
                      value={testRecipientEmail}
                      onChange={(event) => setTestRecipientEmail(event.target.value)}
                      placeholder="admin@example.com"
                      className={INPUT_CLASS}
                    />
                  </label>
                  <button
                    type="button"
                    onClick={handleSendTest}
                    disabled={sendingTest || !selectedTemplateId || !testRecipientEmail.trim()}
                    className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-slate-950 px-4 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-300"
                  >
                    <Mail className="h-4 w-4" aria-hidden="true" />
                    {sendingTest ? "Sending..." : "Send test email"}
                  </button>
                  {testToken && (
                    <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
                      Test send completed. Token expires {formatDateTime(testTokenExpiresAt)}.
                    </div>
                  )}
                  <label className={FIELD_SHELL_CLASS}>
                    <span className={FIELD_LABEL_CLASS}>Schedule send</span>
                    <input
                      type="datetime-local"
                      value={scheduledAt}
                      onChange={(event) => setScheduledAt(event.target.value)}
                      className={INPUT_CLASS}
                    />
                  </label>
                  <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                    You are about to send "{selectedTemplate?.name || "this campaign"}" to {recipientEstimate} recipients.
                    Type <span className="font-bold">SEND</span> to confirm.
                  </div>
                  <label className={FIELD_SHELL_CLASS}>
                    <span className={FIELD_LABEL_CLASS}>Confirmation</span>
                    <input
                      value={confirmationText}
                      onChange={(event) => setConfirmationText(event.target.value)}
                      placeholder="SEND"
                      className={clsx(INPUT_CLASS, "font-semibold tracking-wide")}
                    />
                  </label>
                  <div className="flex flex-wrap gap-4">
                    <button
                      type="button"
                      onClick={() => createCampaign("draft")}
                      disabled={savingCampaign || !selectedTemplateId}
                      className="inline-flex h-10 items-center gap-2 rounded-md border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-800 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      <Save className="h-4 w-4" aria-hidden="true" />
                      Save draft
                    </button>
                    <button
                      type="button"
                      onClick={() => createCampaign("send")}
                      disabled={savingCampaign || !testToken || confirmationText !== "SEND"}
                      className="inline-flex h-10 items-center gap-2 rounded-md bg-slate-950 px-4 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-300"
                    >
                      <Send className="h-4 w-4" aria-hidden="true" />
                      Send now
                    </button>
                    <button
                      type="button"
                      onClick={() => createCampaign("schedule")}
                      disabled={savingCampaign || !testToken || confirmationText !== "SEND" || !scheduledAt}
                      className="inline-flex h-10 items-center gap-2 rounded-md bg-blue-700 px-4 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-300"
                    >
                      <CalendarDays className="h-4 w-4" aria-hidden="true" />
                      Schedule send
                    </button>
                  </div>
                </div>
              </section>
            </div>

            <section className={clsx(DASHBOARD_PANEL_CLASS, "min-w-0")}>
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
                className="h-[720px] w-full rounded-md border border-slate-300 bg-white shadow-inner"
              />
            </section>
          </div>
        )}
      </div>
    </section>
  );
}
