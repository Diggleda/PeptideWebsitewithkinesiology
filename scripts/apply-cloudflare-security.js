#!/usr/bin/env node

const API_BASE = "https://api.cloudflare.com/client/v4";
const zoneName = process.env.CLOUDFLARE_ZONE_NAME || "trufusionlabs.com";
const hostname = process.env.CLOUDFLARE_HOSTNAME || "www.trufusionlabs.com";
const scriptName = process.env.CLOUDFLARE_WORKER_SCRIPT || "trufusionlabs-security-headers";
const token = process.env.CLOUDFLARE_API_TOKEN || process.env.CF_API_TOKEN || "";
const modernTls12Ciphers = [
  "ECDHE-ECDSA-AES128-GCM-SHA256",
  "ECDHE-ECDSA-CHACHA20-POLY1305",
  "ECDHE-RSA-AES128-GCM-SHA256",
  "ECDHE-RSA-CHACHA20-POLY1305",
  "ECDHE-ECDSA-AES256-GCM-SHA384",
  "ECDHE-RSA-AES256-GCM-SHA384",
];

if (!token) {
  console.error("Missing CLOUDFLARE_API_TOKEN.");
  process.exit(1);
}

const request = async (path, options = {}) => {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { raw: text };
  }
  if (!response.ok || payload?.success === false) {
    const message = payload?.errors?.map((error) => error.message).join("; ") || response.statusText;
    throw new Error(`${options.method || "GET"} ${path} failed: ${message}`);
  }
  return payload;
};

const patchZoneSetting = async (zoneId, setting, value) => {
  await request(`/zones/${zoneId}/settings/${setting}`, {
    method: "PATCH",
    body: JSON.stringify({ value }),
  });
  console.log(`[cloudflare] ${setting}=${JSON.stringify(value)}`);
};

const getZone = async () => {
  const payload = await request(`/zones?name=${encodeURIComponent(zoneName)}&status=active`);
  const zone = payload?.result?.[0];
  if (!zone?.id || !zone?.account?.id) {
    throw new Error(`Cloudflare zone not found: ${zoneName}`);
  }
  return zone;
};

const workerScript = `export default {
  async fetch(request) {
    const response = await fetch(request);
    const headers = new Headers(response.headers);

    headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    headers.set("Content-Security-Policy", "frame-ancestors 'none'");
    headers.set("Referrer-Policy", "strict-origin");
    headers.set("X-Frame-Options", "DENY");
    headers.set("X-Content-Type-Options", "nosniff");

    const setCookie = headers.get("Set-Cookie");
    if (setCookie && /^wssplashchk=/i.test(setCookie) && !/;\\s*Secure\\b/i.test(setCookie)) {
      headers.set("Set-Cookie", setCookie + "; Secure");
    }

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
};`;

const upsertWorker = async (accountId) => {
  await fetch(`${API_BASE}/accounts/${accountId}/workers/scripts/${scriptName}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/javascript",
    },
    body: workerScript,
  }).then(async (response) => {
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.success === false) {
      const message = payload?.errors?.map((error) => error.message).join("; ") || response.statusText;
      throw new Error(`PUT worker script failed: ${message}`);
    }
  });
  console.log(`[cloudflare] worker script upserted: ${scriptName}`);
};

const upsertWorkerRoute = async (zoneId) => {
  const pattern = `${hostname}/z*`;
  const routes = await request(`/zones/${zoneId}/workers/routes`);
  const existing = (routes?.result || []).find((route) => route.pattern === pattern);
  if (existing?.id) {
    await request(`/zones/${zoneId}/workers/routes/${existing.id}`, {
      method: "PUT",
      body: JSON.stringify({ pattern, script: scriptName }),
    });
    console.log(`[cloudflare] worker route updated: ${pattern}`);
    return;
  }
  await request(`/zones/${zoneId}/workers/routes`, {
    method: "POST",
    body: JSON.stringify({ pattern, script: scriptName }),
  });
  console.log(`[cloudflare] worker route created: ${pattern}`);
};

const main = async () => {
  const zone = await getZone();
  console.log(`[cloudflare] zone=${zone.name} id=${zone.id}`);

  await patchZoneSetting(zone.id, "min_tls_version", "1.2");
  await patchZoneSetting(zone.id, "tls_1_3", "on");
  await patchZoneSetting(zone.id, "always_use_https", "on");
  try {
    await patchZoneSetting(zone.id, "ciphers", modernTls12Ciphers);
  } catch (error) {
    console.warn(`[cloudflare] ciphers not updated: ${error.message || error}`);
    console.warn("[cloudflare] Cloudflare may require Advanced Certificate Manager for custom ciphers.");
  }

  await upsertWorker(zone.account.id);
  await upsertWorkerRoute(zone.id);
};

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
