# TrufusionLabs Email Overrides (WooCommerce)

Customizes WooCommerce BACS/Zelle messaging and can optionally force WordPress/WooCommerce emails to send via SMTP.

The default WooCommerce email header logo is the current TrufusionLabs full logo. If `TRUFUSION_EMAIL_LOGO_URL`
is empty, points at a PepPro asset, or points at the legacy physicians-portal logo, the plugin falls back to
`/FullLogo_Transparent_NoBuffer%20(18).png`.

## Optional: consistent From identity

Add to `wp-config.php`:

```php
define('TRUFUSION_MAIL_FROM_EMAIL', 'support@trufusionlabs.com');
define('TRUFUSION_MAIL_FROM_NAME', 'TrufusionLabs');
define('TRUFUSION_ZELLE_EMAIL', 'support@trufusionlabs.com');
```

## Optional: SMTP (recommended)

Add to `wp-config.php`:

```php
define('TRUFUSION_SMTP_HOST', 'smtp.gmail.com'); // or your authenticated TrufusionLabs SMTP host
define('TRUFUSION_SMTP_PORT', 587);              // 465 for SSL, 587 for TLS
define('TRUFUSION_SMTP_SECURE', 'tls');          // tls | ssl | none
define('TRUFUSION_SMTP_USER', 'support@trufusionlabs.com');
define('TRUFUSION_SMTP_PASS', 'YOUR_SMTP_PASSWORD');
```

Legacy `PEPPR_*` constants remain accepted during the transition except for PepPro sender identities, which are ignored so mail does not send as `@peppro.net`.
