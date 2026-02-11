<?php
/**
 * Plugin Name: PepPro Email Overrides
 * Description: Customize BACS/Zelle instructions in WooCommerce emails + enforce PepPro mail identity (optional SMTP).
 * Version: 1.1.0
 */

if (!defined('ABSPATH')) exit;

function peppro_email_overrides_get_from_email() {
  $value = defined('PEPPR_MAIL_FROM_EMAIL') ? (string) PEPPR_MAIL_FROM_EMAIL : '';
  $value = trim($value);
  return $value !== '' ? $value : 'support@peppro.net';
}

function peppro_email_overrides_get_from_name() {
  $value = defined('PEPPR_MAIL_FROM_NAME') ? (string) PEPPR_MAIL_FROM_NAME : '';
  $value = trim($value);
  return $value !== '' ? $value : 'PepPro';
}

function peppro_email_overrides_get_smtp_setting($name, $fallback = '') {
  $key = 'PEPPR_SMTP_' . strtoupper($name);
  if (!defined($key)) return $fallback;
  $value = trim((string) constant($key));
  return $value !== '' ? $value : $fallback;
}

function peppro_email_overrides_configure_smtp($phpmailer) {
  $host = peppro_email_overrides_get_smtp_setting('HOST', '');
  $pass = peppro_email_overrides_get_smtp_setting('PASS', '');
  if ($host === '' || $pass === '') return;

  if (!is_object($phpmailer) || !method_exists($phpmailer, 'isSMTP')) return;

  $port = (int) peppro_email_overrides_get_smtp_setting('PORT', '587');
  $user = peppro_email_overrides_get_smtp_setting('USER', '');
  $secure = strtolower(peppro_email_overrides_get_smtp_setting('SECURE', 'tls'));

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

  $from_email = peppro_email_overrides_get_from_email();
  $from_name = peppro_email_overrides_get_from_name();
  if (is_string($from_email) && $from_email !== '') {
    $phpmailer->setFrom($from_email, $from_name, false);
    $phpmailer->Sender = $from_email;
  }
}

add_filter('wp_mail_from', function ($from) {
  $forced = peppro_email_overrides_get_from_email();
  return $forced ? $forced : $from;
}, 1000);

add_filter('wp_mail_from_name', function ($name) {
  $forced = peppro_email_overrides_get_from_name();
  return $forced ? $forced : $name;
}, 1000);

add_action('phpmailer_init', 'peppro_email_overrides_configure_smtp', 20);

add_action('plugins_loaded', function () {
  if (!class_exists('WooCommerce')) return;

  // Override the Customer On-hold email template so we can customize the intro text
  // based on payment method (Zelle vs ACH) without touching the theme.
  add_filter('woocommerce_locate_template', function ($template, $template_name, $template_path) {
    if ($template_name !== 'emails/customer-on-hold-order.php') return $template;
    $custom = plugin_dir_path(__FILE__) . 'templates/emails/customer-on-hold-order.php';
    return file_exists($custom) ? $custom : $template;
  }, 10, 3);

  add_action('init', function () {
    if (!function_exists('WC')) return;

    $gateways = WC()->payment_gateways() ? WC()->payment_gateways()->payment_gateways() : [];
    if (!empty($gateways['bacs'])) {
      remove_action('woocommerce_email_before_order_table', [$gateways['bacs'], 'email_instructions'], 10);
      remove_action('woocommerce_thankyou_bacs', [$gateways['bacs'], 'thankyou_page']);
    }

    add_action('woocommerce_email_before_order_table', 'peppro_bacs_email_instructions', 10, 4);
    add_action('woocommerce_thankyou_bacs', 'peppro_bacs_thankyou_instructions', 10);
  });
});

function peppro_is_zelle_order($order) {
  if (!$order instanceof WC_Order) return false;
  $title = strtolower((string) $order->get_payment_method_title());
  $meta  = strtolower((string) $order->get_meta('peppro_payment_method')); // optional, if present
  return (strpos($title, 'zelle') !== false) || (strpos($meta, 'zelle') !== false);
}

function peppro_bacs_email_instructions($order, $sent_to_admin, $plain_text, $email) {
  if ($sent_to_admin || !$order instanceof WC_Order) return;
  if ($order->get_payment_method() !== 'bacs') return;

  $gateways = WC()->payment_gateways() ? WC()->payment_gateways()->payment_gateways() : [];
  if (empty($gateways['bacs'])) return;

  // Only override the Customer On-hold email. For all other email types,
  // fall back to WooCommerce's default BACS instructions behavior.
  if (!$email || !is_object($email) || !property_exists($email, 'id') || $email->id !== 'customer_on_hold_order') {
    $gateways['bacs']->email_instructions($order, $sent_to_admin, $plain_text);
    return;
  }

  // Zelle: the intro is handled by our custom on-hold email template; don't output any
  // additional payment instructions here (avoids duplicate Zelle messaging).
  if (peppro_is_zelle_order($order)) return;

  // ACH: keep Woo's normal Direct Bank Transfer instructions + bank details
  $gateways['bacs']->email_instructions($order, $sent_to_admin, $plain_text);
}

function peppro_bacs_thankyou_instructions($order_id) {
  $order = wc_get_order($order_id);
  if (!$order || $order->get_payment_method() !== 'bacs') return;

  $gateways = WC()->payment_gateways() ? WC()->payment_gateways()->payment_gateways() : [];
  if (empty($gateways['bacs'])) return;

  if (peppro_is_zelle_order($order)) {
    echo '<p>' . esc_html("We received your order! Please Zelle support@peppro.net with the memo 'Order #{$order->get_order_number()}'. Instructions to follow in an email.") . '</p>';
    return;
  }

  // ACH: keep Woo's normal thank-you instructions + bank details
  $gateways['bacs']->thankyou_page($order_id);
}
