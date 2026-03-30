export type ProspectQuoteStatus = 'draft' | 'exported';

export type ProspectQuoteLineItem = {
  position: number;
  productId: string | null;
  variantId: string | null;
  sku: string | null;
  imageUrl: string | null;
  name: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  note: string | null;
};

export type ProspectQuotePayload = {
  title: string;
  notes: string | null;
  pricingMode: 'wholesale' | 'retail';
  currency: string;
  subtotal: number;
  items: ProspectQuoteLineItem[];
  prospect: {
    identifier?: string | null;
    id?: string | null;
    status?: string | null;
    salesRepId?: string | null;
    doctorId?: string | null;
    referralId?: string | null;
    contactFormId?: string | null;
    contactName?: string | null;
    contactEmail?: string | null;
    contactPhone?: string | null;
  } | null;
  salesRep: {
    id?: string | null;
    name?: string | null;
    email?: string | null;
  } | null;
};

export type ProspectQuoteRevision = {
  id: string;
  prospectId: string;
  salesRepId: string;
  revisionNumber: number;
  status: ProspectQuoteStatus;
  title: string;
  currency: string;
  subtotal: number;
  createdAt: string;
  updatedAt: string;
  exportedAt: string | null;
};

export type ProspectQuoteDetail = ProspectQuoteRevision & {
  quotePayloadJson: ProspectQuotePayload | null;
};

export type ProspectQuoteListResponse = {
  prospect: Record<string, unknown> | null;
  currentDraft: ProspectQuoteDetail | null;
  history: ProspectQuoteRevision[];
};

export type ProspectQuoteImportPayload = {
  title?: string | null;
  notes?: string | null;
  pricingMode: 'wholesale' | 'retail';
  currency: string;
  subtotal: number;
  items: ProspectQuoteLineItem[];
  prospectSnapshot?: {
    identifier?: string | null;
    salesRepId?: string | null;
    ownerSalesRepId?: string | null;
    doctorId?: string | null;
    referralId?: string | null;
    contactFormId?: string | null;
    sourceSystem?: string | null;
    status?: string | null;
    contactName?: string | null;
    contactEmail?: string | null;
    contactPhone?: string | null;
    referredContactName?: string | null;
    referredContactEmail?: string | null;
    referredContactPhone?: string | null;
  } | null;
};
