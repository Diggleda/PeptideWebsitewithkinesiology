<?php
/**
 * Plugin Name: PepPro Email Overrides
 * Description: Customize BACS/Zelle instructions in WooCommerce emails + enforce PepPro mail identity (optional SMTP).
 * Version: 1.1.7
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

function peppro_email_overrides_shared_users_table() {
  // Override in wp-config.php if needed:
  // define('PEPPR_SHARED_USERS_TABLE', 'users');
  $value = defined('PEPPR_SHARED_USERS_TABLE') ? (string) PEPPR_SHARED_USERS_TABLE : 'users';
  $value = trim($value);
  return $value !== '' ? $value : 'users';
}

function peppro_email_overrides_sql_ident($value) {
  $value = trim((string) $value);
  $value = trim($value, "` \t\n\r\0\x0B");
  if ($value === '') return '';
  if (!preg_match('/^[A-Za-z0-9_]+$/', $value)) return '';
  return $value;
}

function peppro_email_overrides_table_sql($table) {
  $table = trim((string) $table);
  if ($table === '') return '';

  $parts = array_filter(array_map('trim', explode('.', $table)), function ($part) {
    return $part !== '';
  });
  if (empty($parts) || count($parts) > 2) return '';

  $quoted = array();
  foreach ($parts as $part) {
    $safe = peppro_email_overrides_sql_ident($part);
    if ($safe === '') return '';
    $quoted[] = "`{$safe}`";
  }
  return implode('.', $quoted);
}

function peppro_email_overrides_shared_users_table_sql() {
  return peppro_email_overrides_table_sql(peppro_email_overrides_shared_users_table());
}

function peppro_email_overrides_db_reset_last_error($db) {
  if (is_object($db) && property_exists($db, 'last_error')) {
    $db->last_error = '';
  }
}

function peppro_email_overrides_debug_enabled() {
  return defined('PEPPR_EMAIL_OVERRIDES_DEBUG') && PEPPR_EMAIL_OVERRIDES_DEBUG;
}

function peppro_email_overrides_log($event, $context = array()) {
  if (!peppro_email_overrides_debug_enabled()) return;

  $payload = array(
    'event' => (string) $event,
    'context' => is_array($context) ? $context : array(),
  );
  error_log('[PepPro Email Overrides] ' . wp_json_encode($payload));
}

function peppro_email_overrides_cc_fail_open() {
  return defined('PEPPR_EMAIL_OVERRIDES_CC_FAIL_OPEN') && PEPPR_EMAIL_OVERRIDES_CC_FAIL_OPEN;
}

function peppro_email_overrides_get_query_db() {
  static $cached = false;
  static $db = null;

  if ($cached) {
    peppro_email_overrides_log('get_query_db.cached', array('has_db' => is_object($db)));
    return $db;
  }
  $cached = true;

  $host = defined('PEPPR_SHARED_DB_HOST') ? trim((string) PEPPR_SHARED_DB_HOST) : '';
  $port = defined('PEPPR_SHARED_DB_PORT') ? (int) PEPPR_SHARED_DB_PORT : 0;
  $user = defined('PEPPR_SHARED_DB_USER') ? trim((string) PEPPR_SHARED_DB_USER) : '';
  $pass = defined('PEPPR_SHARED_DB_PASS') ? (string) PEPPR_SHARED_DB_PASS : '';
  $name = defined('PEPPR_SHARED_DB_NAME') ? trim((string) PEPPR_SHARED_DB_NAME) : '';

  if ($host !== '' && $user !== '' && $name !== '' && class_exists('wpdb')) {
    $host_with_port = $host;
    if ($port > 0 && strpos($host, ':') === false) {
      $host_with_port = $host . ':' . $port;
    }

    $candidate = new wpdb($user, $pass, $name, $host_with_port);
    if (is_object($candidate)) {
      if (method_exists($candidate, 'suppress_errors')) {
        $candidate->suppress_errors(true);
      }
      $charset = defined('PEPPR_SHARED_DB_CHARSET') ? trim((string) PEPPR_SHARED_DB_CHARSET) : (defined('DB_CHARSET') ? (string) DB_CHARSET : '');
      $collate = defined('PEPPR_SHARED_DB_COLLATE') ? trim((string) PEPPR_SHARED_DB_COLLATE) : '';
      if (method_exists($candidate, 'set_charset') && !empty($candidate->dbh)) {
        $candidate->set_charset($candidate->dbh, $charset !== '' ? $charset : 'utf8mb4', $collate !== '' ? $collate : '');
      }

      peppro_email_overrides_db_reset_last_error($candidate);
      $probe = method_exists($candidate, 'get_var') ? $candidate->get_var('SELECT 1') : null;
      if ((string) $probe === '1' && empty($candidate->last_error)) {
        $db = $candidate;
        peppro_email_overrides_log('get_query_db.shared_connected', array(
          'host' => $host_with_port,
          'database' => $name,
        ));
        return $db;
      }
      peppro_email_overrides_log('get_query_db.shared_failed', array(
        'host' => $host_with_port,
        'database' => $name,
        'probe' => $probe,
        'last_error' => (string) $candidate->last_error,
      ));
    }
  }

  global $wpdb;
  if (isset($wpdb) && is_object($wpdb)) {
    $db = $wpdb;
    peppro_email_overrides_log('get_query_db.fallback_wpdb');
  } else {
    peppro_email_overrides_log('get_query_db.no_db');
  }

  return $db;
}

function peppro_email_overrides_boolish($value) {
  if (is_bool($value)) return $value;
  if (is_numeric($value)) return ((int) $value) === 1;
  $normalized = strtolower(trim((string) $value));
  return in_array($normalized, array('1', 'true', 'yes', 'on'), true);
}

function peppro_email_overrides_rep_cc_enabled($rep_email) {
  $rep_email = strtolower(trim((string) $rep_email));
  if ($rep_email === '' || strpos($rep_email, '@') === false) return false;

  $fail_open = peppro_email_overrides_cc_fail_open();

  $db = peppro_email_overrides_get_query_db();
  if (!isset($db) || !is_object($db) || !method_exists($db, 'get_var')) {
    peppro_email_overrides_log('rep_cc_enabled.no_db', array(
      'rep_email' => $rep_email,
      'decision' => $fail_open,
      'fail_open' => $fail_open,
    ));
    return $fail_open;
  }

  $table_sql = peppro_email_overrides_shared_users_table_sql();
  if ($table_sql === '') {
    peppro_email_overrides_log('rep_cc_enabled.bad_table', array('table' => peppro_email_overrides_shared_users_table()));
    return $fail_open;
  }

  peppro_email_overrides_db_reset_last_error($db);
  $query = $db->prepare(
    "SELECT receive_client_order_update_emails
     FROM {$table_sql}
     WHERE LOWER(TRIM(`email`)) = LOWER(TRIM(%s))
     LIMIT 1",
    $rep_email
  );
  $raw = $db->get_var($query);
  if (!empty($db->last_error)) {
    peppro_email_overrides_log('rep_cc_enabled.query_error', array(
      'table' => $table_sql,
      'rep_email' => $rep_email,
      'last_error' => (string) $db->last_error,
      'decision' => $fail_open,
      'fail_open' => $fail_open,
    ));
    return $fail_open;
  }
  if ($raw === null) {
    // Ambiguous (row missing): default to fail-closed unless explicitly configured otherwise.
    peppro_email_overrides_log('rep_cc_enabled.row_missing', array(
      'table' => $table_sql,
      'rep_email' => $rep_email,
      'decision' => $fail_open,
      'fail_open' => $fail_open,
    ));
    return $fail_open;
  }
  $enabled = peppro_email_overrides_boolish($raw);
  peppro_email_overrides_log('rep_cc_enabled.result', array(
    'table' => $table_sql,
    'rep_email' => $rep_email,
    'raw' => $raw,
    'enabled' => $enabled,
  ));
  return $enabled;
}

function peppro_email_overrides_lookup_rep_email_by_id($rep_id) {
  $rep_id = trim((string) $rep_id);
  if ($rep_id === '') return '';

  $db = peppro_email_overrides_get_query_db();
  if (!isset($db) || !is_object($db) || !method_exists($db, 'prepare') || !method_exists($db, 'get_var')) {
    return '';
  }

  $table_sql = peppro_email_overrides_shared_users_table_sql();
  if ($table_sql === '') {
    peppro_email_overrides_log('lookup_by_id.bad_table', array('rep_id' => $rep_id, 'table' => peppro_email_overrides_shared_users_table()));
    return '';
  }

  foreach (array('sales_rep_id', 'salesRepId', 'id', 'legacy_user_id', 'legacyUserId') as $column) {
    $safe_column = peppro_email_overrides_sql_ident($column);
    if ($safe_column === '') continue;

    peppro_email_overrides_db_reset_last_error($db);
    $query = $db->prepare(
      "SELECT `email`
       FROM {$table_sql}
       WHERE LOWER(TRIM(CAST(`{$safe_column}` AS CHAR))) = LOWER(TRIM(%s))
       LIMIT 1",
      $rep_id
    );
    $email = sanitize_email((string) $db->get_var($query));
    if (!empty($db->last_error)) {
      peppro_email_overrides_log('lookup_by_id.column_error', array(
        'table' => $table_sql,
        'column' => $safe_column,
        'rep_id' => $rep_id,
        'last_error' => (string) $db->last_error,
      ));
      continue;
    }
    if ($email !== '') {
      peppro_email_overrides_log('lookup_by_id.found', array(
        'table' => $table_sql,
        'column' => $safe_column,
        'rep_id' => $rep_id,
        'rep_email' => $email,
      ));
      return $email;
    }
  }

  peppro_email_overrides_log('lookup_by_id.not_found', array('table' => $table_sql, 'rep_id' => $rep_id));
  return '';
}

function peppro_email_overrides_lookup_rep_email_by_customer_email($customer_email) {
  $customer_email = strtolower(trim((string) $customer_email));
  if ($customer_email === '' || strpos($customer_email, '@') === false) return '';

  $db = peppro_email_overrides_get_query_db();
  if (!isset($db) || !is_object($db) || !method_exists($db, 'prepare') || !method_exists($db, 'get_var')) {
    return '';
  }

  $table_sql = peppro_email_overrides_shared_users_table_sql();
  if ($table_sql === '') {
    peppro_email_overrides_log('lookup_by_customer.bad_table', array(
      'customer_email' => $customer_email,
      'table' => peppro_email_overrides_shared_users_table(),
    ));
    return '';
  }

  foreach (array('sales_rep_email', 'salesRepEmail', 'doctor_sales_rep_email', 'doctorSalesRepEmail') as $column) {
    $safe_column = peppro_email_overrides_sql_ident($column);
    if ($safe_column === '') continue;

    peppro_email_overrides_db_reset_last_error($db);
    $query = $db->prepare(
      "SELECT `{$safe_column}`
       FROM {$table_sql}
       WHERE LOWER(TRIM(`email`)) = LOWER(TRIM(%s))
       LIMIT 1",
      $customer_email
    );
    $email = sanitize_email((string) $db->get_var($query));
    if (!empty($db->last_error)) {
      peppro_email_overrides_log('lookup_by_customer.email_column_error', array(
        'table' => $table_sql,
        'column' => $safe_column,
        'customer_email' => $customer_email,
        'last_error' => (string) $db->last_error,
      ));
      continue;
    }
    if ($email !== '') {
      peppro_email_overrides_log('lookup_by_customer.email_found', array(
        'table' => $table_sql,
        'column' => $safe_column,
        'customer_email' => $customer_email,
        'rep_email' => $email,
      ));
      return $email;
    }
  }

  foreach (array('sales_rep_id', 'salesRepId', 'doctor_sales_rep_id', 'doctorSalesRepId') as $column) {
    $safe_column = peppro_email_overrides_sql_ident($column);
    if ($safe_column === '') continue;

    peppro_email_overrides_db_reset_last_error($db);
    $query = $db->prepare(
      "SELECT `{$safe_column}`
       FROM {$table_sql}
       WHERE LOWER(TRIM(`email`)) = LOWER(TRIM(%s))
       LIMIT 1",
      $customer_email
    );
    $rep_id = trim((string) $db->get_var($query));
    if (!empty($db->last_error)) {
      peppro_email_overrides_log('lookup_by_customer.id_column_error', array(
        'table' => $table_sql,
        'column' => $safe_column,
        'customer_email' => $customer_email,
        'last_error' => (string) $db->last_error,
      ));
      continue;
    }
    if ($rep_id !== '') {
      peppro_email_overrides_log('lookup_by_customer.id_found', array(
        'table' => $table_sql,
        'column' => $safe_column,
        'customer_email' => $customer_email,
        'rep_id' => $rep_id,
      ));
      return peppro_email_overrides_lookup_rep_email_by_id($rep_id);
    }
  }

  peppro_email_overrides_log('lookup_by_customer.not_found', array(
    'table' => $table_sql,
    'customer_email' => $customer_email,
  ));
  return '';
}

function peppro_email_overrides_resolve_rep_email($order) {
  if (!$order instanceof WC_Order) return '';

  $rep_email = sanitize_email((string) $order->get_meta('peppro_sales_rep_email'));
  if ($rep_email !== '') {
    peppro_email_overrides_log('resolve_rep_email.meta_email', array(
      'order_id' => (int) $order->get_id(),
      'rep_email' => $rep_email,
    ));
    return $rep_email;
  }

  $rep_id = trim((string) $order->get_meta('peppro_sales_rep_id'));
  if ($rep_id !== '') {
    $by_id = peppro_email_overrides_lookup_rep_email_by_id($rep_id);
    if ($by_id !== '') {
      peppro_email_overrides_log('resolve_rep_email.by_id', array(
        'order_id' => (int) $order->get_id(),
        'rep_id' => $rep_id,
        'rep_email' => $by_id,
      ));
      return $by_id;
    }
  }

  $customer_email = sanitize_email((string) $order->get_billing_email());
  if ($customer_email !== '') {
    $by_customer = peppro_email_overrides_lookup_rep_email_by_customer_email($customer_email);
    if ($by_customer !== '') {
      peppro_email_overrides_log('resolve_rep_email.by_customer', array(
        'order_id' => (int) $order->get_id(),
        'customer_email' => $customer_email,
        'rep_email' => $by_customer,
      ));
      return $by_customer;
    }
  }

  peppro_email_overrides_log('resolve_rep_email.not_found', array(
    'order_id' => (int) $order->get_id(),
    'rep_id' => $rep_id,
    'customer_email' => $customer_email,
  ));
  return '';
}

function peppro_email_overrides_add_sales_rep_cc($headers, $email_id, $order, $email) {
  if (!$order instanceof WC_Order) return $headers;

  // Only apply to customer-facing Woo emails.
  $resolved_email_id = '';
  if (is_string($email_id) && $email_id !== '') {
    $resolved_email_id = $email_id;
  } elseif (is_object($email) && isset($email->id)) {
    $resolved_email_id = (string) $email->id;
  }
  if ($resolved_email_id === '' || strpos($resolved_email_id, 'customer_') !== 0) {
    peppro_email_overrides_log('add_cc.skip.not_customer_email', array(
      'order_id' => (int) $order->get_id(),
      'email_id' => $resolved_email_id,
    ));
    return $headers;
  }

  $rep_email = peppro_email_overrides_resolve_rep_email($order);
  if ($rep_email === '') {
    peppro_email_overrides_log('add_cc.skip.rep_not_found', array(
      'order_id' => (int) $order->get_id(),
      'email_id' => $resolved_email_id,
    ));
    return $headers;
  }

  $customer_email = strtolower(trim((string) $order->get_billing_email()));
  if ($customer_email !== '' && strtolower($rep_email) === $customer_email) {
    peppro_email_overrides_log('add_cc.skip.same_as_customer', array(
      'order_id' => (int) $order->get_id(),
      'customer_email' => $customer_email,
      'rep_email' => $rep_email,
    ));
    return $headers;
  }

  $opted_in = peppro_email_overrides_rep_cc_enabled($rep_email);
  if (!$opted_in) {
    peppro_email_overrides_log('add_cc.skip.opted_out', array(
      'order_id' => (int) $order->get_id(),
      'rep_email' => $rep_email,
    ));
    return $headers;
  }

  // Avoid duplicate CC if another plugin already added it.
  if (is_array($headers)) {
    $joined = implode("\n", $headers);
    if (stripos($joined, $rep_email) !== false) {
      peppro_email_overrides_log('add_cc.skip.already_present', array(
        'order_id' => (int) $order->get_id(),
        'rep_email' => $rep_email,
        'headers_type' => 'array',
      ));
      return $headers;
    }
    $headers[] = 'Cc: ' . $rep_email;
    peppro_email_overrides_log('add_cc.added', array(
      'order_id' => (int) $order->get_id(),
      'rep_email' => $rep_email,
      'headers_type' => 'array',
    ));
    return $headers;
  }

  $header_str = (string) $headers;
  if (stripos($header_str, $rep_email) !== false) {
    peppro_email_overrides_log('add_cc.skip.already_present', array(
      'order_id' => (int) $order->get_id(),
      'rep_email' => $rep_email,
      'headers_type' => 'string',
    ));
    return $headers;
  }
  $header_str .= "Cc: {$rep_email}\r\n";
  peppro_email_overrides_log('add_cc.added', array(
    'order_id' => (int) $order->get_id(),
    'rep_email' => $rep_email,
    'headers_type' => 'string',
  ));
  return $header_str;
}

add_filter('woocommerce_email_headers', 'peppro_email_overrides_add_sales_rep_cc', 20, 4);

function peppro_email_overrides_render_discount_summary($order, $sent_to_admin, $plain_text, $email) {
  if (!$order instanceof WC_Order) return;

  $discount_code = strtoupper(trim((string) $order->get_meta('peppro_discount_code')));

  if ($discount_code === '') return;

  if ($plain_text) {
    echo "\n";
    echo sprintf("Discount code used: %s\n", $discount_code);
    return;
  }

  echo '<table cellspacing="0" cellpadding="6" border="0" style="width:100%;margin:12px 0 0;border:1px solid #e2e8f0;border-radius:8px;">';
  echo '<tr><th scope="row" style="text-align:left;color:#334155;">Discount code used</th><td style="text-align:right;color:#0f172a;font-weight:600;">' . esc_html($discount_code) . '</td></tr>';
  echo '</table>';
}
add_action('woocommerce_email_after_order_table', 'peppro_email_overrides_render_discount_summary', 20, 4);

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
