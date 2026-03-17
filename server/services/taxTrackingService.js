const fs = require('fs');
const path = require('path');
const wooCommerceClient = require('../integration/wooCommerceClient');
const mysqlClient = require('../database/mysqlClient');
const { logger } = require('../config/logger');
const { resolvePacificDayWindowUtc } = require('../utils/timeZone');

const TAX_TRACKING_TTL_SECONDS = Math.max(
  5,
  Math.min(Number(process.env.ADMIN_TAX_TRACKING_TTL_SECONDS || 25) || 25, 300),
);
const ADMIN_TAXES_BY_STATE_TTL_SECONDS = Math.max(
  5,
  Math.min(Number(process.env.ADMIN_TAXES_BY_STATE_TTL_SECONDS || 25) || 25, 300),
);
const WARNING_RATIO = 0.9;
const MAX_PAGES = 25;
const PER_PAGE = 100;
const REPORT_TIME_ZONE = (process.env.REPORT_TIMEZONE || 'America/Los_Angeles').trim() || 'America/Los_Angeles';
const RULES_PATH = path.resolve(__dirname, '../config/tax-tracking-rules.csv');

const taxTrackingCache = {
  data: null,
  expiresAtMs: 0,
};

const adminTaxesByStateCache = {
  key: null,
  data: null,
  expiresAtMs: 0,
};

const invalidateTaxTrackingCaches = () => {
  taxTrackingCache.data = null;
  taxTrackingCache.expiresAtMs = 0;
  adminTaxesByStateCache.key = null;
  adminTaxesByStateCache.data = null;
  adminTaxesByStateCache.expiresAtMs = 0;
};

const STATE_CODE_BY_NAME = {
  Alabama: 'AL',
  Alaska: 'AK',
  Arizona: 'AZ',
  Arkansas: 'AR',
  California: 'CA',
  Colorado: 'CO',
  Connecticut: 'CT',
  Delaware: 'DE',
  Florida: 'FL',
  Georgia: 'GA',
  Hawaii: 'HI',
  Idaho: 'ID',
  Illinois: 'IL',
  Indiana: 'IN',
  Iowa: 'IA',
  Kansas: 'KS',
  Kentucky: 'KY',
  Louisiana: 'LA',
  Maine: 'ME',
  Maryland: 'MD',
  Massachusetts: 'MA',
  Michigan: 'MI',
  Minnesota: 'MN',
  Mississippi: 'MS',
  Missouri: 'MO',
  Montana: 'MT',
  Nebraska: 'NE',
  Nevada: 'NV',
  'New Hampshire': 'NH',
  'New Jersey': 'NJ',
  'New Mexico': 'NM',
  'New York': 'NY',
  'North Carolina': 'NC',
  'North Dakota': 'ND',
  Ohio: 'OH',
  Oklahoma: 'OK',
  Oregon: 'OR',
  Pennsylvania: 'PA',
  'Rhode Island': 'RI',
  'South Carolina': 'SC',
  'South Dakota': 'SD',
  Tennessee: 'TN',
  Texas: 'TX',
  Utah: 'UT',
  Vermont: 'VT',
  Virginia: 'VA',
  Washington: 'WA',
  'West Virginia': 'WV',
  Wisconsin: 'WI',
  Wyoming: 'WY',
};
const STATE_NAME_BY_CODE = Object.fromEntries(
  Object.entries(STATE_CODE_BY_NAME).map(([name, code]) => [code, name]),
);
const STATE_CODE_BY_UPPER_NAME = Object.fromEntries(
  Object.entries(STATE_CODE_BY_NAME).map(([name, code]) => [name.toUpperCase(), code]),
);

let cachedRules = null;

const safeNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const safeOptionalInteger = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.round(parsed);
};

const parseBoolean = (value) => {
  if (value === true || value === false) return value;
  if (typeof value === 'number') return value !== 0;
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(value || '').trim().toLowerCase());
};

const normalizeText = (value) => {
  const text = String(value || '').trim();
  return text || null;
};

const parseCsvLine = (line) => {
  const columns = [];
  let current = '';
  let inQuotes = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (inQuotes && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (char === ',' && !inQuotes) {
      columns.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  columns.push(current);
  return columns;
};

const loadRules = () => {
  if (cachedRules) return cachedRules;
  const raw = fs.readFileSync(RULES_PATH, 'utf8').replace(/^\uFEFF/, '');
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const headers = parseCsvLine(lines.shift() || '');
  cachedRules = lines
    .map((line) => {
      const values = parseCsvLine(line);
      const row = headers.reduce((acc, header, index) => {
        acc[header] = values[index] ?? '';
        return acc;
      }, {});
      const stateName = normalizeText(row.state);
      const stateCode = STATE_CODE_BY_NAME[stateName];
      if (!stateName || !stateCode) return null;
      return {
        stateCode,
        stateName,
        economicNexusRevenueUsd:
          normalizeText(row.economic_nexus_revenue_usd) !== null
            ? Number(safeNumber(row.economic_nexus_revenue_usd, 0).toFixed(2))
            : null,
        economicNexusTransactions: safeOptionalInteger(row.economic_nexus_transactions),
        collectTaxDefault: parseBoolean(row.collect_tax_default),
        researchReagentTaxable: parseBoolean(row.research_reagent_taxable),
        universityExemptionAllowed: parseBoolean(row.university_exemption_allowed),
        resaleCertificateAllowed: parseBoolean(row.resale_certificate_allowed),
        wooTaxClass: normalizeText(row.woo_tax_class),
        notes: normalizeText(row.notes),
        avgCombinedTaxRate:
          normalizeText(row.avg_combined_tax_rate) !== null
            ? Number(safeNumber(row.avg_combined_tax_rate, 0).toFixed(5))
            : null,
        exampleTaxOn100kSales:
          normalizeText(row.example_tax_on_100k_sales) !== null
            ? Number(safeNumber(row.example_tax_on_100k_sales, 0).toFixed(2))
            : null,
        taxCollectionRequiredAfterNexus: parseBoolean(row.tax_collection_required_after_nexus),
        bufferedTaxRate:
          normalizeText(row.buffered_tax_rate) !== null
            ? Number(safeNumber(row.buffered_tax_rate, 0).toFixed(5))
            : null,
        exampleTaxOn100kSalesBuffered:
          normalizeText(row.example_tax_on_100k_sales_buffered) !== null
            ? Number(safeNumber(row.example_tax_on_100k_sales_buffered, 0).toFixed(2))
            : null,
      };
    })
    .filter(Boolean);
  return cachedRules;
};

const canonicalizeState = (value) => {
  const raw = String(value || '').trim();
  if (!raw) {
    return { stateCode: 'UNKNOWN', stateName: 'Unknown' };
  }
  const upper = raw.toUpperCase();
  if (STATE_NAME_BY_CODE[upper]) {
    return { stateCode: upper, stateName: STATE_NAME_BY_CODE[upper] };
  }
  const normalizedName = raw
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');
  const code = STATE_CODE_BY_NAME[normalizedName] || STATE_CODE_BY_UPPER_NAME[upper];
  if (code) {
    return { stateCode: code, stateName: STATE_NAME_BY_CODE[code] };
  }
  return { stateCode: upper.slice(0, 16), stateName: normalizedName };
};

const getPacificToday = () => {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: REPORT_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(new Date());
};

const getDefaultReportRange = () => {
  const today = getPacificToday();
  const [year, month, day] = today.split('-').map((value) => Number(value));
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const midpoint = Math.ceil(daysInMonth / 2);
  const startDay = day <= midpoint ? 1 : midpoint;
  return {
    start: `${year}-${String(month).padStart(2, '0')}-${String(startDay).padStart(2, '0')}`,
    end: today,
  };
};

const resolveReportBounds = ({ periodStart, periodEnd }) => {
  const defaults = getDefaultReportRange();
  const start = typeof periodStart === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(periodStart.trim())
    ? periodStart.trim()
    : defaults.start;
  const end = typeof periodEnd === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(periodEnd.trim())
    ? periodEnd.trim()
    : defaults.end;
  const resolved = resolvePacificDayWindowUtc({
    periodStart: start,
    periodEnd: end,
    timeZone: REPORT_TIME_ZONE,
  });
  return {
    startMs: resolved.startMs,
    endMs: resolved.endMs,
    periodStart: resolved.start?.raw || start,
    periodEnd: resolved.end?.raw || end,
  };
};

const currentTrackingYear = () => Number(getPacificToday().slice(0, 4));

const rollingTwelveMonthBounds = () => {
  const end = new Date();
  const start = new Date(end.getTime());
  start.setFullYear(start.getFullYear() - 1);
  return {
    startMs: start.getTime(),
    endMs: end.getTime(),
    periodStart: start.toISOString(),
    periodEnd: end.toISOString(),
    trackingYear: currentTrackingYear(),
  };
};

const parseWooDateMs = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
};

const metaValue = (meta, key) => {
  if (!Array.isArray(meta)) return null;
  const match = meta.find((entry) => entry && entry.key === key);
  return match ? match.value : null;
};

const resolveWooTaxTotal = (wooOrder) => {
  const metaData = Array.isArray(wooOrder?.meta_data) ? wooOrder.meta_data : [];
  const metaTax = safeNumber(metaValue(metaData, 'peppro_tax_total'), 0);
  if (metaTax > 0) return { taxTotal: Number(metaTax.toFixed(2)), taxSource: 'meta:peppro_tax_total' };
  const orderTax = safeNumber(wooOrder?.total_tax, 0);
  if (orderTax > 0) return { taxTotal: Number(orderTax.toFixed(2)), taxSource: 'order:total_tax' };
  const feeLines = Array.isArray(wooOrder?.fee_lines) ? wooOrder.fee_lines : [];
  const taxFee = feeLines.find((fee) => String(fee?.name || '').trim().toLowerCase().includes('tax'));
  if (taxFee) {
    return { taxTotal: Number(safeNumber(taxFee?.total, 0).toFixed(2)), taxSource: 'fee_lines' };
  }
  return { taxTotal: 0, taxSource: 'unknown' };
};

const fetchWooMetrics = async ({ startMs, endMs, type }) => {
  const bucket = new Map();
  const orderLines = [];
  let orderCount = 0;
  let taxTotalAll = 0;

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const orders = await wooCommerceClient.fetchCatalog('orders', {
      per_page: PER_PAGE,
      page,
      orderby: 'date',
      order: 'desc',
      status: 'any',
    });
    const list = Array.isArray(orders) ? orders : [];
    if (!list.length) break;

    let reachedStart = false;
    for (const wooOrder of list) {
      const status = String(wooOrder?.status || '').trim().toLowerCase();
      if (!['processing', 'completed'].includes(status)) continue;
      const metaData = Array.isArray(wooOrder?.meta_data) ? wooOrder.meta_data : [];
      if (parseBoolean(metaValue(metaData, 'peppro_refunded')) || status === 'refunded') continue;

      const createdAtMs = parseWooDateMs(
        wooOrder?.date_created_gmt || wooOrder?.date_created || wooOrder?.date,
      );
      if (!Number.isFinite(createdAtMs)) continue;
      if (createdAtMs > endMs) continue;
      if (createdAtMs < startMs) {
        reachedStart = true;
        continue;
      }

      const shipping = wooOrder?.shipping || {};
      const billing = wooOrder?.billing || {};
      const { stateCode, stateName } = canonicalizeState(shipping?.state || billing?.state || 'UNKNOWN');

      if (type === 'tracking') {
        const current = bucket.get(stateCode) || {
          stateCode,
          stateName,
          trailing12MonthRevenueUsd: 0,
          trailing12MonthTransactionCount: 0,
        };
        current.trailing12MonthRevenueUsd = Number(
          (current.trailing12MonthRevenueUsd + safeNumber(wooOrder?.total, 0)).toFixed(2),
        );
        current.trailing12MonthTransactionCount += 1;
        bucket.set(stateCode, current);
      } else {
        const { taxTotal, taxSource } = resolveWooTaxTotal(wooOrder);
        orderCount += 1;
        taxTotalAll = Number((taxTotalAll + taxTotal).toFixed(2));
        const current = bucket.get(stateCode) || {
          stateCode,
          stateName,
          taxTotal: 0,
          orderCount: 0,
        };
        current.taxTotal = Number((current.taxTotal + taxTotal).toFixed(2));
        current.orderCount += 1;
        bucket.set(stateCode, current);
        orderLines.push({
          orderNumber: wooOrder?.number || wooOrder?.id,
          wooId: wooOrder?.id,
          state: stateCode,
          stateCode,
          stateName,
          status,
          createdAt: new Date(createdAtMs).toISOString(),
          taxTotal,
          taxSource,
        });
      }
    }

    if (list.length < PER_PAGE || reachedStart) break;
  }

  if (type === 'tracking') {
    return {
      metricsByState: Object.fromEntries(bucket.entries()),
    };
  }

  const rows = Array.from(bucket.values())
    .map((row) => ({
      state: row.stateCode,
      stateCode: row.stateCode,
      stateName: row.stateName,
      taxTotal: Number(safeNumber(row.taxTotal, 0).toFixed(2)),
      orderCount: Number(row.orderCount || 0),
    }))
    .sort((left, right) => safeNumber(right.taxTotal, 0) - safeNumber(left.taxTotal, 0));
  orderLines.sort((left, right) => String(left.orderNumber || '').localeCompare(String(right.orderNumber || '')));
  return {
    rows,
    orderLines,
    totals: {
      orderCount,
      taxTotal: Number(taxTotalAll.toFixed(2)),
    },
  };
};

const formatMySqlDateTime = (value) => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 19).replace('T', ' ');
};

const normalizeWooTaxClassForLookup = (value) => {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized || normalized === 'standard' || normalized === 'none') {
    return null;
  }
  return normalized;
};

const isThresholdExceeded = ({ metric, threshold }) => (
  Number.isFinite(metric)
  && Number.isFinite(threshold)
  && Number(threshold) > 0
  && Number(metric) > Number(threshold)
);

const isThresholdWarning = ({ metric, threshold }) => (
  Number.isFinite(metric)
  && Number.isFinite(threshold)
  && Number(threshold) > 0
  && !isThresholdExceeded({ metric, threshold })
  && (Number(metric) / Number(threshold)) >= WARNING_RATIO
);

const syncRulesToMySql = async (rules) => {
  if (!mysqlClient.isEnabled()) return;
  for (const rule of rules) {
    await mysqlClient.execute(
      `
        INSERT INTO tax_tracking (
          state_code,
          state_name,
          economic_nexus_revenue_usd,
          economic_nexus_transactions,
          collect_tax_default,
          research_reagent_taxable,
          university_exemption_allowed,
          resale_certificate_allowed,
          woo_tax_class,
          notes,
          avg_combined_tax_rate,
          example_tax_on_100k_sales,
          tax_collection_required_after_nexus,
          buffered_tax_rate,
          example_tax_on_100k_sales_buffered
        ) VALUES (
          :stateCode,
          :stateName,
          :economicNexusRevenueUsd,
          :economicNexusTransactions,
          :collectTaxDefault,
          :researchReagentTaxable,
          :universityExemptionAllowed,
          :resaleCertificateAllowed,
          :wooTaxClass,
          :notes,
          :avgCombinedTaxRate,
          :exampleTaxOn100kSales,
          :taxCollectionRequiredAfterNexus,
          :bufferedTaxRate,
          :exampleTaxOn100kSalesBuffered
        )
        ON DUPLICATE KEY UPDATE
          state_name = VALUES(state_name),
          economic_nexus_revenue_usd = VALUES(economic_nexus_revenue_usd),
          economic_nexus_transactions = VALUES(economic_nexus_transactions),
          collect_tax_default = VALUES(collect_tax_default),
          research_reagent_taxable = VALUES(research_reagent_taxable),
          university_exemption_allowed = VALUES(university_exemption_allowed),
          resale_certificate_allowed = VALUES(resale_certificate_allowed),
          woo_tax_class = VALUES(woo_tax_class),
          notes = VALUES(notes),
          avg_combined_tax_rate = VALUES(avg_combined_tax_rate),
          example_tax_on_100k_sales = VALUES(example_tax_on_100k_sales),
          tax_collection_required_after_nexus = VALUES(tax_collection_required_after_nexus),
          buffered_tax_rate = VALUES(buffered_tax_rate),
          example_tax_on_100k_sales_buffered = VALUES(example_tax_on_100k_sales_buffered)
      `,
      rule,
    );
  }
};

const fetchTaxTrackingManualStateMap = async () => {
  if (!mysqlClient.isEnabled()) return {};
  try {
    const rows = await mysqlClient.fetchAll(
      `
        SELECT state_code, tax_nexus_applied
        FROM tax_tracking
      `,
    );
    return (Array.isArray(rows) ? rows : []).reduce((acc, row) => {
      const stateCode = String(row?.state_code || '').trim().toUpperCase();
      if (!stateCode) return acc;
      acc[stateCode] = {
        taxNexusApplied: Boolean(row?.tax_nexus_applied),
      };
      return acc;
    }, {});
  } catch (error) {
    logger.warn({ err: error }, 'Failed to load manual tax tracking flags');
    return {};
  }
};

const syncMetricsToMySql = async (rules, metricsByState, { trackingYear, periodStart, periodEnd }) => {
  if (!mysqlClient.isEnabled()) return;

  const lastSyncedAt = formatMySqlDateTime(new Date());
  const windowStartAt = formatMySqlDateTime(periodStart);
  const windowEndAt = formatMySqlDateTime(periodEnd);

  await mysqlClient.execute(
    `
      UPDATE tax_tracking
      SET tracking_year = :trackingYear,
          current_year_revenue_usd = 0,
          current_year_order_count = 0,
          last_synced_at = :lastSyncedAt
    `,
    { trackingYear, lastSyncedAt },
  );

  for (const rule of rules) {
    const metrics = metricsByState[rule.stateCode] || {};
    const trailing12MonthRevenueUsd = Number(
      safeNumber(metrics.trailing12MonthRevenueUsd, 0).toFixed(2),
    );
    const trailing12MonthTransactionCount = Number(metrics.trailing12MonthTransactionCount || 0);
    const nexusTriggered = (
      isThresholdExceeded({
        metric: trailing12MonthRevenueUsd,
        threshold: rule.economicNexusRevenueUsd,
      })
      || isThresholdExceeded({
        metric: trailing12MonthTransactionCount,
        threshold: rule.economicNexusTransactions,
      })
    );

    await mysqlClient.execute(
      `
        UPDATE tax_tracking
        SET tracking_year = :trackingYear,
            current_year_revenue_usd = :currentYearRevenueUsd,
            current_year_order_count = :currentYearOrderCount,
            last_synced_at = :lastSyncedAt
        WHERE state_code = :stateCode
      `,
      {
        trackingYear,
        currentYearRevenueUsd: trailing12MonthRevenueUsd,
        currentYearOrderCount: trailing12MonthTransactionCount,
        lastSyncedAt,
        stateCode: rule.stateCode,
      },
    );

    await mysqlClient.execute(
      `
        INSERT INTO state_sales_totals (
          state,
          state_code,
          trailing_12mo_revenue,
          transaction_count,
          nexus_triggered,
          window_start_at,
          window_end_at,
          last_synced_at
        ) VALUES (
          :state,
          :stateCode,
          :trailing12MonthRevenueUsd,
          :transactionCount,
          :nexusTriggered,
          :windowStartAt,
          :windowEndAt,
          :lastSyncedAt
        )
        ON DUPLICATE KEY UPDATE
          state = VALUES(state),
          trailing_12mo_revenue = VALUES(trailing_12mo_revenue),
          transaction_count = VALUES(transaction_count),
          nexus_triggered = VALUES(nexus_triggered),
          window_start_at = VALUES(window_start_at),
          window_end_at = VALUES(window_end_at),
          last_synced_at = VALUES(last_synced_at)
      `,
      {
        state: rule.stateName,
        stateCode: rule.stateCode,
        trailing12MonthRevenueUsd,
        transactionCount: trailing12MonthTransactionCount,
        nexusTriggered,
        windowStartAt,
        windowEndAt,
        lastSyncedAt,
      },
    );
  }
};

const buildTrackingPayload = ({
  rules,
  metricsByState,
  manualStateByCode = {},
  trackingYear,
  periodStart,
  periodEnd,
  stale = false,
}) => {
  const rows = [];
  const notifications = [];
  let warningCount = 0;
  let exceededCount = 0;
  let shouldCollectTaxCount = 0;

  for (const rule of rules) {
    const metrics = metricsByState[rule.stateCode] || {};
    const trailing12MonthRevenueUsd = Number(
      safeNumber(metrics.trailing12MonthRevenueUsd, 0).toFixed(2),
    );
    const trailing12MonthTransactionCount = Number(metrics.trailing12MonthTransactionCount || 0);
    const revenueProgressRatio =
      Number.isFinite(rule.economicNexusRevenueUsd) && rule.economicNexusRevenueUsd > 0
        ? Number((trailing12MonthRevenueUsd / rule.economicNexusRevenueUsd).toFixed(4))
        : null;
    const transactionProgressRatio =
      Number.isFinite(rule.economicNexusTransactions) && rule.economicNexusTransactions > 0
        ? Number((trailing12MonthTransactionCount / rule.economicNexusTransactions).toFixed(4))
        : null;

    const exceededReasons = [];
    const warningReasons = [];

    if (isThresholdExceeded({
      metric: trailing12MonthRevenueUsd,
      threshold: rule.economicNexusRevenueUsd,
    })) {
      exceededReasons.push('revenue');
    } else if (isThresholdWarning({
      metric: trailing12MonthRevenueUsd,
      threshold: rule.economicNexusRevenueUsd,
    })) {
      warningReasons.push('revenue');
    }

    if (isThresholdExceeded({
      metric: trailing12MonthTransactionCount,
      threshold: rule.economicNexusTransactions,
    })) {
      exceededReasons.push('transactions');
    } else if (isThresholdWarning({
      metric: trailing12MonthTransactionCount,
      threshold: rule.economicNexusTransactions,
    })) {
      warningReasons.push('transactions');
    }

    const nexusTriggered = exceededReasons.length > 0;
    const manualState = manualStateByCode[rule.stateCode] || {};
    const warningLevel = nexusTriggered
      ? 'exceeded'
      : warningReasons.length > 0
        ? 'warning'
        : 'none';

    if (warningLevel === 'warning') warningCount += 1;
    if (warningLevel === 'exceeded') exceededCount += 1;

    const shouldCollectTax = Boolean(rule.collectTaxDefault)
      && Boolean(rule.taxCollectionRequiredAfterNexus)
      && Boolean(rule.researchReagentTaxable)
      && nexusTriggered;
    if (shouldCollectTax) shouldCollectTaxCount += 1;

    const row = {
      state: rule.stateCode,
      stateCode: rule.stateCode,
      stateName: rule.stateName,
      economicNexusRevenueUsd: rule.economicNexusRevenueUsd,
      economicNexusTransactions: rule.economicNexusTransactions,
      collectTaxDefault: Boolean(rule.collectTaxDefault),
      researchReagentTaxable: Boolean(rule.researchReagentTaxable),
      universityExemptionAllowed: Boolean(rule.universityExemptionAllowed),
      resaleCertificateAllowed: Boolean(rule.resaleCertificateAllowed),
      wooTaxClass: rule.wooTaxClass,
      notes: rule.notes,
      avgCombinedTaxRate: rule.avgCombinedTaxRate,
      exampleTaxOn100kSales: rule.exampleTaxOn100kSales,
      taxCollectionRequiredAfterNexus: Boolean(rule.taxCollectionRequiredAfterNexus),
      bufferedTaxRate: rule.bufferedTaxRate,
      exampleTaxOn100kSalesBuffered: rule.exampleTaxOn100kSalesBuffered,
      taxNexusApplied: Boolean(manualState.taxNexusApplied),
      trackingYear,
      trailing12MonthRevenueUsd,
      trailing12MonthTransactionCount,
      transactionCount: trailing12MonthTransactionCount,
      currentYearRevenueUsd: trailing12MonthRevenueUsd,
      currentYearOrderCount: trailing12MonthTransactionCount,
      revenueProgressRatio,
      transactionProgressRatio,
      warningLevel,
      warningReasons,
      exceededReasons,
      nexusTriggered,
      shouldCollectTax,
    };
    rows.push(row);
    if (warningLevel !== 'none') notifications.push(row);
  }

  rows.sort((left, right) => String(left.stateName || left.stateCode).localeCompare(String(right.stateName || right.stateCode)));
  notifications.sort((left, right) => {
    const leftLevel = left.warningLevel === 'exceeded' ? 0 : 1;
    const rightLevel = right.warningLevel === 'exceeded' ? 0 : 1;
    if (leftLevel !== rightLevel) return leftLevel - rightLevel;
    const leftRatio = Math.max(safeNumber(left.revenueProgressRatio, 0), safeNumber(left.transactionProgressRatio, 0));
    const rightRatio = Math.max(safeNumber(right.revenueProgressRatio, 0), safeNumber(right.transactionProgressRatio, 0));
    if (leftRatio !== rightRatio) return rightRatio - leftRatio;
    return String(left.stateName || left.stateCode).localeCompare(String(right.stateName || right.stateCode));
  });

  return {
    trackingYear,
    rollingWindowMonths: 12,
    periodStart,
    periodEnd,
    warningThresholdRatio: WARNING_RATIO,
    rows,
    notifications,
    summary: {
      trackedStateCount: rows.length,
      warningCount,
      exceededCount,
      shouldCollectTaxCount,
    },
    lastSyncedAt: new Date().toISOString(),
    ...(stale ? { stale: true } : {}),
  };
};

const buildFallbackStateTaxProfile = ({ stateCode, stateName }) => ({
  state: stateCode,
  stateCode,
  stateName,
  economicNexusRevenueUsd: null,
  economicNexusTransactions: null,
  collectTaxDefault: false,
  researchReagentTaxable: true,
  universityExemptionAllowed: true,
  resaleCertificateAllowed: true,
  wooTaxClass: null,
  notes: null,
  avgCombinedTaxRate: null,
  exampleTaxOn100kSales: null,
  taxCollectionRequiredAfterNexus: false,
  bufferedTaxRate: null,
  exampleTaxOn100kSalesBuffered: null,
  taxNexusApplied: false,
  trailing12MonthRevenueUsd: 0,
  trailing12MonthTransactionCount: 0,
  transactionCount: 0,
  currentYearRevenueUsd: 0,
  currentYearOrderCount: 0,
  revenueProgressRatio: null,
  transactionProgressRatio: null,
  warningLevel: 'none',
  warningReasons: [],
  exceededReasons: [],
  nexusTriggered: false,
  shouldCollectTax: false,
});

const mapMySqlTaxProfile = (row) => {
  if (!row) return null;
  const stateCode = String(row.state_code || row.stateCode || '').trim().toUpperCase();
  const stateName = String(row.state_name || row.state || row.stateName || '').trim() || STATE_NAME_BY_CODE[stateCode] || stateCode;
  const economicNexusRevenueUsd = row.economic_nexus_revenue_usd == null
    ? null
    : Number(safeNumber(row.economic_nexus_revenue_usd, 0).toFixed(2));
  const economicNexusTransactions = row.economic_nexus_transactions == null
    ? null
    : Number(row.economic_nexus_transactions || 0);
  const trailing12MonthRevenueUsd = Number(safeNumber(row.trailing_12mo_revenue, 0).toFixed(2));
  const trailing12MonthTransactionCount = Number(row.transaction_count || 0);
  const nexusTriggered = Boolean(row.nexus_triggered);
  const revenueProgressRatio =
    Number.isFinite(economicNexusRevenueUsd) && economicNexusRevenueUsd > 0
      ? Number((trailing12MonthRevenueUsd / economicNexusRevenueUsd).toFixed(4))
      : null;
  const transactionProgressRatio =
    Number.isFinite(economicNexusTransactions) && economicNexusTransactions > 0
      ? Number((trailing12MonthTransactionCount / economicNexusTransactions).toFixed(4))
      : null;

  const exceededReasons = [];
  const warningReasons = [];
  if (isThresholdExceeded({ metric: trailing12MonthRevenueUsd, threshold: economicNexusRevenueUsd })) {
    exceededReasons.push('revenue');
  } else if (isThresholdWarning({ metric: trailing12MonthRevenueUsd, threshold: economicNexusRevenueUsd })) {
    warningReasons.push('revenue');
  }
  if (isThresholdExceeded({ metric: trailing12MonthTransactionCount, threshold: economicNexusTransactions })) {
    exceededReasons.push('transactions');
  } else if (isThresholdWarning({ metric: trailing12MonthTransactionCount, threshold: economicNexusTransactions })) {
    warningReasons.push('transactions');
  }

  return {
    state: stateCode,
    stateCode,
    stateName,
    economicNexusRevenueUsd,
    economicNexusTransactions,
    collectTaxDefault: Boolean(row.collect_tax_default),
    researchReagentTaxable: Boolean(row.research_reagent_taxable),
    universityExemptionAllowed: Boolean(row.university_exemption_allowed),
    resaleCertificateAllowed: Boolean(row.resale_certificate_allowed),
    wooTaxClass: normalizeText(row.woo_tax_class),
    notes: normalizeText(row.notes),
    avgCombinedTaxRate: row.avg_combined_tax_rate == null
      ? null
      : Number(safeNumber(row.avg_combined_tax_rate, 0).toFixed(5)),
    exampleTaxOn100kSales: row.example_tax_on_100k_sales == null
      ? null
      : Number(safeNumber(row.example_tax_on_100k_sales, 0).toFixed(2)),
    taxCollectionRequiredAfterNexus: Boolean(row.tax_collection_required_after_nexus),
    bufferedTaxRate: row.buffered_tax_rate == null
      ? null
      : Number(safeNumber(row.buffered_tax_rate, 0).toFixed(5)),
    exampleTaxOn100kSalesBuffered: row.example_tax_on_100k_sales_buffered == null
      ? null
      : Number(safeNumber(row.example_tax_on_100k_sales_buffered, 0).toFixed(2)),
    taxNexusApplied: Boolean(row.tax_nexus_applied),
    trailing12MonthRevenueUsd,
    trailing12MonthTransactionCount,
    transactionCount: trailing12MonthTransactionCount,
    currentYearRevenueUsd: trailing12MonthRevenueUsd,
    currentYearOrderCount: trailing12MonthTransactionCount,
    revenueProgressRatio,
    transactionProgressRatio,
    warningLevel: nexusTriggered ? 'exceeded' : warningReasons.length ? 'warning' : 'none',
    warningReasons,
    exceededReasons,
    nexusTriggered,
    shouldCollectTax: Boolean(row.collect_tax_default)
      && Boolean(row.tax_collection_required_after_nexus)
      && Boolean(row.research_reagent_taxable)
      && nexusTriggered,
    taxClassForLookup: normalizeWooTaxClassForLookup(row.woo_tax_class),
    lastSyncedAt: row.last_synced_at ? new Date(row.last_synced_at).toISOString() : null,
  };
};

const getTaxTrackingSnapshot = async ({ force = false } = {}) => {
  const nowMs = Date.now();
  if (!force && taxTrackingCache.data && taxTrackingCache.expiresAtMs > nowMs) {
    return taxTrackingCache.data;
  }

  const rules = loadRules();
  try {
    const bounds = rollingTwelveMonthBounds();
    const { metricsByState } = await fetchWooMetrics({
      startMs: bounds.startMs,
      endMs: bounds.endMs,
      type: 'tracking',
    });
    await syncRulesToMySql(rules);
    await syncMetricsToMySql(rules, metricsByState, bounds);
    const manualStateByCode = await fetchTaxTrackingManualStateMap();
    const payload = buildTrackingPayload({
      rules,
      metricsByState,
      manualStateByCode,
      trackingYear: bounds.trackingYear,
      periodStart: bounds.periodStart,
      periodEnd: bounds.periodEnd,
    });
    taxTrackingCache.data = payload;
    taxTrackingCache.expiresAtMs = nowMs + (TAX_TRACKING_TTL_SECONDS * 1000);
    return payload;
  } catch (error) {
    logger.warn({ err: error }, 'Failed to build tax tracking snapshot');
    if (taxTrackingCache.data) {
      return { ...taxTrackingCache.data, stale: true };
    }
    const bounds = rollingTwelveMonthBounds();
    const payload = buildTrackingPayload({
      rules,
      metricsByState: {},
      trackingYear: bounds.trackingYear,
      periodStart: bounds.periodStart,
      periodEnd: bounds.periodEnd,
      stale: true,
    });
    taxTrackingCache.data = payload;
    taxTrackingCache.expiresAtMs = nowMs + (TAX_TRACKING_TTL_SECONDS * 1000);
    return payload;
  }
};

const getStateTaxProfile = async (state, { force = false } = {}) => {
  const { stateCode, stateName } = canonicalizeState(state);
  if (!stateCode || stateCode === 'UNKNOWN') {
    return buildFallbackStateTaxProfile({ stateCode, stateName });
  }

  if (mysqlClient.isEnabled()) {
    try {
      const row = await mysqlClient.fetchOne(
        `
          SELECT
            tt.state_code,
            tt.state_name,
            tt.economic_nexus_revenue_usd,
            tt.economic_nexus_transactions,
            tt.collect_tax_default,
            tt.research_reagent_taxable,
            tt.university_exemption_allowed,
            tt.resale_certificate_allowed,
            tt.woo_tax_class,
            tt.notes,
            tt.avg_combined_tax_rate,
            tt.example_tax_on_100k_sales,
            tt.tax_collection_required_after_nexus,
            tt.buffered_tax_rate,
            tt.example_tax_on_100k_sales_buffered,
            tt.tax_nexus_applied,
            st.state,
            st.trailing_12mo_revenue,
            st.transaction_count,
            st.nexus_triggered,
            st.last_synced_at
          FROM tax_tracking tt
          LEFT JOIN state_sales_totals st
            ON st.state_code = tt.state_code
          WHERE tt.state_code = :stateCode
          LIMIT 1
        `,
        { stateCode },
      );
      const mapped = mapMySqlTaxProfile(row);
      if (mapped) return mapped;
    } catch (error) {
      logger.warn({ err: error, stateCode }, 'Failed to load state tax profile from MySQL');
    }
  }

  const snapshot = await getTaxTrackingSnapshot({ force });
  const match = Array.isArray(snapshot?.rows)
    ? snapshot.rows.find((row) => String(row.stateCode || row.state).toUpperCase() === stateCode)
    : null;
  if (match) {
    return {
      ...match,
      taxClassForLookup: normalizeWooTaxClassForLookup(match.wooTaxClass),
    };
  }
  return buildFallbackStateTaxProfile({ stateCode, stateName });
};

const getAdminTaxesByStateReport = async ({ periodStart, periodEnd, force = false } = {}) => {
  const bounds = resolveReportBounds({ periodStart, periodEnd });
  const cacheKey = `${bounds.periodStart}::${bounds.periodEnd}`;
  const nowMs = Date.now();
  if (!force && adminTaxesByStateCache.data && adminTaxesByStateCache.key === cacheKey && adminTaxesByStateCache.expiresAtMs > nowMs) {
    return adminTaxesByStateCache.data;
  }

  try {
    const taxTracking = await getTaxTrackingSnapshot({ force });
    const { rows, orderLines, totals } = await fetchWooMetrics({
      startMs: bounds.startMs,
      endMs: bounds.endMs,
      type: 'report',
    });
    const payload = {
      rows,
      totals,
      orderTaxes: orderLines,
      taxTracking,
      periodStart: bounds.periodStart,
      periodEnd: bounds.periodEnd,
    };
    adminTaxesByStateCache.key = cacheKey;
    adminTaxesByStateCache.data = payload;
    adminTaxesByStateCache.expiresAtMs = nowMs + (ADMIN_TAXES_BY_STATE_TTL_SECONDS * 1000);
    return payload;
  } catch (error) {
    logger.warn({ err: error, cacheKey }, 'Failed to build taxes by state admin report');
    if (adminTaxesByStateCache.data && adminTaxesByStateCache.key === cacheKey) {
      return { ...adminTaxesByStateCache.data, stale: true, error: 'Taxes-by-state report is temporarily unavailable.' };
    }
    const taxTracking = await getTaxTrackingSnapshot({ force }).catch(() => ({
      rows: [],
      notifications: [],
      summary: {
        trackedStateCount: 0,
        warningCount: 0,
        exceededCount: 0,
        shouldCollectTaxCount: 0,
      },
    }));
    return {
      rows: [],
      totals: { orderCount: 0, taxTotal: 0 },
      orderTaxes: [],
      taxTracking,
      periodStart: bounds.periodStart,
      periodEnd: bounds.periodEnd,
      stale: true,
      error: 'Taxes-by-state report is temporarily unavailable.',
    };
  }
};

const setTaxNexusApplied = async (state, taxNexusApplied) => {
  const { stateCode, stateName } = canonicalizeState(state);
  if (!stateCode || stateCode === 'UNKNOWN' || !STATE_NAME_BY_CODE[stateCode]) {
    const error = new Error('A valid US state is required');
    error.status = 400;
    throw error;
  }
  if (!mysqlClient.isEnabled()) {
    const error = new Error('MySQL is required to update tax nexus filing status');
    error.status = 503;
    throw error;
  }

  const rules = loadRules();
  await syncRulesToMySql(rules);
  await mysqlClient.execute(
    `
      INSERT INTO tax_tracking (
        state_code,
        state_name,
        tax_nexus_applied
      )
      VALUES (
        :stateCode,
        :stateName,
        :taxNexusApplied
      )
      ON DUPLICATE KEY UPDATE
        state_name = VALUES(state_name),
        tax_nexus_applied = VALUES(tax_nexus_applied),
        updated_at = CURRENT_TIMESTAMP
    `,
    {
      stateCode,
      stateName,
      taxNexusApplied: taxNexusApplied ? 1 : 0,
    },
  );

  invalidateTaxTrackingCaches();
  const row = await getStateTaxProfile(stateCode, { force: true });
  return {
    state: stateCode,
    stateCode,
    stateName,
    taxNexusApplied: Boolean(row?.taxNexusApplied),
    row,
  };
};

module.exports = {
  canonicalizeState,
  getTaxTrackingSnapshot,
  getAdminTaxesByStateReport,
  getStateTaxProfile,
  setTaxNexusApplied,
};
