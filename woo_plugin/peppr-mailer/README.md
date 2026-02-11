# PepPro Mailer Bridge (WooCommerce)

Sends PepPro password reset emails using WooCommerce/WordPress email delivery (`wp_mail` + Woo mailer wrapper).

## Install

1. Copy `woo_plugin/peppr-mailer/` into your Woo site at `wp-content/plugins/peppr-mailer/`
2. Activate **PepPro Mailer Bridge** in WP Admin → Plugins
3. Add these to `wp-config.php` (or another secure config location):

```php
define('PEPPR_MAILER_SECRET', 'CHANGE_ME_TO_A_LONG_RANDOM_STRING');
define('PEPPR_MAIL_FROM_EMAIL', 'support@peppro.net');
define('PEPPR_MAIL_FROM_NAME', 'PepPro');
define('PEPPR_MAIL_REPLY_TO', 'support@peppro.net');
// Comma-separated allowlist for `resetUrl` hostnames (default: peppro.net)
define('PEPPR_MAIL_ALLOWED_HOSTS', 'peppro.net');
```

## SMTP (recommended)

This plugin can force WordPress/WooCommerce emails to send via SMTP (instead of PHP mail) when configured.

Add these to `wp-config.php`:

```php
define('PEPPR_SMTP_HOST', 'smtp.sendgrid.net'); // or your SMTP host
define('PEPPR_SMTP_PORT', 587);                // 465 for SSL, 587 for TLS
define('PEPPR_SMTP_SECURE', 'tls');            // tls | ssl | none
define('PEPPR_SMTP_USER', 'apikey');           // SendGrid uses "apikey"
define('PEPPR_SMTP_PASS', 'YOUR_SMTP_PASSWORD_OR_API_KEY');
```

## API

Endpoint:

`POST /wp-json/peppr/v1/email/password-reset`

Headers:

`X-PEPPR-SECRET: <PEPPR_MAILER_SECRET>`

Body:

```json
{
  "email": "user@example.com",
  "resetUrl": "https://peppro.net/reset-password?token=...",
  "displayName": "Optional Name"
}
```

Response:

```json
{ "ok": true, "status": "ok" }
```

## Notes

- This does **not** require a Woo/WP user account. It only uses Woo's mailer to deliver PepPro's reset link.
- The plugin sets a consistent `From:` identity (defaults to `support@peppro.net`).
- The plugin adds a small WooCommerce email CSS override to keep the header logo from rendering too large.
- For safety, the plugin only accepts `https://<allowed-host>/reset-password?...` URLs.
