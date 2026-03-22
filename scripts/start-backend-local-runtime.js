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

const collectLatestMtimeMs = (targetPath) => {
  const stat = safeStat(targetPath);
  if (!stat) {
    return 0;
  }
  if (!stat.isDirectory()) {
    return stat.mtimeMs;
  }

  let latest = stat.mtimeMs;
  for (const entry of fs.readdirSync(targetPath)) {
    latest = Math.max(latest, collectLatestMtimeMs(path.join(targetPath, entry)));
  }
  return latest;
};

const buildSourceSignature = () => copyTargets.map((target) => {
  const absolutePath = path.join(repoRoot, target);
  return {
    target,
    mtimeMs: collectLatestMtimeMs(absolutePath),
  };
});

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

const syncRuntimeFiles = () => {
  fs.mkdirSync(runtimeRoot, { recursive: true });
  for (const target of copyTargets) {
    const sourcePath = path.join(repoRoot, target);
    if (!fs.existsSync(sourcePath)) {
      continue;
    }
    const destinationPath = path.join(runtimeRoot, target);
    removeTarget(destinationPath);
    ensureParentDir(destinationPath);
    fs.cpSync(sourcePath, destinationPath, {
      recursive: true,
      force: true,
    });
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

const sourceSignature = buildSourceSignature();
const previousState = readState();
const currentLockfile = collectLatestMtimeMs(path.join(repoRoot, 'package-lock.json'));

const runtimeNeedsSync = !previousState
  || JSON.stringify(previousState.sourceSignature) !== JSON.stringify(sourceSignature);

const runtimeNeedsInstall = !safeStat(path.join(runtimeRoot, 'node_modules'))
  || !previousState
  || previousState.lockfileMtimeMs !== currentLockfile;

if (runtimeNeedsSync) {
  // eslint-disable-next-line no-console
  console.log(`[backend-runtime] Syncing backend files to ${runtimeRoot}`);
  syncRuntimeFiles();
}

if (runtimeNeedsInstall) {
  installDependencies();
}

if (!runtimeNeedsSync && !runtimeNeedsInstall) {
  // eslint-disable-next-line no-console
  console.log(`[backend-runtime] Reusing existing runtime at ${runtimeRoot}`);
}

fs.writeFileSync(
  statePath,
  JSON.stringify(
    {
      sourceSignature,
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
