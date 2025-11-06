export type AuthActionResult =
  | { status: 'success' }
  | { status: 'email_not_found' }
  | { status: 'invalid_password' }
  | { status: 'email_exists' }
  | { status: 'password_mismatch' }
  | { status: 'invalid_referral_code' }
  | { status: 'referral_code_not_found' }
  | { status: 'referral_code_unavailable' }
  | { status: 'sales_rep_email_mismatch' }
  | { status: 'sales_rep_signup_required' }
  | { status: 'name_email_required' }
  | { status: 'error'; message?: string };
