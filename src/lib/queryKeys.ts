export const appQueryKeys = {
  orders: ["orders"] as const,
  accountOrders: ["orders", "account"] as const,
  salesTracking: ["orders", "sales-tracking"] as const,
  onHoldOrders: ["orders", "on-hold"] as const,
  dashboardSummary: ["dashboard-summary"] as const,
  orderReports: ["orders", "reports"] as const,
  patientLinks: ["patient-links"] as const,
  referrals: ["referrals"] as const,
  settings: ["settings"] as const,
  users: ["users"] as const,
  catalog: ["catalog"] as const,
  forum: ["forum"] as const,
  peptideProducts: ["peptide-products"] as const,
  emailCampaigns: ["email-campaigns"] as const,
};

export const appDataResources = [
  "orders",
  "patient-links",
  "referrals",
  "settings",
  "users",
  "catalog",
  "forum",
  "peptide-products",
  "email-campaigns",
] as const;

export type AppDataResource = (typeof appDataResources)[number];

export const queryPrefixesForResource: Record<AppDataResource, readonly unknown[][]> = {
  orders: [
    appQueryKeys.orders,
    appQueryKeys.dashboardSummary,
    appQueryKeys.orderReports,
  ],
  "patient-links": [
    appQueryKeys.patientLinks,
    appQueryKeys.settings,
  ],
  referrals: [
    appQueryKeys.referrals,
    appQueryKeys.dashboardSummary,
  ],
  settings: [
    appQueryKeys.settings,
    appQueryKeys.users,
  ],
  users: [
    appQueryKeys.users,
    appQueryKeys.settings,
    appQueryKeys.referrals,
  ],
  catalog: [appQueryKeys.catalog],
  forum: [appQueryKeys.forum],
  "peptide-products": [appQueryKeys.peptideProducts],
  "email-campaigns": [appQueryKeys.emailCampaigns],
};

export const isAppDataResource = (value: unknown): value is AppDataResource =>
  typeof value === "string" && (appDataResources as readonly string[]).includes(value);
