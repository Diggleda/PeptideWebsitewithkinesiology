# TruFusionLabs Email Overrides (WooCommerce)

Customizes WooCommerce BACS/Zelle messaging and can optionally force WordPress/WooCommerce emails to send via SMTP.

## Optional: consistent From identity

Add to `wp-config.php`:

```php
define('TRUFUSION_MAIL_FROM_EMAIL', 'support@trufusionlabs.com');
define('TRUFUSION_MAIL_FROM_NAME', 'TruFusionLabs');
```

## Optional: SMTP (recommended)

Add to `wp-config.php`:

```php
define('TRUFUSION_SMTP_HOST', 'smtp.gmail.com'); // or your authenticated TruFusionLabs SMTP host
define('TRUFUSION_SMTP_PORT', 587);              // 465 for SSL, 587 for TLS
define('TRUFUSION_SMTP_SECURE', 'tls');          // tls | ssl | none
define('TRUFUSION_SMTP_USER', 'support@trufusionlabs.com');
define('TRUFUSION_SMTP_PASS', 'YOUR_SMTP_PASSWORD');
```

Legacy `PEPPR_*` constants remain accepted during the transition except for PepPro sender identities, which are ignored so mail does not send as `@peppro.net`.
