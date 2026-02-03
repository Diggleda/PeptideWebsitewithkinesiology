export const MERCHANT_IDENTITY = {
  brand: 'PepPro',
  dba: 'PepPro',
  legalEntity: '[LEGAL ENTITY NAME]',
  address: '12141 Skyline Dr Santa Ana, CA 92705 US',
  phone: '(714) 932-0232',
  email: 'support@peppro.net',
  businessHours: 'Mon–Fri, 9am–5pm CT',
} as const;

export type MerchantIdentity = typeof MERCHANT_IDENTITY;
