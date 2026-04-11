const fs = require('fs');
const os = require('os');
const path = require('path');

const repoRoot = process.cwd();
const configuredCacheDir = process.env.VITE_CACHE_DIR || path.join(os.tmpdir(), 'peppro-vite-cache');

const candidatePaths = [
  path.join(repoRoot, 'node_modules', '.vite'),
  path.join(repoRoot, '.vite'),
  configuredCacheDir,
];

const seen = new Set();
const removed = [];
const skipped = [];

candidatePaths.forEach((candidatePath) => {
  const resolvedPath = path.resolve(candidatePath);
  if (seen.has(resolvedPath)) {
    return;
  }
  seen.add(resolvedPath);

  if (!fs.existsSync(resolvedPath)) {
    skipped.push(resolvedPath);
    return;
  }

  fs.rmSync(resolvedPath, { recursive: true, force: true });
  removed.push(resolvedPath);
});

removed.forEach((removedPath) => {
  console.log(`[clear-vite-cache] Removed ${removedPath}`);
});

if (removed.length === 0) {
  console.log('[clear-vite-cache] No Vite cache directories found');
}

skipped.forEach((skippedPath) => {
  console.log(`[clear-vite-cache] Skipped missing ${skippedPath}`);
});
