<?php
/**
 * Plugin Name: PepPro Mailer Bridge
 * Description: Allows PepPro to send password reset emails via WooCommerce's email system.
 * Version: 1.1.0
 * Author: PepPro
 */

if (!defined('ABSPATH')) {
    exit;
}

function peppr_mailer_bridge_get_header($name) {
    $key = 'HTTP_' . strtoupper(str_replace('-', '_', $name));
    return isset($_SERVER[$key]) ? (string) $_SERVER[$key] : '';
}

function peppr_mailer_bridge_authorize() {
    $expected = defined('PEPPR_MAILER_SECRET') ? (string) PEPPR_MAILER_SECRET : '';
    if ($expected === '') {
        return new WP_Error('peppr_secret_missing', 'Server not configured', array('status' => 500));
    }
    $provided = peppr_mailer_bridge_get_header('X-PEPPR-SECRET');
    if (!hash_equals($expected, $provided)) {
        return new WP_Error('peppr_unauthorized', 'Unauthorized', array('status' => 401));
    }
    return true;
}

function peppr_mailer_bridge_mailer_wrap($subject, $body_html) {
    if (function_exists('WC') && WC() && method_exists(WC(), 'mailer')) {
        $mailer = WC()->mailer();
        if ($mailer && method_exists($mailer, 'wrap_message')) {
            return $mailer->wrap_message($subject, $body_html);
        }
    }
    return $body_html;
}

function peppr_mailer_bridge_allowed_hosts() {
    $raw = defined('PEPPR_MAIL_ALLOWED_HOSTS') ? (string) PEPPR_MAIL_ALLOWED_HOSTS : 'peppro.net';
    $parts = array_filter(array_map('trim', explode(',', $raw)));
    if (empty($parts)) {
        $parts = array('peppro.net');
    }
    return $parts;
}

function peppr_mailer_bridge_is_allowed_reset_url($reset_url) {
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

    $allowed = array_map('strtolower', peppr_mailer_bridge_allowed_hosts());
    if ($host === '' || !in_array($host, $allowed, true)) {
        return false;
    }

    // Safety: only allow our reset-password route (prevents abuse if secret is leaked).
    if ($path !== '/reset-password') {
        return false;
    }

    return true;
}

function peppr_mailer_bridge_send_password_reset_email(WP_REST_Request $request) {
    $auth = peppr_mailer_bridge_authorize();
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
        return new WP_Error('peppr_bad_request', 'email and resetUrl are required', array('status' => 400));
    }
    if (!peppr_mailer_bridge_is_allowed_reset_url($reset_url)) {
        return new WP_Error('peppr_bad_request', 'resetUrl is not allowed', array('status' => 400));
    }

    $from_email = defined('PEPPR_MAIL_FROM_EMAIL') ? (string) PEPPR_MAIL_FROM_EMAIL : 'support@peppro.net';
    $from_name = defined('PEPPR_MAIL_FROM_NAME') ? (string) PEPPR_MAIL_FROM_NAME : 'PepPro';
    $reply_to = defined('PEPPR_MAIL_REPLY_TO') ? (string) PEPPR_MAIL_REPLY_TO : 'support@peppro.net';

    $subject = 'Reset your PepPro password';
    $greeting = $display_name !== '' ? 'Hi ' . esc_html($display_name) . ',' : 'Hi,';

    $reset_button = '<a href="' . esc_url($reset_url) . '"'
      . ' style="display:inline-block;background:#5fb3f9;color:#ffffff;text-decoration:none;'
      . 'padding:12px 18px;border-radius:10px;font-weight:700;line-height:1.1;">'
      . 'Reset password'
      . '</a>';

    $body = ''
      . '<div style="margin:0;padding:0;">'
      . '<p style="margin:0 0 12px 0;font-size:16px;line-height:1.4;color:#111827;">' . $greeting . '</p>'
      . '<p style="margin:0 0 18px 0;font-size:15px;line-height:1.5;color:#334155;">We received a request to reset your PepPro password.</p>'
      . '<div style="margin:0 0 18px 0;">' . $reset_button . '</div>'
      . '<p style="margin:0 0 10px 0;font-size:13px;line-height:1.5;color:#64748b;">If you didn’t request this, you can safely ignore this email.</p>'
      . '<p style="margin:0;font-size:13px;line-height:1.5;color:#64748b;">Need help? Contact <span style="font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;">support@peppro.net</span>.</p>'
      . '</div>';

    $html = peppr_mailer_bridge_mailer_wrap($subject, $body);

    $headers = array(
        'Content-Type: text/html; charset=UTF-8',
        'From: ' . $from_name . ' <' . $from_email . '>',
        'Reply-To: ' . $reply_to,
    );

    $ok = wp_mail($email, $subject, $html, $headers);
    if (!$ok) {
        return new WP_Error('peppr_send_failed', 'Failed to send email', array('status' => 502));
    }

    return rest_ensure_response(array('ok' => true, 'status' => 'ok'));
}

function peppr_mailer_bridge_get_from_email() {
    $value = defined('PEPPR_MAIL_FROM_EMAIL') ? (string) PEPPR_MAIL_FROM_EMAIL : '';
    $value = trim($value);
    return $value !== '' ? $value : 'support@peppro.net';
}

function peppr_mailer_bridge_get_from_name() {
    $value = defined('PEPPR_MAIL_FROM_NAME') ? (string) PEPPR_MAIL_FROM_NAME : '';
    $value = trim($value);
    return $value !== '' ? $value : 'PepPro';
}

function peppr_mailer_bridge_get_smtp_setting($name, $fallback = '') {
    $key = 'PEPPR_SMTP_' . strtoupper($name);
    if (!defined($key)) return $fallback;
    $value = trim((string) constant($key));
    return $value !== '' ? $value : $fallback;
}

function peppr_mailer_bridge_configure_smtp($phpmailer) {
    $host = peppr_mailer_bridge_get_smtp_setting('HOST', '');
    $pass = peppr_mailer_bridge_get_smtp_setting('PASS', '');
    if ($host === '' || $pass === '') {
        return;
    }

    if (!is_object($phpmailer) || !method_exists($phpmailer, 'isSMTP')) {
        return;
    }

    $port = (int) peppr_mailer_bridge_get_smtp_setting('PORT', '587');
    $user = peppr_mailer_bridge_get_smtp_setting('USER', '');
    $secure = strtolower(peppr_mailer_bridge_get_smtp_setting('SECURE', 'tls'));

    $phpmailer->isSMTP();
    $phpmailer->Host = $host;
    $phpmailer->Port = $port > 0 ? $port : 587;
    $phpmailer->SMTPAuth = true;
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

    // Improve alignment and consistency across WooCommerce emails.
    $from_email = peppr_mailer_bridge_get_from_email();
    $from_name = peppr_mailer_bridge_get_from_name();
    if (is_string($from_email) && $from_email !== '') {
        $phpmailer->setFrom($from_email, $from_name, false);
        $phpmailer->Sender = $from_email;
    }
}

// Reduce WooCommerce email header logo size for PepPro-branded emails.
add_filter('woocommerce_email_styles', function ($css) {
    $css .= "\n"
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
}, 100);

// Force a consistent From identity across WooCommerce/WordPress email sending.
add_filter('wp_mail_from', function ($from) {
    $forced = peppr_mailer_bridge_get_from_email();
    return $forced ? $forced : $from;
}, 1000);

add_filter('wp_mail_from_name', function ($name) {
    $forced = peppr_mailer_bridge_get_from_name();
    return $forced ? $forced : $name;
}, 1000);

// Ensure wp_mail uses SMTP when configured.
add_action('phpmailer_init', 'peppr_mailer_bridge_configure_smtp', 20);

add_action('rest_api_init', function () {
    register_rest_route('peppr/v1', '/email/password-reset', array(
        'methods' => 'POST',
        'callback' => 'peppr_mailer_bridge_send_password_reset_email',
        'permission_callback' => '__return_true',
    ));
});
