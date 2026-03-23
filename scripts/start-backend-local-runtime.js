#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = process.cwd();
const runtimeRoot = path.join(os.tmpdir(), 'peppro-backend-runtime');
const statePath = path.join(runtimeRoot, '.runtime-state.json');

const copyTargets = [
  'server',
  'package.json',
  'package-lock.json',
  '.env',
  '.env.local',
  '.env.production',
];

const resolveRepoDataDir = () => {
  const configured = process.env.DATA_DIR;
  if (configured && path.isAbsolute(configured)) {
    return configured;
  }
  if (configured) {
    return path.join(repoRoot, configured);
  }
  return path.join(repoRoot, 'server-data');
};

const safeStat = (targetPath) => {
  try {
    return fs.statSync(targetPath);
  } catch {
    return null;
  }
};

const readState = () => {
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    return null;
  }
};

const ensureParentDir = (targetPath) => {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
};

const removeTarget = (targetPath) => {
  try {
    fs.rmSync(targetPath, { recursive: true, force: true });
  } catch {
    // ignore cleanup failures
  }
};

const runCommand = (command, args, { allowFailure = false } = {}) => {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: 'inherit',
    env: process.env,
  });

  if (!allowFailure && result.status !== 0) {
    process.exit(typeof result.status === 'number' ? result.status : 1);
  }

  return result;
};

const copySingleTarget = (target) => {
  const sourcePath = path.join(repoRoot, target);
  if (!fs.existsSync(sourcePath)) {
    removeTarget(path.join(runtimeRoot, target));
    return;
  }
  const destinationPath = path.join(runtimeRoot, target);
  removeTarget(destinationPath);
  ensureParentDir(destinationPath);
  fs.cpSync(sourcePath, destinationPath, {
    recursive: true,
    force: true,
  });
};

const syncRuntimeFiles = () => {
  fs.mkdirSync(runtimeRoot, { recursive: true });
  const sourceServerDir = path.join(repoRoot, 'server');
  const destinationServerDir = path.join(runtimeRoot, 'server');
  ensureParentDir(destinationServerDir);

  const rsyncResult = runCommand(
    'rsync',
    [
      '-a',
      '--delete',
      `${sourceServerDir}/`,
      `${destinationServerDir}/`,
    ],
    { allowFailure: true },
  );

  if (rsyncResult.status !== 0) {
    removeTarget(destinationServerDir);
    ensureParentDir(destinationServerDir);
    fs.cpSync(sourceServerDir, destinationServerDir, {
      recursive: true,
      force: true,
    });
  }

  for (const target of copyTargets) {
    if (target === 'server') {
      continue;
    }
    copySingleTarget(target);
  }
};

const installDependencies = () => {
  // eslint-disable-next-line no-console
  console.log(`[backend-runtime] Installing dependencies in ${runtimeRoot}`);
  const result = spawnSync('npm', ['ci'], {
    cwd: runtimeRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      NODE_ENV: process.env.NODE_ENV || 'development',
    },
  });

  if (result.status !== 0) {
    process.exit(typeof result.status === 'number' ? result.status : 1);
  }
};

const previousState = readState();
const currentLockfile = safeStat(path.join(repoRoot, 'package-lock.json'))?.mtimeMs || 0;
const runtimeVersion = 2;
const runtimeNeedsSync = !previousState || previousState.runtimeVersion !== runtimeVersion;

const runtimeNeedsInstall = !safeStat(path.join(runtimeRoot, 'node_modules'))
  || !previousState
  || previousState.lockfileMtimeMs !== currentLockfile;

// eslint-disable-next-line no-console
console.log(`[backend-runtime] Syncing backend files to ${runtimeRoot}`);
syncRuntimeFiles();

if (runtimeNeedsInstall) {
  installDependencies();
}

if (!runtimeNeedsInstall) {
  // eslint-disable-next-line no-console
  console.log(`[backend-runtime] Reusing existing runtime at ${runtimeRoot}`);
}

fs.writeFileSync(
  statePath,
  JSON.stringify(
    {
      runtimeVersion,
      lockfileMtimeMs: currentLockfile,
      updatedAt: new Date().toISOString(),
    },
    null,
    2,
  ),
  'utf8',
);

const serverEntry = path.join(runtimeRoot, 'server', 'index.js');
const dataDir = resolveRepoDataDir();
// eslint-disable-next-line no-console
console.log(`[backend-runtime] Starting backend from ${serverEntry}`);
// eslint-disable-next-line no-console
console.log(`[backend-runtime] Using DATA_DIR ${dataDir}`);
const child = spawnSync(process.execPath, [serverEntry], {
  cwd: runtimeRoot,
  stdio: 'inherit',
  env: {
    ...process.env,
    DATA_DIR: dataDir,
    PEPPRO_RUNTIME_SOURCE_ROOT: repoRoot,
  },
});

process.exit(typeof child.status === 'number' ? child.status : 0);
