const fs = require("fs");
const path = require("path");

const repoRoot = process.cwd();
const sourceRoot = path.join(repoRoot, "public");
const targetRoot = path.join(repoRoot, "src", "generated", "runtime-assets");

const assetsToSync = [
  "FullLogo_Transparent_NoBuffer (18).png",
  "TrufusionLabs_Share.jpg",
  "TrufusionLabs_PhysiciansPortal.png",
  "Trufusionpeptides_icon.png",
  "protixa.png",
  "blueleafTexture-email.png",
  "leafTexture.png",
  path.join("icons", "handshake_4233584.png"),
  path.join("logos", "woocommerce.svg"),
  path.join("logos", "shipstation.svg"),
  "favicon.ico",
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
