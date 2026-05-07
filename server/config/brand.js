const BRAND = Object.freeze({
  name: 'TruFusionLabs',
  appUrl: 'https://www.trufusionlabs.com',
  apexUrl: 'https://trufusionlabs.com',
  apiUrl: 'https://api.trufusionlabs.com',
  shopUrl: 'https://shop.trufusionlabs.com',
  portUrl: 'https://port.trufusionlabs.com',
  supportEmail: 'support@trufusionlabs.com',
  legacySupportEmail: 'support@peppro.net',
  logoPath: 'public/TruFusionLabs_PhysiciansPortal.png',
});

const LEGACY_BRAND = Object.freeze({
  name: 'PepPro',
  orderTable: 'peppro_orders',
  orderMetaPrefix: 'peppro',
  supportEmail: 'support@peppro.net',
});

const legacyMetaKey = (key) => {
  const normalized = String(key || '');
  return normalized.startsWith('trufusion')
    ? `peppro${normalized.slice('trufusion'.length)}`
    : null;
};

const withLegacyMetaKeys = (keys) => {
  const list = Array.isArray(keys) ? keys : [keys];
  const expanded = [];
  list.forEach((key) => {
    if (key && !expanded.includes(key)) expanded.push(key);
    const legacy = legacyMetaKey(key);
    if (legacy && !expanded.includes(legacy)) expanded.push(legacy);
  });
  return expanded;
};

module.exports = {
  BRAND,
  LEGACY_BRAND,
  legacyMetaKey,
  withLegacyMetaKeys,
};
