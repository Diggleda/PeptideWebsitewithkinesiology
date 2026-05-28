<?php
declare(strict_types=1);

ini_set('display_errors', '1');
ini_set('display_startup_errors', '1');
error_reporting(E_ALL);

$GLOBALS['tf_email_debug_booted'] = true;
register_shutdown_function(function (): void {
  $error = error_get_last();
  if (!is_array($error)) return;

  $fatal_types = array(E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR, E_USER_ERROR, E_RECOVERABLE_ERROR);
  if (!in_array((int) ($error['type'] ?? 0), $fatal_types, true)) return;

  while (ob_get_level() > 0) {
    @ob_end_clean();
  }

  if (!headers_sent()) {
    http_response_code(500);
    header('Content-Type: text/plain; charset=UTF-8');
  }

  echo "fatal_error_type: " . (int) ($error['type'] ?? 0) . "\n";
  echo "fatal_error_message: " . (string) ($error['message'] ?? '') . "\n";
  echo "fatal_error_file: " . (string) ($error['file'] ?? '') . "\n";
  echo "fatal_error_line: " . (int) ($error['line'] ?? 0) . "\n";
});

/*
 * Temporary WooCommerce email diagnostic runner.
 *
 * Upload this file to the WordPress root directory, next to wp-config.php.
 * Visit it with:
 *   /trufusion-email-debug.php?token=CHANGE_ME&order_id=1622
 *   /trufusion-email-debug.php?token=CHANGE_ME&order_id=1622&action=mail
 *   /trufusion-email-debug.php?token=CHANGE_ME&order_id=1622&action=resend
 *
 * Delete it immediately after debugging.
 */

$debug_token = 'CHANGE_ME';

header('Content-Type: text/plain; charset=UTF-8');

$request_token = isset($_GET['token']) ? (string) $_GET['token'] : '';
if ($debug_token === 'CHANGE_ME' || !hash_equals($debug_token, $request_token)) {
  http_response_code(403);
  echo "Forbidden. Set \$debug_token in this file and pass ?token=...\n";
  exit;
}

$wp_load = __DIR__ . '/wp-load.php';
if (!file_exists($wp_load)) {
  http_response_code(500);
  echo "wp-load.php not found. Upload this file to the WordPress root directory.\n";
  exit;
}

require $wp_load;

$order_id = isset($_GET['order_id']) ? (int) $_GET['order_id'] : 1622;
$action = isset($_GET['action']) ? strtolower(trim((string) $_GET['action'])) : 'inspect';

function tf_debug_line(string $label, $value): void {
  if (is_bool($value)) {
    $value = $value ? 'true' : 'false';
  } elseif (is_array($value) || is_object($value)) {
    $value = wp_json_encode($value);
  } elseif ($value === null) {
    $value = 'null';
  }
  echo $label . ': ' . (string) $value . "\n";
}

function tf_debug_socket_test(string $host, int $port, bool $ssl = false, int $timeout = 8): void {
  $target = ($ssl ? 'ssl://' : 'tcp://') . $host . ':' . $port;
  $errno = 0;
  $errstr = '';
  $started = microtime(true);
  $socket = @stream_socket_client($target, $errno, $errstr, $timeout, STREAM_CLIENT_CONNECT);
  $duration_ms = (int) round((microtime(true) - $started) * 1000);

  if (is_resource($socket)) {
    fclose($socket);
    tf_debug_line('socket_test', array(
      'target' => $target,
      'ok' => true,
      'duration_ms' => $duration_ms,
    ));
    return;
  }

  tf_debug_line('socket_test', array(
    'target' => $target,
    'ok' => false,
    'duration_ms' => $duration_ms,
    'errno' => $errno,
    'error' => $errstr,
  ));
}

$GLOBALS['tf_email_debug_mail_failures'] = array();
$GLOBALS['tf_email_debug_phpmailer'] = array();

add_action('wp_mail_failed', function ($error) {
  if (!is_wp_error($error)) return;
  $GLOBALS['tf_email_debug_mail_failures'][] = array(
    'code' => $error->get_error_code(),
    'message' => $error->get_error_message(),
    'data' => $error->get_error_data(),
  );
});

add_action('phpmailer_init', function ($phpmailer) {
  if (!is_object($phpmailer)) return;
  if (property_exists($phpmailer, 'Timeout')) {
    $phpmailer->Timeout = 8;
  }
  if (property_exists($phpmailer, 'Timelimit')) {
    $phpmailer->Timelimit = 8;
  }
}, PHP_INT_MAX - 2);

add_action('phpmailer_init', function ($phpmailer) {
  if (!is_object($phpmailer)) return;
  $GLOBALS['tf_email_debug_phpmailer'][] = array(
    'Mailer' => isset($phpmailer->Mailer) ? $phpmailer->Mailer : null,
    'Host' => isset($phpmailer->Host) ? $phpmailer->Host : null,
    'Port' => isset($phpmailer->Port) ? $phpmailer->Port : null,
    'Timeout' => isset($phpmailer->Timeout) ? $phpmailer->Timeout : null,
    'Timelimit' => isset($phpmailer->Timelimit) ? $phpmailer->Timelimit : null,
    'SMTPAuth' => isset($phpmailer->SMTPAuth) ? (bool) $phpmailer->SMTPAuth : null,
    'SMTPSecure' => isset($phpmailer->SMTPSecure) ? $phpmailer->SMTPSecure : null,
    'UsernameSet' => isset($phpmailer->Username) && trim((string) $phpmailer->Username) !== '',
    'PasswordSet' => isset($phpmailer->Password) && trim((string) $phpmailer->Password) !== '',
    'From' => isset($phpmailer->From) ? $phpmailer->From : null,
    'FromName' => isset($phpmailer->FromName) ? $phpmailer->FromName : null,
    'Sender' => isset($phpmailer->Sender) ? $phpmailer->Sender : null,
  );
}, PHP_INT_MAX);

tf_debug_line('site_url', function_exists('home_url') ? home_url() : '');
tf_debug_line('php_version', PHP_VERSION);
tf_debug_line('action', $action);
tf_debug_line('order_id', $order_id);
tf_debug_line('constant_trufusion_smtp_host_set', defined('TRUFUSION_SMTP_HOST') && trim((string) TRUFUSION_SMTP_HOST) !== '');
tf_debug_line('constant_trufusion_smtp_user_set', defined('TRUFUSION_SMTP_USER') && trim((string) TRUFUSION_SMTP_USER) !== '');
tf_debug_line('constant_trufusion_smtp_pass_set', defined('TRUFUSION_SMTP_PASS') && trim((string) TRUFUSION_SMTP_PASS) !== '');
tf_debug_line('constant_trufusion_smtp_auth', defined('TRUFUSION_SMTP_AUTH') ? constant('TRUFUSION_SMTP_AUTH') : 'undefined');
tf_debug_line('constant_peppr_smtp_host_set', defined('PEPPR_SMTP_HOST') && trim((string) PEPPR_SMTP_HOST) !== '');
tf_debug_line('constant_peppr_smtp_user_set', defined('PEPPR_SMTP_USER') && trim((string) PEPPR_SMTP_USER) !== '');
tf_debug_line('constant_peppr_smtp_pass_set', defined('PEPPR_SMTP_PASS') && trim((string) PEPPR_SMTP_PASS) !== '');
tf_debug_line('constant_peppr_smtp_auth', defined('PEPPR_SMTP_AUTH') ? constant('PEPPR_SMTP_AUTH') : 'undefined');

if ($action === 'network') {
  $host = defined('TRUFUSION_SMTP_HOST') && trim((string) TRUFUSION_SMTP_HOST) !== ''
    ? trim((string) TRUFUSION_SMTP_HOST)
    : 'smtp-relay.gmail.com';
  tf_debug_socket_test($host, 25, false);
  tf_debug_socket_test($host, 465, true);
  tf_debug_socket_test($host, 587, false);
}

if (!function_exists('WC') || !function_exists('wc_get_order')) {
  http_response_code(500);
  echo "WooCommerce is not loaded.\n";
  exit;
}

$active_plugins = (array) get_option('active_plugins', array());
foreach ($active_plugins as $plugin) {
  if (
    stripos((string) $plugin, 'woocommerce') !== false
    || stripos((string) $plugin, 'trufusion') !== false
    || stripos((string) $plugin, 'smtp') !== false
    || stripos((string) $plugin, 'mail') !== false
    || stripos((string) $plugin, 'google') !== false
  ) {
    tf_debug_line('active_plugin', $plugin);
  }
}

tf_debug_line('wp_mail_smtp_function_loaded', function_exists('wp_mail_smtp'));
tf_debug_line('email_overrides_smtp_filter_priority', function_exists('has_filter') ? has_filter('phpmailer_init', 'trufusion_email_overrides_configure_smtp') : null);
tf_debug_line('mailer_bridge_smtp_filter_priority', function_exists('has_filter') ? has_filter('phpmailer_init', 'trufusion_mailer_bridge_configure_smtp') : null);

$plugin_file = WP_PLUGIN_DIR . '/trufusion-email-overrides/trufusion-email-overrides.php';
tf_debug_line('email_overrides_file_exists', file_exists($plugin_file));
if (file_exists($plugin_file)) {
  $plugin_source = (string) file_get_contents($plugin_file);
  if (preg_match('/Version:\s*([^\r\n]+)/', $plugin_source, $matches)) {
    tf_debug_line('email_overrides_version', trim($matches[1]));
  }
  tf_debug_line('source_has_observer_bcc', strpos($plugin_source, 'trufusion_email_overrides_add_order_observer_bcc') !== false);
  tf_debug_line('source_has_pgibbons_bcc', strpos($plugin_source, 'pgibbons@trufusionlabs.com') !== false);
}

tf_debug_line('observer_function_loaded', function_exists('trufusion_email_overrides_add_order_observer_bcc'));
tf_debug_line(
  'observer_filter_priority',
  function_exists('has_filter') ? has_filter('woocommerce_email_headers', 'trufusion_email_overrides_add_order_observer_bcc') : null
);
tf_debug_line(
  'sales_rep_filter_priority',
  function_exists('has_filter') ? has_filter('woocommerce_email_headers', 'trufusion_email_overrides_add_sales_rep_cc') : null
);

$order = wc_get_order($order_id);
if (!$order) {
  http_response_code(404);
  echo "Order not found.\n";
  exit;
}

tf_debug_line('order_number', $order->get_order_number());
tf_debug_line('order_status', $order->get_status());
tf_debug_line('order_payment_method', $order->get_payment_method());
tf_debug_line('order_payment_title', $order->get_payment_method_title());
tf_debug_line('order_billing_email', $order->get_billing_email());
tf_debug_line('meta_trufusion_order_id', $order->get_meta('trufusion_order_id'));
tf_debug_line('meta_trufusion_sales_rep_email', $order->get_meta('trufusion_sales_rep_email'));
tf_debug_line('meta_trufusion_payment_method', $order->get_meta('trufusion_payment_method'));
tf_debug_line('meta_trufusion_payment_details', $order->get_meta('trufusion_payment_details'));

$mailer = WC()->mailer();
$emails = $mailer->get_emails();
foreach (array('WC_Email_Customer_On_Hold_Order', 'WC_Email_New_Order') as $email_key) {
  $email = isset($emails[$email_key]) ? $emails[$email_key] : null;
  if (!$email) {
    tf_debug_line($email_key, 'missing');
    continue;
  }

  tf_debug_line($email_key . '_id', isset($email->id) ? $email->id : '');
  tf_debug_line($email_key . '_enabled', method_exists($email, 'is_enabled') ? $email->is_enabled() : null);
  tf_debug_line($email_key . '_recipient', property_exists($email, 'recipient') ? $email->recipient : '');

  $headers = apply_filters('woocommerce_email_headers', '', isset($email->id) ? $email->id : '', $order, $email);
  echo $email_key . "_headers:\n" . (string) $headers . "\n";
}

if ($action === 'mail') {
  $ok = wp_mail(
    'diggleda@icloud.com',
    'TrufusionLabs manual wp_mail test ' . date('c'),
    "Manual wp_mail transport test from " . home_url() . "\nOrder: " . $order->get_order_number() . "\n",
    array(
      'Content-Type: text/plain; charset=UTF-8',
      'Bcc: support@trufusionlabs.com',
      'Bcc: pgibbons@trufusionlabs.com',
    )
  );
  tf_debug_line('wp_mail_result', $ok);
  tf_debug_line('phpmailer_snapshots', $GLOBALS['tf_email_debug_phpmailer']);
  tf_debug_line('wp_mail_failures', $GLOBALS['tf_email_debug_mail_failures']);
  global $phpmailer;
  if (isset($phpmailer) && is_object($phpmailer) && !empty($phpmailer->ErrorInfo)) {
    tf_debug_line('phpmailer_error', $phpmailer->ErrorInfo);
  }
}

if ($action === 'resend') {
  $email = isset($emails['WC_Email_Customer_On_Hold_Order']) ? $emails['WC_Email_Customer_On_Hold_Order'] : null;
  if (!$email || !method_exists($email, 'trigger')) {
    http_response_code(500);
    echo "Customer on-hold email is unavailable.\n";
    exit;
  }
  $email->trigger($order_id);
  tf_debug_line('resend_triggered', 'customer_on_hold_order');
  tf_debug_line('phpmailer_snapshots', $GLOBALS['tf_email_debug_phpmailer']);
  tf_debug_line('wp_mail_failures', $GLOBALS['tf_email_debug_mail_failures']);
}
