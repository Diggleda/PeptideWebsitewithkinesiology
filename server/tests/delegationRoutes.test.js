const test = require('node:test');
const assert = require('node:assert/strict');

const delegationRoutes = require('../routes/delegationRoutes');

test('node delegate dummy resolve payload includes white-label settings', () => {
  const payload = delegationRoutes.__test__.buildNodeDummyResolvePayload(
    'node-ui-dummy-link',
    'Dr. Node',
    'data:image/png;base64,LOGO',
    '#123456',
    'data:image/jpeg;base64,BACKGROUND',
    '#abcdef',
  );

  assert.equal(payload.doctorLogoUrl, 'data:image/png;base64,LOGO');
  assert.equal(payload.doctorSecondaryColor, '#123456');
  assert.equal(payload.doctorBackgroundImageUrl, 'data:image/jpeg;base64,BACKGROUND');
  assert.equal(payload.doctorBackgroundColor, '#abcdef');
});
