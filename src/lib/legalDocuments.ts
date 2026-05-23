import termsHtml from '../content/legal/terms.html?raw';
import privacyHtml from '../content/legal/privacy.html?raw';
import shippingHtml from '../content/legal/shipping.html?raw';
import returnsHtml from '../content/legal/returns.html?raw';
import contactHtml from '../content/legal/contact.html?raw';
import openSourceNoticesHtml from '../content/legal/open-source-notices.html?raw';

export type LegalDocumentKey =
  | 'terms'
  | 'privacy'
  | 'shipping'
  | 'returns'
  | 'contact'
  | 'open_source_notices';

export interface LegalDocumentContent {
  title: string;
  html: string;
  version: string;
  lastUpdated: string;
}

export interface ResearchAgreementSnapshot {
  researchTermsAgreement?: boolean | null;
  researchTermsAgreementVersion?: string | null;
  researchShippingPolicyVersion?: string | null;
  researchPrivacyPolicyVersion?: string | null;
}

const FALLBACK_LEGAL_VERSION = '2026.05.23';
const FALLBACK_LAST_UPDATED = 'May 23, 2026';

const decodeLegalText = (html: string) =>
  html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s+/g, '\n')
    .trim();

const extractLegalMetadata = (html: string) => {
  const text = decodeLegalText(html);
  return {
    version: text.match(/\bVersion:\s*([A-Za-z0-9._-]+)/i)?.[1] || FALLBACK_LEGAL_VERSION,
    lastUpdated:
      text.match(/\bLast Updated:\s*([^\n]+)/i)?.[1]?.trim() ||
      text.match(/\bLast updated:\s*([^\n|]+)/i)?.[1]?.trim() ||
      FALLBACK_LAST_UPDATED,
  };
};

const buildLegalDocument = (title: string, html: string): LegalDocumentContent => ({
  title,
  html,
  ...extractLegalMetadata(html),
});

export const LEGAL_DOCUMENTS: Record<LegalDocumentKey, LegalDocumentContent> = {
  terms: buildLegalDocument('Terms of Service', termsHtml),
  privacy: buildLegalDocument('Privacy Policy', privacyHtml),
  shipping: buildLegalDocument('Shipping Policy', shippingHtml),
  returns: buildLegalDocument('Returns & Refunds', returnsHtml),
  contact: buildLegalDocument('Contact', contactHtml),
  open_source_notices: buildLegalDocument('Open Source Notices', openSourceNoticesHtml),
};

export const CURRENT_LEGAL_DOCUMENT_VERSIONS = {
  terms: LEGAL_DOCUMENTS.terms.version,
  shipping: LEGAL_DOCUMENTS.shipping.version,
  privacy: LEGAL_DOCUMENTS.privacy.version,
} as const;

const normalizeVersion = (value: unknown) => String(value ?? '').trim();

export const hasCurrentResearchTermsAgreement = (
  snapshot: ResearchAgreementSnapshot | null | undefined,
) =>
  Boolean(snapshot?.researchTermsAgreement) &&
  normalizeVersion(snapshot?.researchTermsAgreementVersion) === CURRENT_LEGAL_DOCUMENT_VERSIONS.terms &&
  normalizeVersion(snapshot?.researchShippingPolicyVersion) === CURRENT_LEGAL_DOCUMENT_VERSIONS.shipping &&
  normalizeVersion(snapshot?.researchPrivacyPolicyVersion) === CURRENT_LEGAL_DOCUMENT_VERSIONS.privacy;

