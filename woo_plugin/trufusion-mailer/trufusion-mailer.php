<?php
/**
 * Plugin Name: TrufusionLabs Mailer Bridge
 * Description: Allows TrufusionLabs to send password reset emails via WooCommerce's email system.
 * Version: 1.1.7
 * Author: TrufusionLabs
 */

if (!defined('ABSPATH')) {
    exit;
}

function trufusion_mailer_bridge_get_header($name) {
    $key = 'HTTP_' . strtoupper(str_replace('-', '_', $name));
    return isset($_SERVER[$key]) ? (string) $_SERVER[$key] : '';
}

function trufusion_mailer_bridge_get_constant($primary, $legacy = '', $fallback = '') {
    if (defined($primary)) {
        $value = trim((string) constant($primary));
        if ($value !== '') {
            return $value;
        }
    }
    if ($legacy !== '' && defined($legacy)) {
        $value = trim((string) constant($legacy));
        if ($value !== '') {
            return $value;
        }
    }
    return $fallback;
}

function trufusion_mailer_bridge_get_frontend_url() {
    $value = trufusion_mailer_bridge_get_constant('TRUFUSION_APP_URL', 'PEPPR_APP_URL', 'https://www.trufusionlabs.com');
    $value = rtrim(trim((string) $value), '/');
    return $value !== '' ? $value : 'https://www.trufusionlabs.com';
}

function trufusion_mailer_bridge_get_brand_logo_url($current = '') {
    $value = trufusion_mailer_bridge_get_constant('TRUFUSION_EMAIL_LOGO_URL', '', '');
    if ($value === '' || stripos($value, 'peppro') !== false || stripos($value, 'TrufusionLabs_PhysiciansPortal') !== false) {
        $value = trufusion_mailer_bridge_get_frontend_url() . '/FullLogo_Transparent_NoBuffer%20(18).png?v=1.1.17';
    }
    return function_exists('esc_url_raw') ? esc_url_raw($value) : $value;
}

function trufusion_mailer_bridge_authorize() {
    $expected = trufusion_mailer_bridge_get_constant('TRUFUSION_MAILER_SECRET', 'PEPPR_MAILER_SECRET', '');
    if ($expected === '') {
        return new WP_Error('trufusion_secret_missing', 'Server not configured', array('status' => 500));
    }
    $provided = trufusion_mailer_bridge_get_header('X-TRUFUSION-SECRET');
    if ($provided === '') {
        $provided = trufusion_mailer_bridge_get_header('X-PEPPR-SECRET');
    }
    if (!hash_equals($expected, $provided)) {
        return new WP_Error('trufusion_unauthorized', 'Unauthorized', array('status' => 401));
    }
    return true;
}

function trufusion_mailer_bridge_mailer_wrap($subject, $body_html) {
    if (function_exists('WC') && WC() && method_exists(WC(), 'mailer')) {
        $mailer = WC()->mailer();
        if ($mailer && method_exists($mailer, 'wrap_message')) {
            return $mailer->wrap_message($subject, $body_html);
        }
    }
    return $body_html;
}

function trufusion_mailer_bridge_allowed_hosts() {
    $raw = trufusion_mailer_bridge_get_constant(
        'TRUFUSION_MAIL_ALLOWED_HOSTS',
        'PEPPR_MAIL_ALLOWED_HOSTS',
        'trufusionlabs.com,www.trufusionlabs.com'
    );
    $parts = array_filter(array_map('trim', explode(',', $raw)));
    if (empty($parts)) {
        $parts = array('trufusionlabs.com', 'www.trufusionlabs.com');
    }
    return $parts;
}

function trufusion_mailer_bridge_is_allowed_reset_url($reset_url) {
    if ($reset_url === '') {
        return false;
    }

    $parsed = wp_parse_url($reset_url);
    if (!is_array($parsed)) {
        return false;
    }

    $scheme = isset($parsed['scheme']) ? strtolower((string) $parsed['scheme']) : '';
    $host = isset($parsed['host']) ? strtolower((string) $parsed['host']) : '';
    $path = isset($parsed['path']) ? (string) $parsed['path'] : '';

    if ($scheme !== 'https') {
        return false;
    }

    $allowed = array_map('strtolower', trufusion_mailer_bridge_allowed_hosts());
    if ($host === '' || !in_array($host, $allowed, true)) {
        return false;
    }

    // Safety: only allow our reset-password route (prevents abuse if secret is leaked).
    if ($path !== '/reset-password') {
        return false;
    }

    return true;
}

function trufusion_mailer_bridge_send_password_reset_email(WP_REST_Request $request) {
    $auth = trufusion_mailer_bridge_authorize();
    if (is_wp_error($auth)) {
        return $auth;
    }

    $params = $request->get_json_params();
    if (!is_array($params)) {
        $params = array();
    }

    $email = isset($params['email']) ? sanitize_email((string) $params['email']) : '';
    $reset_url = isset($params['resetUrl']) ? esc_url_raw((string) $params['resetUrl']) : '';
    $display_name = isset($params['displayName']) ? sanitize_text_field((string) $params['displayName']) : '';

    if ($email === '' || $reset_url === '') {
        return new WP_Error('trufusion_bad_request', 'email and resetUrl are required', array('status' => 400));
    }
    if (!trufusion_mailer_bridge_is_allowed_reset_url($reset_url)) {
        return new WP_Error('trufusion_bad_request', 'resetUrl is not allowed', array('status' => 400));
    }

    $from_email = trufusion_mailer_bridge_get_from_email();
    $from_name = trufusion_mailer_bridge_get_from_name();
    $reply_to = trufusion_mailer_bridge_get_constant('TRUFUSION_MAIL_REPLY_TO', 'PEPPR_MAIL_REPLY_TO', 'support@trufusionlabs.com');

    $subject = 'Reset your TrufusionLabs password';
    $greeting = $display_name !== '' ? 'Hi ' . esc_html($display_name) . ',' : 'Hi,';

    $reset_button = '<a href="' . esc_url($reset_url) . '"'
      . ' style="display:inline-block;background-color:#0b0679;background-image:linear-gradient(#0b0679,#0b0679);color:#ffffff;-webkit-text-fill-color:#ffffff;text-decoration:none;'
      . 'padding:12px 18px;border-radius:12px;font-weight:700;line-height:1.1;">'
      . 'Reset password'
      . '</a>';

    $body = ''
      . '<div style="margin:0;padding:0;">'
      . '<p style="margin:0 0 12px 0;font-size:16px;line-height:1.4;color:#111827;">' . $greeting . '</p>'
      . '<p style="margin:0 0 18px 0;font-size:15px;line-height:1.5;color:#334155;">We received a request to reset your TrufusionLabs password.</p>'
      . '<div style="margin:0 0 18px 0;">' . $reset_button . '</div>'
      . '<p style="margin:0 0 10px 0;font-size:13px;line-height:1.5;color:#64748b;">If you didn’t request this, you can safely ignore this email.</p>'
      . '<p style="margin:0;font-size:13px;line-height:1.5;color:#64748b;">Need help? Contact <span style="font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;">support@trufusionlabs.com</span>.</p>'
      . '</div>';

    $html = trufusion_mailer_bridge_mailer_wrap($subject, $body);

    $headers = array(
        'Content-Type: text/html; charset=UTF-8',
        'From: ' . $from_name . ' <' . $from_email . '>',
        'Reply-To: ' . $reply_to,
    );

    $ok = wp_mail($email, $subject, $html, $headers);
    if (!$ok) {
        return new WP_Error('trufusion_send_failed', 'Failed to send email', array('status' => 502));
    }

    return rest_ensure_response(array('ok' => true, 'status' => 'ok'));
}

function trufusion_mailer_bridge_get_from_email() {
    $value = trufusion_mailer_bridge_get_constant('TRUFUSION_MAIL_FROM_EMAIL', 'PEPPR_MAIL_FROM_EMAIL', '');
    $value = trim($value);
    if (preg_match('/support@peppro\.(net|com)/i', $value)) {
        return 'support@trufusionlabs.com';
    }
    return $value !== '' ? $value : 'support@trufusionlabs.com';
}

function trufusion_mailer_bridge_get_from_name() {
    return 'TrufusionLabs';
}

function trufusion_mailer_bridge_is_peppro_reply_to($header) {
    return is_string($header)
        && stripos($header, 'reply-to:') === 0
        && preg_match('/support@peppro\.(net|com)/i', $header);
}

function trufusion_mailer_bridge_normalize_reply_to_header($header) {
    if (!trufusion_mailer_bridge_is_peppro_reply_to($header)) {
        return $header;
    }

    return 'Reply-To: ' . trufusion_mailer_bridge_get_from_name() . ' <' . trufusion_mailer_bridge_get_from_email() . '>';
}

function trufusion_mailer_bridge_sanitize_mail_headers($args) {
    if (!is_array($args) || !array_key_exists('headers', $args)) {
        return $args;
    }

    $headers = $args['headers'];
    if (is_array($headers)) {
        $args['headers'] = array_map('trufusion_mailer_bridge_normalize_reply_to_header', $headers);
        return $args;
    }

    if (is_string($headers) && stripos($headers, 'reply-to:') !== false && preg_match('/support@peppro\.(net|com)/i', $headers)) {
        $lines = preg_split('/\r\n|\r|\n/', $headers);
        $lines = array_map('trufusion_mailer_bridge_normalize_reply_to_header', $lines);
        $args['headers'] = implode("\r\n", $lines);
    }

    return $args;
}

function trufusion_mailer_bridge_get_smtp_setting($name, $fallback = '') {
    $suffix = strtoupper($name);
    return trufusion_mailer_bridge_get_constant('TRUFUSION_SMTP_' . $suffix, 'PEPPR_SMTP_' . $suffix, $fallback);
}

function trufusion_mailer_bridge_bool_value($value, $fallback) {
    if (is_bool($value)) {
        return $value;
    }
    if (is_int($value) || is_float($value)) {
        return (bool) $value;
    }

    $normalized = strtolower(trim((string) $value));
    if ($normalized === '') {
        return (bool) $fallback;
    }
    if (in_array($normalized, array('1', 'true', 'yes', 'on'), true)) {
        return true;
    }
    if (in_array($normalized, array('0', 'false', 'no', 'off'), true)) {
        return false;
    }

    return (bool) $fallback;
}

function trufusion_mailer_bridge_smtp_auth_enabled() {
    if (defined('TRUFUSION_SMTP_AUTH')) {
        return trufusion_mailer_bridge_bool_value(constant('TRUFUSION_SMTP_AUTH'), true);
    }
    if (defined('PEPPR_SMTP_AUTH')) {
        return trufusion_mailer_bridge_bool_value(constant('PEPPR_SMTP_AUTH'), true);
    }
    return true;
}

function trufusion_mailer_bridge_smtp_force_enabled() {
    if (defined('TRUFUSION_SMTP_FORCE')) {
        return trufusion_mailer_bridge_bool_value(constant('TRUFUSION_SMTP_FORCE'), false);
    }
    if (defined('PEPPR_SMTP_FORCE')) {
        return trufusion_mailer_bridge_bool_value(constant('PEPPR_SMTP_FORCE'), false);
    }
    return false;
}

function trufusion_mailer_bridge_apply_mail_identity($phpmailer) {
    if (!is_object($phpmailer)) {
        return;
    }

    $from_email = trufusion_mailer_bridge_get_from_email();
    $from_name = trufusion_mailer_bridge_get_from_name();
    if (is_string($from_email) && $from_email !== '' && method_exists($phpmailer, 'setFrom')) {
        $phpmailer->setFrom($from_email, $from_name, false);
    }
    if (is_string($from_email) && $from_email !== '') {
        $phpmailer->From = $from_email;
        $phpmailer->FromName = $from_name;
        $phpmailer->Sender = $from_email;
    }
}

function trufusion_mailer_bridge_configure_smtp($phpmailer) {
    if (function_exists('wp_mail_smtp') && !trufusion_mailer_bridge_smtp_force_enabled()) {
        return;
    }

    $host = trufusion_mailer_bridge_get_smtp_setting('HOST', '');
    $pass = trufusion_mailer_bridge_get_smtp_setting('PASS', '');
    $auth_enabled = trufusion_mailer_bridge_smtp_auth_enabled();
    if ($host === '' || ($auth_enabled && $pass === '')) {
        return;
    }

    if (!is_object($phpmailer) || !method_exists($phpmailer, 'isSMTP')) {
        return;
    }

    $port = (int) trufusion_mailer_bridge_get_smtp_setting('PORT', '587');
    $user = trufusion_mailer_bridge_get_smtp_setting('USER', '');
    $secure = strtolower(trufusion_mailer_bridge_get_smtp_setting('SECURE', 'tls'));
    $timeout = (int) trufusion_mailer_bridge_get_smtp_setting('TIMEOUT', '15');
    if (preg_match('/@peppro\.(net|com)$/i', trim((string) $user))) {
        return;
    }

    $phpmailer->isSMTP();
    $phpmailer->Host = $host;
    $phpmailer->Port = $port > 0 ? $port : 587;
    $phpmailer->Timeout = $timeout > 0 ? $timeout : 15;
    $phpmailer->Timelimit = $timeout > 0 ? $timeout : 15;
    $phpmailer->SMTPAuth = $auth_enabled;
    $phpmailer->Username = $user;
    $phpmailer->Password = $pass;
    $phpmailer->SMTPAutoTLS = $secure !== 'none';

    if ($secure === 'ssl') {
        $phpmailer->SMTPSecure = 'ssl';
    } elseif ($secure === 'tls' || $secure === 'starttls') {
        $phpmailer->SMTPSecure = 'tls';
    } else {
        $phpmailer->SMTPSecure = '';
    }

    trufusion_mailer_bridge_apply_mail_identity($phpmailer);
}

// Reduce WooCommerce email header logo size for TrufusionLabs-branded emails.
add_filter('woocommerce_email_styles', function ($css) {
    $css .= "\n"
        . "#wrapper{background-color:#ffffff !important;}\n"
        . "#template_container{border-color:#e2e8f0 !important;box-shadow:none !important;}\n"
        . "#template_header{background-color:#ffffff !important;border-bottom:1px solid rgba(15,39,75,0.10) !important;}\n"
        . "#template_header h1,.wc-email-header__title{color:#0B274B !important;background:transparent !important;}\n"
        . "a.button,.button{background-color:#0b0679 !important;background-image:linear-gradient(#0b0679,#0b0679) !important;color:#ffffff !important;-webkit-text-fill-color:#ffffff !important;border-color:#0b0679 !important;border-radius:12px !important;text-decoration:none !important;}\n"
        . "#template_header_image img,"
        . ".wc-email-header__image img,"
        . ".email-header-image img,"
        . ".email_header img {"
        . "max-width: 180px !important;"
        . "max-height: 64px !important;"
        . "width: auto !important;"
        . "height: auto !important;"
        . "display: block !important;"
        . "margin: 0 auto !important;"
        . "}\n";
    return $css;
}, PHP_INT_MAX);

add_filter('woocommerce_email_header_image', 'trufusion_mailer_bridge_get_brand_logo_url', PHP_INT_MAX);

// Force a consistent From identity across WooCommerce/WordPress email sending.
add_filter('wp_mail_from', function ($from) {
    $forced = trufusion_mailer_bridge_get_from_email();
    return $forced ? $forced : $from;
}, PHP_INT_MAX);

add_filter('wp_mail_from_name', function ($name) {
    $forced = trufusion_mailer_bridge_get_from_name();
    return $forced ? $forced : $name;
}, PHP_INT_MAX);

// Ensure wp_mail uses SMTP when configured.
add_filter('wp_mail', 'trufusion_mailer_bridge_sanitize_mail_headers', PHP_INT_MAX);
add_action('phpmailer_init', 'trufusion_mailer_bridge_configure_smtp', PHP_INT_MAX - 1);
add_action('phpmailer_init', 'trufusion_mailer_bridge_apply_mail_identity', PHP_INT_MAX);

add_action('rest_api_init', function () {
    register_rest_route('trufusion/v1', '/email/password-reset', array(
        'methods' => 'POST',
        'callback' => 'trufusion_mailer_bridge_send_password_reset_email',
        'permission_callback' => '__return_true',
    ));
    register_rest_route('peppr/v1', '/email/password-reset', array(
        'methods' => 'POST',
        'callback' => 'trufusion_mailer_bridge_send_password_reset_email',
        'permission_callback' => '__return_true',
    ));
});
