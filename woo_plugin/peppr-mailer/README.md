# PepPro Mailer Bridge (WooCommerce)

Sends PepPro password reset emails using WooCommerce/WordPress email delivery (`wp_mail` + Woo mailer wrapper).

## Install

1. Copy `woo_plugin/peppr-mailer/` into your Woo site at `wp-content/plugins/peppr-mailer/`
2. Activate **PepPro Mailer Bridge** in WP Admin → Plugins
3. Add these to `wp-config.php` (or another secure config location):

```php
define('PEPPR_MAILER_SECRET', 'CHANGE_ME_TO_A_LONG_RANDOM_STRING');
define('PEPPR_MAIL_FROM_EMAIL', 'support@peppro.com');
define('PEPPR_MAIL_FROM_NAME', 'no-reply');
define('PEPPR_MAIL_REPLY_TO', 'no-reply@peppro.com');
// Comma-separated allowlist for `resetUrl` hostnames (default: peppro.net)
define('PEPPR_MAIL_ALLOWED_HOSTS', 'peppro.net');
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
- To ensure `support@peppro.com` doesn't receive replies, the email sets `Reply-To: no-reply@peppro.com`.
- For safety, the plugin only accepts `https://<allowed-host>/reset-password?...` URLs.
