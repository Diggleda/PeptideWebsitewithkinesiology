export type ReferralStatus =
  | 'pending'
  | 'contacted'
  | 'account_created'
  | 'nuture'
  | 'converted'
  | 'contact_form';

export interface ReferralRecord {
  id: string;
  referrerDoctorId: string;
  salesRepId: string | null;
  referredContactName: string;
  referredContactEmail?: string | null;
  referredContactPhone?: string | null;
  referralCodeId?: string | null;
  status: ReferralStatus | string;
  createdAt: string;
  updatedAt: string;
  convertedDoctorId?: string | null;
  convertedAt?: string | null;
  notes?: string | null;
  referrerDoctorName?: string | null;
  referrerDoctorEmail?: string | null;
  referrerDoctorPhone?: string | null;
  creditIssuedAt?: string | null;
  creditIssuedAmount?: number | null;
  creditIssuedBy?: string | null;
  referredContactHasAccount?: boolean;
  referredContactAccountId?: string | null;
  referredContactAccountName?: string | null;
  referredContactAccountEmail?: string | null;
  referredContactAccountCreatedAt?: string | null;
  referredContactTotalOrders?: number;
  referredContactEligibleForCredit?: boolean;
}

export interface ReferralCodeRecord {
  id: string;
  salesRepId: string;
  referrerDoctorId?: string | null;
  referralId?: string | null;
  doctorId?: string | null;
  code: string;
  status: 'available' | 'assigned' | 'revoked' | 'retired';
  issuedAt?: string | null;
  updatedAt?: string | null;
  redeemedAt?: string | null;
  history?: Array<{
    action: string;
    at: string;
    by?: string;
    status?: string;
    doctorId?: string;
  }>;
}

export interface CreditLedgerEntry {
  id: string;
  doctorId: string;
  salesRepId?: string | null;
  referralId?: string | null;
  orderId?: string | null;
  amount: number;
  currency: string;
  direction: 'credit' | 'debit';
  reason: 'referral_bonus' | 'manual_adjustment' | 'reversal';
  description?: string | null;
  firstOrderBonus: boolean;
  issuedAt: string;
  metadata?: Record<string, unknown>;
}

export interface DoctorCreditSummary {
  totalCredits: number;
  availableCredits: number;
  netCredits?: number;
  firstOrderBonuses: number;
  ledger: CreditLedgerEntry[];
}

export interface SalesRepDashboard {
  referrals: ReferralRecord[];
  codes: ReferralCodeRecord[];
  statuses?: string[];
}
