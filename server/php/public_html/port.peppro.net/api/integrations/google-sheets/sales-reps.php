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

/**
 * Generate an ID in the same format used elsewhere in this project: a millisecond
 * timestamp string (e.g. "1762382696762").
 *
 * Adds a small per-process increment to avoid collisions when creating multiple
 * reps within the same millisecond.
 */
function generate_id(): string {
  static $lastMs = 0;
  static $bump = 0;

  $ms = (int)floor(microtime(true) * 1000);
  if ($ms === $lastMs) {
    $bump++;
  } else {
    $lastMs = $ms;
    $bump = 0;
  }

  return (string)($ms + $bump);
}

/** Load column list for a table (used to support multiple schema variants). */
function get_table_columns(PDO $pdo, string $table): array {
  $stmt = $pdo->query("SHOW COLUMNS FROM `$table`");
  $cols = [];
  foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
    if (!empty($row['Field'])) $cols[] = (string)$row['Field'];
  }
  return $cols;
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
$emailToFirstRow = [];
$duplicateEmails = [];

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

  if ($email !== '') {
    $emailKey = strtolower($email);
    if (!array_key_exists($emailKey, $emailToFirstRow)) {
      $emailToFirstRow[$emailKey] = $i;
    } else {
      $duplicateEmails[$emailKey][] = $i;
    }
  }

  $clean[] = ['row_index' => $i] + compact('sales_code','initials','name','email','phone','territory');
}

if (!empty($duplicateEmails)) {
  $dupes = [];
  foreach ($duplicateEmails as $emailKey => $rows) {
    $allRows = array_values(array_unique(array_merge([$emailToFirstRow[$emailKey]], $rows)));
    sort($allRows);
    $dupes[] = ['email' => $emailKey, 'rows' => $allRows];
  }
  respond(422, [
    'ok' => false,
    'error' => 'DUPLICATE_EMAILS',
    'detail' => 'Each non-empty Email must be unique within the sheet.',
    'duplicates' => $dupes,
  ]);
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
$deletionsDisabled = true;

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

  $salesRepsCols = [];
  try {
    $salesRepsCols = get_table_columns($pdo, 'sales_reps');
  } catch (Throwable $e) {
    // If we can't introspect columns, continue with the legacy insert shape below.
  }
  $hasSalesRepsId = in_array('id', $salesRepsCols, true);
  $hasUpdatedAtCamel = in_array('updatedAt', $salesRepsCols, true);
  $hasUpdatedAtSnake = in_array('updated_at', $salesRepsCols, true);
  $hasCreatedAtSnake = in_array('created_at', $salesRepsCols, true);

  /**
   * IMPORTANT: deletions are intentionally disabled.
   *
   * Historically, this webhook supported "mirror deletes" (removing any rep from the database
   * when its sales code is removed from the Google Sheet). In practice, that behavior is risky:
   * it can break historical attribution and id mappings if the sheet is temporarily incomplete,
   * formulas haven't populated, or a rep is removed accidentally.
   *
   * This handler is now "upsert-only": it will create/update reps present in the payload, but
   * it will never delete any rows from `sales_reps`.
   */
  $deletedSalesCodes = [];

  // Lookups so we can reuse existing IDs (and avoid generating a new ID on a duplicate update).
  $findSalesRepIdBySalesCode = $pdo->prepare('SELECT id FROM sales_reps WHERE sales_code = :sales_code LIMIT 1');
  $findSalesRepIdByEmail = $pdo->prepare('SELECT id FROM sales_reps WHERE email = :email LIMIT 1');
  $salesRepIdExists = $pdo->prepare('SELECT 1 FROM sales_reps WHERE id = :id LIMIT 1');

  // Upsert (supports multiple schema variants; always includes id if the table has one).
  $insertCols = [];
  $valuesSql = [];
  if ($hasSalesRepsId) {
    $insertCols[] = 'id';
    $valuesSql[] = ':id';
  }
  $insertCols[] = 'sales_code'; $valuesSql[] = ':sales_code';
  $insertCols[] = 'initials';   $valuesSql[] = ':initials';
  $insertCols[] = 'name';       $valuesSql[] = ':name';
  $insertCols[] = 'email';      $valuesSql[] = ':email';
  $insertCols[] = 'phone';      $valuesSql[] = ':phone';
  $insertCols[] = 'territory';  $valuesSql[] = ':territory';
  if ($hasCreatedAtSnake) {
    $insertCols[] = 'created_at';
    $valuesSql[] = 'NOW()';
  }
  if ($hasUpdatedAtCamel) {
    $insertCols[] = 'updatedAt';
    $valuesSql[] = 'NOW()';
  }
  if ($hasUpdatedAtSnake) {
    $insertCols[] = 'updated_at';
    $valuesSql[] = 'NOW()';
  }

  $updates = [
    'initials = VALUES(initials)',
    'name = VALUES(name)',
    'email = VALUES(email)',
    'phone = VALUES(phone)',
    'territory = VALUES(territory)',
  ];
  if ($hasSalesRepsId) {
    $updates[] = 'id = COALESCE(id, VALUES(id))';
  }
  if ($hasUpdatedAtCamel) $updates[] = 'updatedAt = NOW()';
  if ($hasUpdatedAtSnake) $updates[] = 'updated_at = NOW()';

  $stmt = $pdo->prepare(
    'INSERT INTO sales_reps (' . implode(', ', $insertCols) . ')
     VALUES (' . implode(', ', $valuesSql) . ')
     ON DUPLICATE KEY UPDATE ' . implode(', ', $updates)
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
    $rowIndex = (int)($rec['row_index'] ?? -1);
    $userId = null;
    $salesRepId = null;

    if ($hasSalesRepsId) {
      $candidateId = trim((string)($rec['id'] ?? ''));
      if ($candidateId !== '') {
        $salesRepId = $candidateId;
      } else {
        try {
          $findSalesRepIdBySalesCode->execute([':sales_code' => $rec['sales_code']]);
          $existing = $findSalesRepIdBySalesCode->fetchColumn();
          if ($existing !== false && $existing !== null && $existing !== '') {
            $salesRepId = (string)$existing;
          }
        } catch (Throwable $e) {
          // ignore
        }
        if ($salesRepId === null && $rec['email'] !== '') {
          try {
            $findSalesRepIdByEmail->execute([':email' => strtolower($rec['email'])]);
            $existing = $findSalesRepIdByEmail->fetchColumn();
            if ($existing !== false && $existing !== null && $existing !== '') {
              $salesRepId = (string)$existing;
            }
          } catch (Throwable $e) {
            // ignore
          }
        }
        if ($salesRepId === null) {
          $attempts = 0;
          do {
            $attempts++;
            $candidate = generate_id();
            $exists = false;
            try {
              $salesRepIdExists->execute([':id' => $candidate]);
              $exists = (bool)$salesRepIdExists->fetchColumn();
            } catch (Throwable $e) {
              // If we can't check uniqueness, fall back to the generated value.
              $exists = false;
            }
            if (!$exists) {
              $salesRepId = $candidate;
              break;
            }
          } while ($attempts < 50);

          if ($salesRepId === null) {
            throw new RuntimeException('Unable to generate unique sales_reps.id');
          }
        }
      }
    }

    try {
      $params = [
        ':sales_code' => $rec['sales_code'],
        ':initials'   => $rec['initials'],
        ':name'       => $rec['name'],
        ':email'      => $rec['email'],
        ':phone'      => $rec['phone'],
        ':territory'  => $rec['territory'],
      ];
      if ($hasSalesRepsId) $params[':id'] = $salesRepId;

      $stmt->execute($params);
      $stored++;
    } catch (Throwable $e) {
      // If we collided on a newly-generated ID, retry a few times.
      if ($hasSalesRepsId && $salesRepId !== null && str_contains($e->getMessage(), 'Duplicate entry')) {
        $retried = false;
        for ($retry = 0; $retry < 5; $retry++) {
          $candidate = generate_id();
          try {
            $salesRepIdExists->execute([':id' => $candidate]);
            if ($salesRepIdExists->fetchColumn()) continue;
          } catch (Throwable $ignore) {
            // ignore
          }
          $params[':id'] = $candidate;
          try {
            $stmt->execute($params);
            $salesRepId = $candidate;
            $stored++;
            $retried = true;
            break;
          } catch (Throwable $ignore) {
            // continue retry loop
          }
        }
        if ($retried) {
          // continue on to user sync + results
        } else {
          $errors[] = ($rowIndex >= 0)
            ? "Row $rowIndex: DB upsert failed: " . $e->getMessage()
            : "DB upsert failed: " . $e->getMessage();
          $results[] = [
            'salesCode' => $rec['sales_code'],
            'status' => 'error',
            'error' => 'DB_UPSERT_FAILED',
          ];
          continue;
        }
      } else {
      $errors[] = ($rowIndex >= 0)
        ? "Row $rowIndex: DB upsert failed: " . $e->getMessage()
        : "DB upsert failed: " . $e->getMessage();
      $results[] = [
        'salesCode' => $rec['sales_code'],
        'status' => 'error',
        'error' => 'DB_UPSERT_FAILED',
      ];
      continue;
      }
    }

    // Sync user record cautiously (do not overwrite admins/test doctors/other custom roles).
    try {
      if ($rec['email'] !== '') {
        $fetchUser->execute([':email' => $rec['email']]);
        $user = $fetchUser->fetch();
        $role = trim(strtolower((string)($user['role'] ?? '')));
        $protectedRoles = ['admin', 'test_doctor', 'doctor'];
        $allowedOverwrite = ['', 'sales_rep', 'rep', null];
        $candidateId = $user['id'] ?? bin2hex(random_bytes(16));

        // If role is protected or a custom non-rep role, skip user sync entirely.
        if (in_array($role, $protectedRoles, true)) {
          // preserve as-is
        } elseif (!in_array($role, $allowedOverwrite, true)) {
          // preserve other custom roles; no role change
          $upsertUser->execute([
            ':id' => $candidateId,
            ':name' => $rec['name'],
            ':email' => $rec['email'],
            ':role' => $role ?: 'sales_rep',
            ':phone' => $rec['phone'],
            ':status' => 'active',
          ]);
          $userId = $candidateId;
        } else {
          // New user or existing rep/blank role → set to sales_rep
          $upsertUser->execute([
            ':id' => $candidateId,
            ':name' => $rec['name'],
            ':email' => $rec['email'],
            ':role' => 'sales_rep',
            ':phone' => $rec['phone'],
            ':status' => 'active',
          ]);
          $userId = $candidateId;
        }
      }
    } catch (Throwable $e) {
      // If the users table is absent or insert fails, skip without breaking the webhook.
    }

    if ($hasSalesRepsId && $salesRepId === null) {
      try {
        $findSalesRepIdBySalesCode->execute([':sales_code' => $rec['sales_code']]);
        $id = $findSalesRepIdBySalesCode->fetchColumn();
        if ($id !== false && $id !== null && $id !== '') $salesRepId = (string)$id;
      } catch (Throwable $e) {
        // ignore
      }
    }

    $results[] = [
      'salesCode' => $rec['sales_code'],
      'status'    => 'upserted',
      'salesRepId' => $salesRepId,
      'userId' => $userId,
    ];
  }

  // Deletions are disabled; no delete results.

  $pdo->commit();

  respond(200, [
    'ok'                => true,
    'received'          => count($body['salesReps']),
    'stored'            => $stored,
    'skipped'           => count($body['salesReps']) - count($clean),
    'errors'            => $errors,
    'deletedSalesCodes' => [],
    'deletionsDisabled' => $deletionsDisabled,
    'results'           => $results,
  ]);
} catch (Throwable $e) {
  if (isset($pdo) && $pdo->inTransaction()) $pdo->rollBack();
  respond(500, ['ok' => false, 'error' => 'DB_ERROR', 'detail' => $e->getMessage()]);
}
