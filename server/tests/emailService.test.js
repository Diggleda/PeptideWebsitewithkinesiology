const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const os = require('node:os');

const servicePath = '../services/emailService';

const clearService = () => {
  delete require.cache[require.resolve(servicePath)];
};

const withFreshEmailService = async (run) => {
  const originalLoad = Module._load;
  const originalEnv = { ...process.env };
  const sent = [];

  process.env.SMTP_HOST = 'smtp.example.com';
  process.env.SMTP_USER = 'support@trufusionlabs.com';
  process.env.SMTP_PASS = 'secret';
  process.env.MAIL_FROM = '"TrufusionLabs" <support@trufusionlabs.com>';
  process.env.REFUND_NOTIFICATION_EMAILS = 'ops@trufusionlabs.com';

  clearService();
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'nodemailer') {
      return {
        createTransport: () => ({
          sendMail: async (mailOptions) => {
            sent.push(mailOptions);
          },
        }),
      };
    }
    if (request === '../config/env') {
      return {
        env: {
          dataDir: os.tmpdir(),
          frontendBaseUrl: 'https://trufusionlabs.com',
          nodeEnv: 'test',
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const service = require(servicePath);
    await run(service, sent);
  } finally {
    Module._load = originalLoad;
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
    clearService();
  }
};

const assertSharedEmailStyling = (html) => {
  assert.match(html, /FullLogo_Transparent_NoBuffer%20\(18\)\.png/);
  assert.match(html, /background:#ffffff|background-color:#ffffff/);
  assert.doesNotMatch(html, /TrufusionLabs_PhysiciansPortal/);
  assert.doesNotMatch(html, /rgb\(55,126,186\)/);
  assert.doesNotMatch(html, /border-radius:999px/);
};

test('node password reset email uses TrufusionLabs logo, white background, and squircle button', async () => {
  await withFreshEmailService(async (emailService, sent) => {
    await emailService.sendPasswordResetEmail('doctor@example.com', 'reset-token');

    assert.equal(sent.length, 1);
    assertSharedEmailStyling(sent[0].html);
    assert.match(sent[0].html, /border-radius:12px/);
    assert.match(sent[0].html, /background-image:linear-gradient\(#0B0679,#0B0679\)/);
  });
});

test('payment instructions email uses shared white TrufusionLabs styling', async () => {
  await withFreshEmailService(async (emailService, sent) => {
    await emailService.sendOrderPaymentInstructionsEmail({
      to: 'doctor@example.com',
      customerName: 'Dr. Test',
      orderId: 'order-1',
      wooOrderNumber: '1505',
      total: 125.5,
      discountCode: null,
      discountCodeAmount: 0,
    });

    assert.equal(sent.length, 1);
    assertSharedEmailStyling(sent[0].html);
  });
});

test('manual refund review email uses shared white TrufusionLabs styling', async () => {
  await withFreshEmailService(async (emailService, sent) => {
    await emailService.sendManualRefundReviewEmail({
      orderId: 'order-1',
      wooOrderNumber: '1505',
      customerName: 'Dr. Test',
      customerEmail: 'doctor@example.com',
      paymentMethod: 'Zelle',
      total: 125.5,
      reason: 'Cancelled via account portal',
    });

    assert.equal(sent.length, 1);
    assertSharedEmailStyling(sent[0].html);
  });
});
