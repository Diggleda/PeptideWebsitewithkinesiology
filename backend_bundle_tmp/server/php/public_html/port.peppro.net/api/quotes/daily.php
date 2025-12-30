<?php
declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('X-Endpoint: quotes/daily.php');

ini_set('display_errors', '0');
error_reporting(E_ALL);

// CORS: allow frontend origins
$allowedOrigins = [
  'https://peppro.net',
  'https://www.peppro.net',
  'https://port.peppro.net',
];
$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
if ($origin && in_array($origin, $allowedOrigins, true)) {
  header('Access-Control-Allow-Origin: ' . $origin);
  header('Access-Control-Allow-Credentials: true');
  header('Vary: Origin');
}

if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') {
  if ($origin && in_array($origin, $allowedOrigins, true)) {
    header('Access-Control-Allow-Origin: ' . $origin);
    header('Access-Control-Allow-Credentials: true');
    header('Vary: Origin');
  }
  header('Access-Control-Allow-Methods: GET, OPTIONS');
  header('Access-Control-Allow-Headers: Content-Type');
  http_response_code(204);
  exit;
}

$respond = function(int $code, array $payload): void {
  http_response_code($code);
  echo json_encode($payload, JSON_UNESCAPED_SLASHES);
  exit;
};

// Load secure config
$configPath = '/home/oz0fsscenn2m/secure/config_googlesheetsWebhook.php';
if (!is_readable($configPath)) {
  $respond(500, ['ok' => false, 'error' => 'CONFIG_NOT_FOUND', 'detail' => $configPath]);
}
$config = require $configPath;

$dsn  = $config['db_dsn'] ?? ($config['dsn'] ?? '');
$user = $config['db_user'] ?? ($config['username'] ?? '');
$pass = $config['db_password'] ?? ($config['password'] ?? '');

try {
  $pdo = new PDO($dsn, $user, $pass, [
    PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
    PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
    PDO::ATTR_EMULATE_PREPARES => false,
  ]);
} catch (Throwable $e) {
  $respond(500, ['ok' => false, 'error' => 'DB_CONNECT_ERROR', 'detail' => $e->getMessage()]);
}

// Fetch quotes
try {
  $stmt = $pdo->query('SELECT id, text, author FROM quotes');
  $all = $stmt->fetchAll();
} catch (Throwable $e) {
  $respond(500, ['ok' => false, 'error' => 'DB_QUERY_ERROR', 'detail' => $e->getMessage()]);
}

// Normalize
$list = [];
foreach ($all as $q) {
  $text = isset($q['text']) && is_string($q['text']) ? trim($q['text']) : '';
  $author = isset($q['author']) && is_string($q['author']) ? trim($q['author']) : '';
  $id = isset($q['id']) ? $q['id'] : null;
  if ($text !== '') {
    $list[] = ['id' => $id, 'text' => $text, 'author' => $author];
  }
}

if (count($list) === 0) {
  $respond(200, ['text' => 'Excellence is an attitude.', 'author' => 'PepPro']);
}

// Cache file to keep the same quote each day and avoid repeating yesterday
$cachePath = '/home/oz0fsscenn2m/secure/quotes_daily.json';
$today = (new DateTime('now', new DateTimeZone('UTC')))->format('Y-m-d');

$cached = null;
if (is_readable($cachePath)) {
  $raw = @file_get_contents($cachePath);
  if ($raw !== false) {
    $decoded = json_decode($raw, true);
    if (is_array($decoded)) $cached = $decoded;
  }
}

// If we already have a pick for today and it still exists, return it
if (is_array($cached) && ($cached['date'] ?? '') === $today) {
  $found = null;
  foreach ($list as $item) {
    if ((string)$item['id'] === (string)($cached['id'] ?? '')) { $found = $item; break; }
  }
  if ($found) {
    $respond(200, ['text' => $found['text'], 'author' => $found['author']]);
  }
}

// Choose a random quote (avoid yesterday's if possible)
$avoidId = null;
if (is_array($cached) && ($cached['date'] ?? '') !== $today) {
  $avoidId = $cached['id'] ?? null;
}

$pool = $list;
if ($avoidId !== null && count($pool) > 1) {
  $filtered = [];
  foreach ($pool as $item) {
    if ((string)$item['id'] !== (string)$avoidId) $filtered[] = $item;
  }
  if (count($filtered) > 0) $pool = $filtered;
}

$pick = $pool[random_int(0, count($pool) - 1)];

// Store selection
$toStore = json_encode(['date' => $today, 'id' => $pick['id']], JSON_UNESCAPED_SLASHES);
@file_put_contents($cachePath, $toStore, LOCK_EX);

$respond(200, ['text' => $pick['text'], 'author' => $pick['author']]);
