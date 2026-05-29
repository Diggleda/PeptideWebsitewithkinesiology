const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const preferredPort = Number(process.env.EMAIL_PREVIEW_PORT || process.env.PORT || 4174);

const templates = [
  {
    id: 'delegate_links_announcement',
    label: 'Email Center: Delegate Links Announcement',
    source: 'python_backend/email_templates/announcements/delegate_links_announcement.html',
  },
  {
    id: 'shipping-shipped',
    label: 'Shipping: Shipped',
    source: 'python_backend/services/email_service.py::send_order_shipping_status_email',
  },
  {
    id: 'shipping-in-transit',
    label: 'Shipping: In transit',
    source: 'python_backend/services/email_service.py::send_order_shipping_status_email',
  },
  {
    id: 'shipping-out-for-delivery',
    label: 'Shipping: Out for delivery',
    source: 'python_backend/services/email_service.py::send_order_shipping_status_email',
  },
  {
    id: 'shipping-delivered',
    label: 'Shipping: Delivered',
    source: 'python_backend/services/email_service.py::send_order_shipping_status_email',
  },
  {
    id: 'shipping-facility-pickup',
    label: 'Shipping: Facility pickup',
    source: 'python_backend/services/email_service.py::send_order_shipping_status_email',
  },
  {
    id: 'password-reset-python',
    label: 'Password reset',
    source: 'python_backend/services/email_service.py::send_password_reset_email',
  },
  {
    id: 'contact-form-received',
    label: 'Contact form received',
    source: 'python_backend/services/email_service.py::send_contact_form_received_email',
  },
  {
    id: 'delegate-proposal',
    label: 'Delegate proposal ready',
    source: 'python_backend/services/email_service.py::send_delegate_proposal_ready_email',
  },
  {
    id: 'delegate-links-info',
    label: 'Delegate Links welcome',
    source: 'python_backend/services/email_service.py::_build_delegate_links_beta_info_email',
  },
];

const sampleVariables = {
  doctor_name: 'Dr. Jane Example',
  clinic_name: 'Example Clinic',
  delegate_links_url: 'https://trufusionlabs.com/account?tab=delegate-links',
  unsubscribe_url: 'https://trufusionlabs.com/api/admin/email/unsubscribe?preview=1',
  support_email: 'support@trufusionlabs.com',
};

const assetReplacements = {
  'cid:trufusion-logo': '/assets/FullLogo_Transparent_NoBuffer%20(18).png',
  'cid:trufusion-leaf': '/assets/leafTexture.jpg',
  'cid:delegate-white-label-sessions': '/assets/delegate-links-white-label-email.png',
  'cid:delegate-links-proposal-session': '/assets/PatientLinks4.png',
  'cid:delegate-links-create-dialog': '/assets/PatientLinks3.png',
};

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
elif template == "shipping-in-transit":
    subject, html, plain = email_service._build_shipping_status_email(
        customer_name="Holly O'Quin",
        order_number="1505",
        status="in_transit",
        tracking_number="1ZSHIP1505",
        carrier_code="ups",
        delivery_label="Tuesday, April 7, 2026, between 2:00 PM - 6:00 PM",
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
elif template == "shipping-facility-pickup":
    subject, html, plain = email_service._build_shipping_status_email(
        customer_name="Marcus Barrera",
        order_number="1615",
        status="shipped",
        tracking_number=None,
        carrier_code="facility_pickup",
        delivery_label=None,
        base_url=base_url,
        fulfillment_label="Facility Pickup",
    )
elif template == "password-reset-python":
    html, plain = email_service._build_password_reset_email(
        reset_url="https://trufusionlabs.com/reset-password?token=preview-token",
        base_url=base_url,
    )
    subject = "Password Reset Request"
elif template == "contact-form-received":
    html, plain = email_service._build_contact_form_received_email(
        name="Dr. Jane Example",
        base_url=base_url,
    )
    subject = "We received your TrufusionLabs contact request"
elif template == "delegate-proposal":
    html, plain = email_service._build_delegate_proposal_ready_email(
        doctor_name="Dr. Holly O'Quin",
        proposal_label="Wellness Protocol Proposal #2471",
        submitted_at_label="May 3, 2026 at 2:15 PM",
        base_url=base_url,
    )
    subject = "Delegate Proposal Ready for Review"
elif template == "delegate-links-info":
    html, plain = email_service._build_delegate_links_beta_info_email(
        base_url=base_url,
    )
    subject = "Welcome to Delegate Links"
else:
    raise SystemExit(f"unknown python template: {template}")

html = html.replace("cid:trufusion-logo", "/assets/FullLogo_Transparent_NoBuffer%20(18).png")
html = html.replace("cid:trufusion-leaf", "/assets/leafTexture.jpg")
html = html.replace("cid:delegate-white-label-sessions", "/assets/delegate-links-white-label-email.png")
html = html.replace("cid:delegate-links-proposal-session", "/assets/PatientLinks4.png")
html = html.replace("cid:delegate-links-create-dialog", "/assets/PatientLinks3.png")

print(json.dumps({"subject": subject, "html": html, "plain": plain}))
`;

const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const rewriteCidAssets = (html) => Object.entries(assetReplacements).reduce(
  (nextHtml, [cid, assetPath]) => nextHtml.split(cid).join(assetPath),
  String(html || ''),
);

const renderFileTemplate = (templateId) => {
  if (templateId !== 'delegate_links_announcement') {
    throw new Error(`unknown file template: ${templateId}`);
  }
  const templatePath = path.join(repoRoot, 'python_backend', 'email_templates', 'announcements', 'delegate_links_announcement.html');
  const source = fs.readFileSync(templatePath, 'utf8');
  const html = rewriteCidAssets(source.replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (_match, variableName) => {
    return sampleVariables[variableName] || '';
  }));
  return {
    subject: 'Delegate Links are now available',
    html,
    plain: 'Delegate Links are now available.',
  };
};

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

const renderTemplate = (templateId) => {
  if (!templates.some((template) => template.id === templateId)) {
    throw new Error(`unknown preview template: ${templateId}`);
  }
  if (templateId === 'delegate_links_announcement') {
    return renderFileTemplate(templateId);
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
  let fileName = path.basename(requestPath);
  try {
    fileName = path.basename(decodeURIComponent(requestPath));
  } catch {
    // Keep the raw basename if the URL contains malformed escape sequences.
  }
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
