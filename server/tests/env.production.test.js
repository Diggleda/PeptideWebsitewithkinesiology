const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const envModulePath = path.resolve(__dirname, '..', 'config', 'env.js');
const baseProdEnv = {
  PATH: process.env.PATH || '',
  NODE_ENV: 'production',
  JWT_SECRET: 'x'.repeat(64),
  DATA_ENCRYPTION_KEY: 'enc-key',
  MYSQL_ENABLED: 'false',
  FRONTEND_BASE_URL: 'https://prod.example',
};

const runEnvModule = ({ cwd, extraEnv = {} }) =>
  spawnSync(
    process.execPath,
    [
      '-e',
      `const { env } = require(${JSON.stringify(envModulePath)}); console.log(JSON.stringify({ port: env.port }));`,
    ],
    {
      cwd,
      env: {
        ...baseProdEnv,
        ...extraEnv,
      },
      encoding: 'utf8',
    },
  );

test('production ignores repo .env fallback files', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'peppro-env-'));
  fs.writeFileSync(path.join(tempDir, '.env'), 'PORT=9999\n');

  const result = runEnvModule({ cwd: tempDir });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const parsed = JSON.parse(result.stdout.trim());
  assert.equal(parsed.port, 3001);
});

test('production rejects DOTENV_CONFIG_PATH inside the working tree', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'peppro-env-'));
  const envFile = path.join(tempDir, 'peppr-api.env');
  fs.writeFileSync(envFile, 'PORT=9999\n');

  const result = runEnvModule({
    cwd: tempDir,
    extraEnv: {
      DOTENV_CONFIG_PATH: envFile,
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}\n${result.stdout}`, /server-managed file outside the repo/i);
});

test('production requires MYSQL_SSL when MySQL is enabled', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'peppro-env-'));

  const result = runEnvModule({
    cwd: tempDir,
    extraEnv: {
      MYSQL_ENABLED: 'true',
      MYSQL_HOST: 'db.example',
      MYSQL_USER: 'peppr',
      MYSQL_DATABASE: 'peppr',
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}\n${result.stdout}`, /MYSQL_SSL=true is required/i);
});

test('production allows localhost MySQL without MYSQL_SSL', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'peppro-env-'));

  const result = runEnvModule({
    cwd: tempDir,
    extraEnv: {
      MYSQL_ENABLED: 'true',
      MYSQL_HOST: '127.0.0.1',
      MYSQL_USER: 'peppr',
      MYSQL_DATABASE: 'peppr',
    },
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const parsed = JSON.parse(result.stdout.trim());
  assert.equal(parsed.port, 3001);
});
