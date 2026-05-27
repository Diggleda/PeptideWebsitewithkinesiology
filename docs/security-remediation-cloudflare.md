# Cloudflare Security Remediation

Probely findings on `https://www.trufusionlabs.com/` are split across two layers:

- HTTP response headers and cookie attributes are enforced by the origin `.htaccess` and app middleware.
- TLS protocol versions and edge cipher suites are negotiated before traffic reaches the app, so they must be configured in Cloudflare.

## Required Cloudflare Settings

Set these at the `trufusionlabs.com` zone, or per hostname for `www.trufusionlabs.com` if Advanced Certificate Manager is used.

1. SSL/TLS > Edge Certificates > Minimum TLS Version: `1.2`
2. SSL/TLS > Edge Certificates > TLS 1.3: `On`
3. SSL/TLS > Edge Certificates > Always Use HTTPS: `On`
4. SSL/TLS > Edge Certificates > HTTP Strict Transport Security:
   - Enabled: `On`
   - Max age: at least `12 months`
   - Include subdomains: `On`
   - No-sniff header: `On`
5. SSL/TLS > Edge Certificates > Cipher Suites:
   - Keep TLS 1.3 enabled. Cloudflare manages TLS 1.3 ciphers automatically.
   - For TLS 1.2, allow only modern AEAD suites:
     - `ECDHE-ECDSA-AES128-GCM-SHA256`
     - `ECDHE-ECDSA-AES256-GCM-SHA384`
     - `ECDHE-ECDSA-CHACHA20-POLY1305`
     - `ECDHE-RSA-AES128-GCM-SHA256`
     - `ECDHE-RSA-AES256-GCM-SHA384`
     - `ECDHE-RSA-CHACHA20-POLY1305`
   - Exclude CBC suites such as `ECDHE-RSA-AES128-SHA256`, `ECDHE-RSA-AES256-SHA384`, `AES256-SHA256`, `AES256-SHA`, and `DES-CBC3-SHA`.

## API Examples

```bash
curl "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/settings/min_tls_version" \
  -X PATCH \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"value":"1.2"}'
```

```bash
curl "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/settings/tls_1_3" \
  -X PATCH \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"value":"on"}'
```

```bash
curl "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/settings/always_use_https" \
  -X PATCH \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"value":"on"}'
```

Cipher suite customization is a hostname-level setting in Cloudflare. If the dashboard/API option is not available on the current plan, upgrade the plan/add-on or ask Cloudflare support to restrict `www.trufusionlabs.com` to the AEAD TLS 1.2 suites above.

## Verification

After deployment and Cloudflare changes:

```bash
curl -I http://www.trufusionlabs.com/
curl -I https://www.trufusionlabs.com/
curl -i https://www.trufusionlabs.com/z0f76a1d14fd21a8fb5fd0d03e0fdc3d3cedae52f
```

Expected:

- HTTP returns `301` to `https://www.trufusionlabs.com/...`.
- HTTPS includes `Strict-Transport-Security`, `Content-Security-Policy`, `Referrer-Policy`, `X-Frame-Options`, and `X-Content-Type-Options`.
- Any `Set-Cookie` response includes `Secure`.
- TLS 1.0 and TLS 1.1 handshakes fail.
- TLS 1.2 handshakes do not negotiate CBC suites.

## References

- Cloudflare: Always Use HTTPS
  https://developers.cloudflare.com/ssl/edge-certificates/additional-options/always-use-https/
- Cloudflare: Minimum TLS Version
  https://developers.cloudflare.com/ssl/edge-certificates/additional-options/minimum-tls/
- Cloudflare: Cipher suites
  https://developers.cloudflare.com/ssl/edge-certificates/additional-options/cipher-suites/
- Cloudflare: Customize cipher suites
  https://developers.cloudflare.com/ssl/edge-certificates/additional-options/cipher-suites/customize-cipher-suites/
- Cloudflare: Cipher suite recommendations
  https://developers.cloudflare.com/ssl/edge-certificates/additional-options/cipher-suites/recommendations/
