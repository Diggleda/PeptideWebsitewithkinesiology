<?php
declare(strict_types=1);

/**
 * Google Sheets → PepPro Sales Reps Webhook (port.peppro.net)
 * Always returns JSON and converts fatals/warnings into JSON so debugging is easy.
 * Includes guardrails so existing admins/test_doctors in the users table are not overwritten as sales_rep.
 */

header('Content-Type: application/json; charset=utf-8');
header('X-Webhook-Handler: port-sales-reps.php');

ini_set('display_errors', '0');
error_reporting(E_ALL);

/** Convert any PHP warning/notice/fatal into a JSON 500 so we can see the cause. */
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

/** Load secure config (PDO DSN, user/pass, webhook secrets). */
$configPath = '/home/oz0fsscenn2m/secure/config_googlesheetsWebhook.php';
if (!is_readable($configPath)) {
  http_response_code(500);
  echo json_encode(['ok' => false, 'error' => 'CONFIG_NOT_FOUND', 'detail' => $configPath]);
  exit;
}
$config = require $configPath;

/** Helper to send JSON and exit. */
function respond(int $code, array $payload): void {
  http_response_code($code);
  echo json_encode($payload, JSON_UNESCAPED_SLASHES);
  exit;
}

/** Simple shared-secret auth (Authorization or X-WebHook-Signature). */
function authorized(array $config): bool {
  $authHeader = $_SERVER['HTTP_AUTHORIZATION'] ?? '';
  $sigHeader  = $_SERVER['HTTP_X_WEBHOOK_SIGNATURE'] ?? '';
  $provided   = $authHeader ?: $sigHeader;
  $validList  = $config['webhook_secrets'] ?? [];
  return $provided && in_array($provided, $validList, true);
}

/** CORS preflight for Google services (optional). */
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
  header('Access-Control-Allow-Origin: https://docs.google.com');
  header('Access-Control-Allow-Headers: Content-Type, Authorization, X-WebHook-Signature');
  header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
  respond(204, []);
}

/** GET: quick read-back for verification. */
if ($_SERVER['REQUEST_METHOD'] === 'GET') {
  if (!authorized($config)) respond(401, ['ok' => false, 'error' => 'Unauthorized']);
  try {
    $pdo = new PDO(
      $config['db_dsn'],
      $config['db_user'],
      $config['db_password'],
      [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES => false,
      ]
    );
    $q = $pdo->query('SELECT sales_code, initials, name, email, phone, territory, updatedAt FROM sales_reps ORDER BY updatedAt DESC LIMIT 200');
    respond(200, ['ok' => true, 'salesReps' => $q->fetchAll()]);
  } catch (Throwable $e) {
    respond(500, ['ok' => false, 'error' => 'DB_ERROR', 'detail' => $e->getMessage()]);
  }
}

/** Only POST beyond this point. */
if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
  respond(405, ['ok' => false, 'error' => 'Method not allowed']);
}
if (!authorized($config)) {
  respond(401, ['ok' => false, 'error' => 'Unauthorized']);
}

/** Parse JSON body. */
$raw = file_get_contents('php://input');
$body = json_decode($raw, true);
if (json_last_error() !== JSON_ERROR_NONE) {
  respond(400, ['ok' => false, 'error' => 'Invalid JSON', 'detail' => json_last_error_msg()]);
}
if (!isset($body['salesReps']) || !is_array($body['salesReps'])) {
  respond(422, ['ok' => false, 'error' => 'Missing salesReps array']);
}

/** Normalization + validation. */
function derive_initials(string $initials, string $name, string $sales_code): string {
  $ini = strtoupper(preg_replace('/[^A-Z]/', '', $initials));
  if (strlen($ini) >= 2) return substr($ini, 0, 2);

  $code = strtoupper(preg_replace('/[^A-Z]/', '', $sales_code));
  if (preg_match('/^[A-Z]{5}$/', $code)) return substr($code, 0, 2);

  $nameClean = strtoupper(preg_replace('/[^A-Z\s]/', '', $name));
  $parts = preg_split('/\s+/', trim($nameClean));
  if (!empty($parts[0] ?? '') && !empty($parts[1] ?? '')) return $parts[0][0] . $parts[1][0];
  if (!empty($parts[0] ?? '') && strlen($parts[0]) >= 2) return substr($parts[0], 0, 2);

  return str_pad($ini, 2, 'X');
}

$clean   = [];
$errors  = [];
$results = [];

foreach ($body['salesReps'] as $i => $r) {
  $name       = trim((string)($r['name'] ?? ''));
  $email      = trim((string)($r['email'] ?? ''));
  $phone      = trim((string)($r['phone'] ?? ''));
  $territory  = trim((string)($r['territory'] ?? ''));
  // accept either salesCode or sales_code from the Sheet
  $sales_code = strtoupper(trim((string)($r['sales_code'] ?? $r['salesCode'] ?? '')));
  $initials   = derive_initials((string)($r['initials'] ?? ''), $name, $sales_code);

  if ($name === '' && $email === '' && $sales_code === '') {
    $errors[] = "Row $i: empty record";
    continue;
  }
  if ($sales_code === '' || !preg_match('/^[A-Z]{5}$/', $sales_code)) {
    $errors[] = "Row $i: invalid sales_code";
    continue;
  }

  $clean[] = compact('sales_code','initials','name','email','phone','territory');
}

/**
 * Determine which sales codes should exist after this sync.
 *
 * Priority:
 *  1) If "existingSalesCodes" is present in the JSON, treat it as the authoritative list
 *     (even if it's empty → means delete everything).
 *  2) Otherwise, fall back to the codes present in the cleaned "salesReps" payload
 *     (backwards-compatible with older Apps Script).
 */
$hasExistingKey = array_key_exists('existingSalesCodes', $body);

$existingCodes = [];
if ($hasExistingKey && is_array($body['existingSalesCodes'])) {
  $existingCodes = array_values(array_unique(array_map(
    static fn($c) => strtoupper(trim((string)$c)),
    array_filter($body['existingSalesCodes'], static fn($c) => trim((string)$c) !== '')
  )));
}

// Fallback if existingSalesCodes not provided: use incoming cleaned codes
$incomingCodes = array_values(array_unique(array_column($clean, 'sales_code')));
if (!$hasExistingKey) {
  $existingCodes = $incomingCodes;
}

$deletedSalesCodes = [];

try {
  $pdo = new PDO(
    $config['db_dsn'],
    $config['db_user'],
    $config['db_password'],
    [
      PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
      PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
      PDO::ATTR_EMULATE_PREPARES => false,
    ]
  );

  if (function_exists('set_time_limit')) @set_time_limit(60);
  $pdo->beginTransaction();

  /**
   * Mirror delete behavior:
   *
   * - If "existingSalesCodes" key WAS included in the request:
   *      Treat it as full source of truth.
   *      - If it's empty: delete ALL rows in sales_reps.
   *      - If not empty: delete only rows whose sales_code is NOT in that list.
   *
   * - If "existingSalesCodes" key was NOT included:
   *      Legacy behavior: mirror against incoming cleaned codes only.
   */
  if ($hasExistingKey) {
    // Authoritative list from the Sheet (possibly empty)
    $stmtExisting = $pdo->query('SELECT sales_code FROM sales_reps');
    $dbCodes = $stmtExisting->fetchAll(PDO::FETCH_COLUMN);

    if (empty($existingCodes)) {
      // Sheet says: nothing should exist → delete everything.
      $deletedSalesCodes = array_map('strtoupper', $dbCodes);
      if (!empty($dbCodes)) {
        $pdo->exec('DELETE FROM sales_reps');
      }
    } else {
      // Delete any DB rows whose sales_code is NOT in the Sheet's set.
      $toDelete = array_values(array_diff(array_map('strtoupper', $dbCodes), $existingCodes));
      if (!empty($toDelete)) {
        $deletedSalesCodes = $toDelete;

        // Chunked deletes for safety
        $chunkSize = 500;
        for ($o = 0; $o < count($toDelete); $o += $chunkSize) {
          $chunk = array_slice($toDelete, $o, $chunkSize);
          $placeholders = implode(',', array_fill(0, count($chunk), '?'));
          $del = $pdo->prepare("DELETE FROM sales_reps WHERE UPPER(sales_code) IN ($placeholders)");
          $del->execute($chunk);
        }
      }
    }
  } else {
    // Legacy mirror delete: use just the incoming cleaned codes.
    if (!empty($incomingCodes)) {
      $stmtExisting = $pdo->query('SELECT sales_code FROM sales_reps');
      $dbCodes = $stmtExisting->fetchAll(PDO::FETCH_COLUMN);
      $toDelete = array_values(array_diff(array_map('strtoupper', $dbCodes), $incomingCodes));
      if (!empty($toDelete)) {
        $deletedSalesCodes = $toDelete;

        $chunkSize = 500;
        for ($o = 0; $o < count($toDelete); $o += $chunkSize) {
          $chunk = array_slice($toDelete, $o, $chunkSize);
          $placeholders = implode(',', array_fill(0, count($chunk), '?'));
          $del = $pdo->prepare("DELETE FROM sales_reps WHERE UPPER(sales_code) IN ($placeholders)");
          $del->execute($chunk);
        }
      }
    }
  }

  // Upsert. Table columns: id (auto), sales_code, initials, name, email, phone, territory, updatedAt
  $stmt = $pdo->prepare(
    'INSERT INTO sales_reps (sales_code, initials, name, email, phone, territory)
     VALUES (:sales_code, :initials, :name, :email, :phone, :territory)
     ON DUPLICATE KEY UPDATE
       initials  = VALUES(initials),
       name      = VALUES(name),
       email     = VALUES(email),
       phone     = VALUES(phone),
       territory = VALUES(territory)'
  );

  // Optional user sync: only create/update as sales_rep when not already admin/test_doctor.
  $fetchUser = $pdo->prepare('SELECT id, role FROM users WHERE email = :email LIMIT 1');
  $upsertUser = $pdo->prepare(
    'INSERT INTO users (id, name, email, role, phone, status, created_at, last_login_at)
     VALUES (:id, :name, :email, :role, :phone, :status, NOW(), NOW())
     ON DUPLICATE KEY UPDATE
       name = VALUES(name),
       phone = VALUES(phone),
       role = CASE
         WHEN TRIM(LOWER(users.role)) IN ("admin","test_doctor","doctor") THEN users.role
         WHEN TRIM(LOWER(users.role)) NOT IN ("sales_rep","rep","") THEN users.role
         ELSE VALUES(role)
       END'
  );

  $stored = 0;
  foreach ($clean as $rec) {
    $stmt->execute([
      ':sales_code' => $rec['sales_code'],
      ':initials'   => $rec['initials'],
      ':name'       => $rec['name'],
      ':email'      => $rec['email'],
      ':phone'      => $rec['phone'],
      ':territory'  => $rec['territory'],
    ]);
    $stored++;

    // Sync user record cautiously (do not overwrite admins/test doctors/other custom roles).
    try {
      if ($rec['email'] !== '') {
        $fetchUser->execute([':email' => $rec['email']]);
        $user = $fetchUser->fetch();
        $role = trim(strtolower((string)($user['role'] ?? '')));
        $protectedRoles = ['admin', 'test_doctor', 'doctor'];
        $allowedOverwrite = ['', 'sales_rep', 'rep', null];

        // If role is protected or a custom non-rep role, skip user sync entirely.
        if (in_array($role, $protectedRoles, true)) {
          // preserve as-is
        } elseif (!in_array($role, $allowedOverwrite, true)) {
          // preserve other custom roles; no role change
          $upsertUser->execute([
            ':id' => $user['id'] ?? bin2hex(random_bytes(16)),
            ':name' => $rec['name'],
            ':email' => $rec['email'],
            ':role' => $role ?: 'sales_rep',
            ':phone' => $rec['phone'],
            ':status' => 'active',
          ]);
        } else {
          // New user or existing rep/blank role → set to sales_rep
          $upsertUser->execute([
            ':id' => $user['id'] ?? bin2hex(random_bytes(16)),
            ':name' => $rec['name'],
            ':email' => $rec['email'],
            ':role' => 'sales_rep',
            ':phone' => $rec['phone'],
            ':status' => 'active',
          ]);
        }
      }
    } catch (Throwable $e) {
      // If the users table is absent or insert fails, skip without breaking the webhook.
    }

    $results[] = [
      'salesCode' => $rec['sales_code'],
      'status'    => 'upserted',
    ];
  }

  // Add deletion results
  foreach ($deletedSalesCodes as $code) {
    $results[] = [
      'salesCode' => strtoupper($code),
      'status'    => 'deleted',
    ];
  }

  $pdo->commit();

  respond(200, [
    'ok'                => true,
    'received'          => count($body['salesReps']),
    'stored'            => $stored,
    'skipped'           => count($body['salesReps']) - count($clean),
    'errors'            => $errors,
    'deletedSalesCodes' => array_values(array_unique(array_map('strtoupper', $deletedSalesCodes))),
    'results'           => $results,
  ]);
} catch (Throwable $e) {
  if (isset($pdo) && $pdo->inTransaction()) $pdo->rollBack();
  respond(500, ['ok' => false, 'error' => 'DB_ERROR', 'detail' => $e->getMessage()]);
}
