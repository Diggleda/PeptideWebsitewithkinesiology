# TrufusionLabs Mailer Bridge (WooCommerce)

Sends TrufusionLabs password reset emails using WooCommerce/WordPress email delivery (`wp_mail` + Woo mailer wrapper).

## Install

1. Copy `woo_plugin/trufusion-mailer/` into your Woo site at `wp-content/plugins/trufusion-mailer/`
2. Activate **TrufusionLabs Mailer Bridge** in WP Admin → Plugins
3. Add these to `wp-config.php` (or another secure config location):

```php
define('TRUFUSION_MAILER_SECRET', 'CHANGE_ME_TO_A_LONG_RANDOM_STRING');
define('TRUFUSION_MAIL_FROM_EMAIL', 'support@trufusionlabs.com');
define('TRUFUSION_MAIL_FROM_NAME', 'TrufusionLabs');
define('TRUFUSION_MAIL_REPLY_TO', 'support@trufusionlabs.com');
// Comma-separated allowlist for `resetUrl` hostnames (default: trufusionlabs.com,www.trufusionlabs.com)
define('TRUFUSION_MAIL_ALLOWED_HOSTS', 'trufusionlabs.com,www.trufusionlabs.com');
```

## SMTP (recommended)

This plugin can force WordPress/WooCommerce emails to send via SMTP (instead of PHP mail) when configured.

Add these to `wp-config.php`:

```php
define('TRUFUSION_SMTP_HOST', 'smtp.gmail.com');    // or your authenticated TrufusionLabs SMTP host
define('TRUFUSION_SMTP_PORT', 587);                // 465 for SSL, 587 for TLS
define('TRUFUSION_SMTP_SECURE', 'tls');            // tls | ssl | none
define('TRUFUSION_SMTP_USER', 'support@trufusionlabs.com');
define('TRUFUSION_SMTP_PASS', 'YOUR_SMTP_PASSWORD');
```

## API

Endpoint:

`POST /wp-json/trufusion/v1/email/password-reset`

Headers:

`X-TRUFUSION-SECRET: <TRUFUSION_MAILER_SECRET>`

Body:

```json
{
  "email": "user@example.com",
  "resetUrl": "https://trufusionlabs.com/reset-password?token=...",
  "displayName": "Optional Name"
}
```

Response:

```json
{ "ok": true, "status": "ok" }
```

## Notes

- This does **not** require a Woo/WP user account. It only uses Woo's mailer to deliver the TrufusionLabs reset link.
- The plugin sets a consistent `From:` identity (defaults to `support@trufusionlabs.com`).
- The plugin adds a small WooCommerce email CSS override to keep the header logo from rendering too large.
- For safety, the plugin only accepts `https://<allowed-host>/reset-password?...` URLs.
- Legacy `PEPPR_*` constants, `X-PEPPR-SECRET`, and `/wp-json/peppr/v1/email/password-reset` remain accepted during the transition.
