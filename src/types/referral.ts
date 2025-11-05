export interface ReferralRecord {
  id: string;
  referrerDoctorId: string;
  salesRepId: string | null;
  referredContactName: string;
  referredContactEmail?: string | null;
  referredContactPhone?: string | null;
  referralCodeId?: string | null;
  status: 'pending' | 'in_review' | 'code_issued' | 'converted' | 'rejected';
  createdAt: string;
  updatedAt: string;
  convertedDoctorId?: string | null;
  convertedAt?: string | null;
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
  firstOrderBonuses: number;
  ledger: CreditLedgerEntry[];
}

export interface SalesRepDashboard {
  referrals: ReferralRecord[];
  codes: ReferralCodeRecord[];
}
