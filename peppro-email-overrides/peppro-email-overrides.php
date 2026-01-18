<?php
/**
 * Plugin Name: PepPro Email Overrides
 * Description: Customize BACS/Zelle instructions in WooCommerce emails + thank-you page.
 * Version: 1.0.0
 */

if (!defined('ABSPATH')) exit;

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
