const fs = require("fs");
const path = require("path");

const repoRoot = process.cwd();
const sourceRoot = path.join(repoRoot, "public");
const targetRoot = path.join(repoRoot, "src", "generated", "runtime-assets");

const assetsToSync = [
  "PepPro_fulllogo.png",
  "PepPro_icon.png",
  "leafTexture.jpg",
  path.join("icons", "handshake_4233584.png"),
  path.join("logos", "woocommerce.svg"),
  path.join("logos", "shipstation.svg"),
  "peppro-favicon-v3.ico",
  "peppro-favicon-v3-32x32.png",
  "peppro-favicon-v3-16x16.png",
  "peppro-apple-touch-icon-v3.png",
];

for (const relativePath of assetsToSync) {
  const sourcePath = path.join(sourceRoot, relativePath);
  const targetPath = path.join(targetRoot, relativePath);
  const targetDir = path.dirname(targetPath);
  if (!fs.existsSync(sourcePath)) {
    console.error(`[sync-runtime-assets] Missing source asset: ${path.relative(repoRoot, sourcePath)}`);
    process.exit(1);
  }
  fs.mkdirSync(targetDir, { recursive: true });
  fs.copyFileSync(sourcePath, targetPath);
}

console.log(`[sync-runtime-assets] Synced ${assetsToSync.length} assets from public/ to src/generated/runtime-assets/`);
