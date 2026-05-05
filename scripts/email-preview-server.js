const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const preferredPort = Number(process.env.EMAIL_PREVIEW_PORT || process.env.PORT || 4174);

const templates = [
  {
    id: 'shipping-shipped',
    label: 'Shipping: Shipped',
    source: 'python_backend/services/email_service.py::_build_shipping_status_email',
  },
  {
    id: 'shipping-out-for-delivery',
    label: 'Shipping: Out for delivery',
    source: 'python_backend/services/email_service.py::_build_shipping_status_email',
  },
  {
    id: 'shipping-delivered',
    label: 'Shipping: Delivered',
    source: 'python_backend/services/email_service.py::_build_shipping_status_email',
  },
  {
    id: 'password-reset-python',
    label: 'Password reset: Python backend',
    source: 'python_backend/services/email_service.py::_build_password_reset_email',
  },
  {
    id: 'delegate-proposal',
    label: 'Delegate proposal ready',
    source: 'python_backend/services/email_service.py::_build_delegate_proposal_ready_email',
  },
  {
    id: 'delegate-links-info',
    label: 'Delegate Links Beta info',
    source: 'python_backend/services/email_service.py::_build_delegate_links_beta_info_email',
  },
  {
    id: 'payment-instructions-node',
    label: 'Payment instructions: Node backend',
    source: 'server/templates/paymentInstructions.html',
  },
  {
    id: 'password-reset-node',
    label: 'Password reset: Node backend',
    source: 'server/templates/passwordReset.html',
  },
];

const pythonPreviewCode = String.raw`
import json
import sys
import types

requests = types.ModuleType("requests")
requests.RequestException = Exception
requests.HTTPError = Exception
requests.Timeout = TimeoutError
requests_auth = types.ModuleType("requests.auth")

class HTTPBasicAuth:
    def __init__(self, *_args, **_kwargs):
        pass

requests_auth.HTTPBasicAuth = HTTPBasicAuth
requests.auth = requests_auth
sys.modules["requests"] = requests
sys.modules["requests.auth"] = requests_auth

from python_backend.services import email_service

template = sys.argv[1]
base_url = "https://trufusionlabs.com"

if template == "shipping-shipped":
    subject, html, plain = email_service._build_shipping_status_email(
        customer_name="Holly O'Quin",
        order_number="1505",
        status="shipped",
        tracking_number="1ZSHIP1505",
        carrier_code="ups",
        delivery_label="May 6, 2026",
        base_url=base_url,
    )
elif template == "shipping-out-for-delivery":
    subject, html, plain = email_service._build_shipping_status_email(
        customer_name="Holly O'Quin",
        order_number="1505",
        status="out_for_delivery",
        tracking_number="1ZSHIP1505",
        carrier_code="ups",
        delivery_label="Today",
        base_url=base_url,
    )
elif template == "shipping-delivered":
    subject, html, plain = email_service._build_shipping_status_email(
        customer_name="Holly O'Quin",
        order_number="1505",
        status="delivered",
        tracking_number="1ZSHIP1505",
        carrier_code="ups",
        delivery_label="May 6, 2026",
        base_url=base_url,
    )
elif template == "password-reset-python":
    html, plain = email_service._build_password_reset_email(
        reset_url="https://trufusionlabs.com/reset-password?token=preview-token",
        base_url=base_url,
    )
    subject = "Reset your TruFusionLabs password"
elif template == "delegate-proposal":
    html, plain = email_service._build_delegate_proposal_ready_email(
        doctor_name="Dr. Holly O'Quin",
        proposal_label="Wellness Protocol Proposal #2471",
        submitted_at_label="May 3, 2026 at 2:15 PM",
        base_url=base_url,
    )
    subject = "Delegate proposal ready for review"
elif template == "delegate-links-info":
    html, plain = email_service._build_delegate_links_beta_info_email(
        base_url=base_url,
    )
    subject = "Welcome to the Delegate Links Beta"
else:
    raise SystemExit(f"unknown python template: {template}")

html = html.replace("cid:trufusion-logo", "/assets/turfusionlabsphysiciansportal.png")
html = html.replace("cid:trufusion-leaf", "/assets/blueleafTexture-email.png")
html = html.replace("cid:delegate-white-label-sessions", "/assets/delegate-links-white-label-email.png")

print(json.dumps({"subject": subject, "html": html, "plain": plain}))
`;

const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const readTemplate = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');

const renderPythonTemplate = (templateId) => {
  const result = spawnSync('python3', ['-c', pythonPreviewCode, templateId], {
    cwd: repoRoot,
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || 'Python renderer failed').trim());
  }

  return JSON.parse(result.stdout);
};

const renderPaymentInstructions = () => {
  const template = readTemplate('server/templates/paymentInstructions.html');
  const zelleSection = `
      <h3 style="margin: 18px 0 8px; font-size: 16px; color: #0f172a;">Option A: Pay with Zelle</h3>
      <p style="margin: 8px 0 0; color: #334155; line-height: 1.6;">
        Use Zelle in your bank app and send the <strong>Amount to send</strong> shown above to:
      </p>
      <ul style="margin: 8px 0 0 18px; padding: 0; color: #334155; line-height: 1.6;">
        <li><strong>Zelle email</strong>: support@peppro.net</li>
      </ul>
      <ol style="margin: 10px 0 0 18px; padding: 0; color: #334155; line-height: 1.6;">
        <li>Send the exact amount shown above.</li>
        <li>Set the memo/notes to the exact value shown above.</li>
        <li>Once received, we'll begin processing your order.</li>
      </ol>
    `;
  const bankSection = `
      <h3 style="margin: 18px 0 8px; font-size: 16px; color: #0f172a;">Option B: Direct Bank Transfer</h3>
      <p style="margin: 8px 0 0; color: #334155; line-height: 1.6;">
        Reply to this email or contact <a href="mailto:support@trufusionlabs.com">support@trufusionlabs.com</a> for bank transfer instructions.
      </p>
    `;

  const html = template
    .replaceAll('{{logoUrl}}', '/assets/turfusionlabsphysiciansportal.png')
    .replaceAll('{{customerName}}', 'Holly O&#39;Quin')
    .replaceAll('{{orderNumber}}', '1505')
    .replaceAll('{{orderTotal}}', '$372.42')
    .replaceAll('{{discountDetails}}', '<br /><strong>Discount code used</strong>: PREVIEW10')
    .replaceAll('{{supportEmail}}', 'support@trufusionlabs.com')
    .replaceAll('{{zelleSection}}', zelleSection)
    .replaceAll('{{bankTransferSection}}', bankSection);

  return {
    subject: 'TruFusionLabs payment instructions - Order 1505',
    html,
    plain: 'Payment instructions preview',
  };
};

const renderNodePasswordReset = () => {
  const html = readTemplate('server/templates/passwordReset.html')
    .replaceAll('{{resetUrl}}', 'https://trufusionlabs.com/reset-password?token=preview-token');
  return {
    subject: 'Password Reset Request',
    html,
    plain: 'Password reset preview',
  };
};

const renderTemplate = (templateId) => {
  if (templateId === 'payment-instructions-node') {
    return renderPaymentInstructions();
  }
  if (templateId === 'password-reset-node') {
    return renderNodePasswordReset();
  }
  return renderPythonTemplate(templateId);
};

const renderShell = (selectedId) => {
  const selected = templates.find((template) => template.id === selectedId) || templates[0];
  const options = templates
    .map((template) => `<option value="${template.id}" ${template.id === selected.id ? 'selected' : ''}>${escapeHtml(template.label)}</option>`)
    .join('');

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Email Preview</title>
    <style>
      :root { color-scheme: light; }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: #e5e7eb;
        color: #111827;
      }
      header {
        display: flex;
        align-items: center;
        gap: 14px;
        padding: 12px 16px;
        background: #ffffff;
        border-bottom: 1px solid #d1d5db;
      }
      label {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 13px;
        color: #374151;
      }
      select {
        min-width: 260px;
        padding: 8px 34px 8px 10px;
        border: 1px solid #cbd5e1;
        border-radius: 8px;
        background: #fff;
        color: #111827;
        font: inherit;
      }
      .meta {
        min-width: 0;
        color: #4b5563;
        font-size: 13px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      iframe {
        display: block;
        width: 100%;
        height: calc(100vh - 57px);
        border: 0;
        background: #ffffff;
      }
    </style>
  </head>
  <body>
    <header>
      <label>
        Template
        <select id="templateSelect">${options}</select>
      </label>
      <div class="meta">${escapeHtml(selected.source)}</div>
    </header>
    <iframe id="preview" src="/email?template=${encodeURIComponent(selected.id)}"></iframe>
    <script>
      const select = document.getElementById('templateSelect');
      const preview = document.getElementById('preview');
      const sources = ${JSON.stringify(Object.fromEntries(templates.map((template) => [template.id, template.source])))};
      const meta = document.querySelector('.meta');
      select.addEventListener('change', () => {
        preview.src = '/email?template=' + encodeURIComponent(select.value) + '&t=' + Date.now();
        meta.textContent = sources[select.value] || '';
        history.replaceState(null, '', '/?template=' + encodeURIComponent(select.value));
      });
    </script>
  </body>
</html>`;
};

const contentTypes = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

const serveAsset = (requestPath, res) => {
  const fileName = path.basename(requestPath);
  const filePath = path.join(repoRoot, 'public', fileName);
  if (!fs.existsSync(filePath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }
  const extension = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    'Content-Type': contentTypes[extension] || 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(filePath).pipe(res);
};

const handleRequest = (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const selectedId = url.searchParams.get('template') || templates[0].id;

  try {
    if (url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(renderShell(selectedId));
      return;
    }

    if (url.pathname === '/email') {
      const rendered = renderTemplate(selectedId);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(rendered.html);
      return;
    }

    if (url.pathname.startsWith('/assets/')) {
      serveAsset(url.pathname, res);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(error instanceof Error ? error.stack : String(error));
  }
};

const listen = (port) => {
  const server = http.createServer(handleRequest);
  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE' && port < preferredPort + 20) {
      listen(port + 1);
      return;
    }
    console.error(error);
    process.exit(1);
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`Email preview: http://127.0.0.1:${port}/`);
  });
};

listen(preferredPort);
