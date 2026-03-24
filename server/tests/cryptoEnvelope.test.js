const test = require('node:test');
const assert = require('node:assert/strict');

const loadCrypto = ({
  key = 'test-master-key',
  blindIndexKey = 'test-blind-index-key',
  keyVersion = 'test-v1',
  kmsKeyId = 'kms-test',
} = {}) => {
  process.env.DATA_ENCRYPTION_KEY = key;
  process.env.DATA_ENCRYPTION_BLIND_INDEX_KEY = blindIndexKey;
  process.env.DATA_ENCRYPTION_KEY_VERSION = keyVersion;
  process.env.DATA_ENCRYPTION_KMS_KEY_ID = kmsKeyId;

  delete require.cache[require.resolve('../config/env')];
  delete require.cache[require.resolve('../utils/cryptoEnvelope')];

  return require('../utils/cryptoEnvelope');
};

test('encryptText round-trips with matching aad', () => {
  const cryptoEnvelope = loadCrypto();
  const aad = { table: 'patient_links', record_ref: 'abc', field: 'patient_id' };
  const ciphertext = cryptoEnvelope.encryptText('patient-123', { aad });

  const plaintext = cryptoEnvelope.decryptText(ciphertext, { aad });

  assert.equal(plaintext, 'patient-123');
});

test('decryptText rejects aad mismatches', () => {
  const cryptoEnvelope = loadCrypto();
  const ciphertext = cryptoEnvelope.encryptText('patient-123', {
    aad: { table: 'patient_links', record_ref: 'abc', field: 'patient_id' },
  });

  assert.throws(() => {
    cryptoEnvelope.decryptText(ciphertext, {
      aad: { table: 'patient_links', record_ref: 'other', field: 'patient_id' },
    });
  });
});

test('decryptText rejects wrong keys', () => {
  const cryptoEnvelope = loadCrypto({ key: 'first-master-key' });
  const aad = { table: 'patient_links', record_ref: 'abc', field: 'patient_id' };
  const ciphertext = cryptoEnvelope.encryptText('patient-123', { aad });
  const rotated = loadCrypto({ key: 'second-master-key' });

  assert.throws(() => {
    rotated.decryptText(ciphertext, { aad });
  });
});

test('computeBlindIndex is stable for normalized emails', () => {
  const cryptoEnvelope = loadCrypto();

  const first = cryptoEnvelope.computeBlindIndex('Doctor@Example.com ', {
    label: 'contact_forms.email',
    normalizer: (value) => value.trim().toLowerCase(),
  });
  const second = cryptoEnvelope.computeBlindIndex('doctor@example.com', {
    label: 'contact_forms.email',
    normalizer: (value) => value.trim().toLowerCase(),
  });

  assert.equal(first, second);
});
