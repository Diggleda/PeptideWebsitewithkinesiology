<?php
declare(strict_types=1);

/**
 * Copy this file to the VPS as the secure config consumed by:
 * - `server/php/public_html/port.peppro.net/api/integrations/google-sheets/sales-reps.php`
 * - `server/php/public_html/port.peppro.net/api/integrations/google-sheets/quotes/quotes.php`
 *
 * Suggested destination on the VPS:
 * `/home/oz0fsscenn2m/secure/config_googlesheetsWebhook.php`
 *
 * Keep this file out of the repo and lock permissions down on the VPS.
 */

return [
    'db_dsn' => 'mysql:host=127.0.0.1;port=3306;dbname=PepPro;charset=utf8mb4',
    'db_user' => 'peppro_api',
    'db_password' => 'replace-with-vps-db-password',

    // Preserve the existing Google Sheets webhook secret(s) here.
    'webhook_secrets' => [
        'replace-with-existing-google-sheets-webhook-secret',
    ],
];
