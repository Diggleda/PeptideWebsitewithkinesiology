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

test('delegate resolve page-load counter records opens without consuming uses', () => {
  const { recordResolveOpenFallback, shouldCountResolvePageLoad } = delegationRoutes.__test__;
  const link = { usageCount: 2, openCount: 5, lastUsedAt: null, lastOpenedAt: null };

  assert.equal(shouldCountResolvePageLoad({}), true);
  assert.equal(shouldCountResolvePageLoad({ countPageLoad: '1' }), true);
  assert.equal(shouldCountResolvePageLoad({ countPageLoad: '0' }), false);
  assert.equal(shouldCountResolvePageLoad({ countPageLoad: 'poll' }), false);

  recordResolveOpenFallback(link, Date.parse('2026-05-07T12:00:00.000Z'));
  assert.equal(link.usageCount, 2);
  assert.equal(link.openCount, 6);
  assert.equal(link.viewCount, 6);
  assert.equal(link.firstViewedAt, '2026-05-07T12:00:00.000Z');
  assert.equal(link.lastViewedAt, '2026-05-07T12:00:00.000Z');
  assert.equal(link.lastUsedAt, '2026-05-07T12:00:00.000Z');
  assert.equal(link.lastOpenedAt, '2026-05-07T12:00:00.000Z');

  recordResolveOpenFallback(link, Date.parse('2026-05-07T12:05:00.000Z'));
  assert.equal(link.usageCount, 2);
  assert.equal(link.openCount, 7);
  assert.equal(link.viewCount, 7);
  assert.equal(link.firstViewedAt, '2026-05-07T12:00:00.000Z');
  assert.equal(link.lastViewedAt, '2026-05-07T12:05:00.000Z');
  assert.equal(link.lastUsedAt, '2026-05-07T12:05:00.000Z');
  assert.equal(link.lastOpenedAt, '2026-05-07T12:05:00.000Z');
});
