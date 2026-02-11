# PepPro Email Overrides (WooCommerce)

Customizes WooCommerce BACS/Zelle messaging and can optionally force WordPress/WooCommerce emails to send via SMTP.

## Optional: consistent From identity

Add to `wp-config.php`:

```php
define('PEPPR_MAIL_FROM_EMAIL', 'support@peppro.net');
define('PEPPR_MAIL_FROM_NAME', 'PepPro');
```

## Optional: SMTP (recommended)

Add to `wp-config.php`:

```php
define('PEPPR_SMTP_HOST', 'smtp.sendgrid.net'); // or your SMTP host
define('PEPPR_SMTP_PORT', 587);                // 465 for SSL, 587 for TLS
define('PEPPR_SMTP_SECURE', 'tls');            // tls | ssl | none
define('PEPPR_SMTP_USER', 'apikey');           // SendGrid uses "apikey"
define('PEPPR_SMTP_PASS', 'YOUR_SMTP_PASSWORD_OR_API_KEY');
```

