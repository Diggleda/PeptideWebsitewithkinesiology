<?php
declare(strict_types=1);

/**
 * Google Sheets → PepPro Quotes Webhook (port.peppro.net)
 * Mirrors the structure and hardening used by sales_rep.php
 * - Consistent JSON responses
 * - Robust error/exception handling
 * - Shared-secret auth via Authorization or X-WebHook-Signature
 */

header('Content-Type: application/json; charset=utf-8');
header('X-Webhook-Handler: port-quotes.php');
header('Access-Control-Allow-Origin: https://docs.google.com');

ini_set('display_errors', '0');
error_reporting(E_ALL);

// Convert any PHP warning/notice/fatal into JSON so debugging is easy
set_error_handler(function ($severity, $message, $file, $line) {
  if (!(error_reporting() & $severity)) return false;
  http_response_code(500);
  echo json_encode(['ok' => false, 'error' => 'PHP_ERROR', 'detail' => "$message @ $file:$line"], JSON_UNESCAPED_SLASHES);
  return true;
});
set_exception_handler(function (Throwable $e) {
  http_response_code(500);
  echo json_encode(['ok' => false, 'error' => 'UNCAUGHT', 'detail' => $e->getMessage()], JSON_UNESCAPED_SLASHES);
});
register_shutdown_function(function () {
  $e = error_get_last();
  if ($e && in_array($e['type'], [E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR], true)) {
    http_response_code(500);
    echo json_encode(['ok' => false, 'error' => 'FATAL', 'detail' => $e['message']], JSON_UNESCAPED_SLASHES);
  }
});

// Load secure config
$configPath = '/home/oz0fsscenn2m/secure/config_googlesheetsWebhook.php';
if (!is_readable($configPath)) {
  http_response_code(500);
  echo json_encode(['ok' => false, 'error' => 'CONFIG_NOT_FOUND', 'detail' => $configPath]);
  exit;
}
$config = require $configPath;

// Helpers
function respond(int $code, array $payload): void {
  http_response_code($code);
  echo json_encode($payload, JSON_UNESCAPED_SLASHES);
  exit;
}

function header_token(): string {
  $raw = (string)($_SERVER['HTTP_AUTHORIZATION'] ?? ($_SERVER['HTTP_X_WEBHOOK_SIGNATURE'] ?? ''));
  $trimmed = trim($raw);
  // Accept common prefixes (Bearer/Basic) from various clients
  $trimmed = preg_replace('/^(?:Bearer|Basic)\s+/i', '', $trimmed) ?? $trimmed;
  return trim((string)$trimmed);
}

function authorized(array $config): bool {
  $provided = header_token();
  if ($provided === '') return false;
  // Support either an array of secrets or a single secret
  if (!empty($config['webhook_secrets']) && is_array($config['webhook_secrets'])) {
    return in_array($provided, $config['webhook_secrets'], true);
  }
  if (!empty($config['webhook_secret'])) {
    return hash_equals((string)$config['webhook_secret'], $provided);
  }
  return false;
}

// CORS preflight
if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') {
  header('Access-Control-Allow-Origin: https://docs.google.com');
  header('Access-Control-Allow-Headers: Content-Type, Authorization, X-WebHook-Signature');
  header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
  respond(204, []);
}

// GET: quick verification endpoint (optional)
if (($_SERVER['REQUEST_METHOD'] ?? '') === 'GET') {
  if (!authorized($config)) respond(401, ['ok' => false, 'error' => 'Unauthorized']);
  try {
    $pdo = new PDO(
      $config['db_dsn'] ?? ($config['dsn'] ?? ''),
      $config['db_user'] ?? ($config['username'] ?? ''),
      $config['db_password'] ?? ($config['password'] ?? ''),
      [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES => false,
      ]
    );
    $q = $pdo->query('SELECT id, text, author, created_at, updated_at FROM quotes ORDER BY updated_at DESC LIMIT 200');
    respond(200, ['ok' => true, 'quotes' => $q->fetchAll()]);
  } catch (Throwable $e) {
    respond(500, ['ok' => false, 'error' => 'DB_ERROR', 'detail' => $e->getMessage()]);
  }
}

// Only POST beyond this point
if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
  respond(405, ['ok' => false, 'error' => 'Method not allowed']);
}
if (!authorized($config)) {
  respond(401, ['ok' => false, 'error' => 'Unauthorized']);
}

// Read/validate JSON body
$raw = file_get_contents('php://input') ?: '';
$body = json_decode($raw, true);
if (json_last_error() !== JSON_ERROR_NONE) {
  respond(400, ['ok' => false, 'error' => 'Invalid JSON', 'detail' => json_last_error_msg()]);
}
if (!isset($body['quotes']) || !is_array($body['quotes'])) {
  respond(422, ['ok' => false, 'error' => 'Missing quotes array']);
}

// Normalize incoming quotes
$clean = [];
$errors = [];
foreach ($body['quotes'] as $i => $q) {
  $text   = trim((string)($q['text'] ?? ''));
  $author = trim((string)($q['author'] ?? ''));
  if ($text === '' && $author === '') {
    $errors[] = "Row $i: empty record"; continue;
  }
  $clean[] = [
    'text' => $text,
    'author' => ($author !== '' ? $author : null),
  ];
}

try {
  $pdo = new PDO(
    $config['db_dsn'] ?? ($config['dsn'] ?? ''),
    $config['db_user'] ?? ($config['username'] ?? ''),
    $config['db_password'] ?? ($config['password'] ?? ''),
    [
      PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
      PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
      PDO::ATTR_EMULATE_PREPARES => false,
    ]
  );

  if (function_exists('set_time_limit')) @set_time_limit(60);

  // Ensure table exists
  $pdo->exec(
    "CREATE TABLE IF NOT EXISTS quotes (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      text VARCHAR(1024) NOT NULL,
      author VARCHAR(255) DEFAULT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_text_author (text(255), author(191))
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;"
  );

  $stmt = $pdo->prepare(
    'INSERT INTO quotes (text, author)
     VALUES (:text, :author)
     ON DUPLICATE KEY UPDATE
       author = VALUES(author),
       updated_at = CURRENT_TIMESTAMP'
  );

  $stored = 0;
  foreach ($clean as $rec) {
    $stmt->execute([
      ':text'   => $rec['text'],
      ':author' => $rec['author'],
    ]);
    $stored++;
  }

  respond(200, [
    'ok'       => true,
    'received' => count($body['quotes']),
    'stored'   => $stored,
    'skipped'  => count($body['quotes']) - count($clean),
    'errors'   => $errors,
  ]);
} catch (Throwable $e) {
  respond(500, ['ok' => false, 'error' => 'DB_ERROR', 'detail' => $e->getMessage()]);
}

?>
