const fs = require("fs");
const { spawnSync } = require("child_process");
const path = require("path");
const dotenv = require("dotenv");

const repoRoot = process.cwd();
const frontendProductionEnvPath = path.join(repoRoot, ".env.frontend.production");
let frontendProductionEnv = {};

if (fs.existsSync(frontendProductionEnvPath)) {
  frontendProductionEnv = dotenv.parse(fs.readFileSync(frontendProductionEnvPath));
}

const stamp =
  process.env.FRONTEND_BUILD ||
  new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);

const env = {
  ...process.env,
  NODE_ENV: "production",
  FRONTEND_BUILD: process.env.FRONTEND_BUILD || stamp,
  VITE_FRONTEND_BUILD_ID: process.env.VITE_FRONTEND_BUILD_ID || stamp,
  // Keep frontend production build inputs isolated from backend/runtime env files.
  // The bundle should use `.env.frontend.production` or explicit shell exports only.
  VITE_API_URL: Object.prototype.hasOwnProperty.call(process.env, "VITE_API_URL")
    ? process.env.VITE_API_URL
    : (frontendProductionEnv.VITE_API_URL || ""),
  VITE_ALLOW_CROSS_ORIGIN_API: Object.prototype.hasOwnProperty.call(process.env, "VITE_ALLOW_CROSS_ORIGIN_API")
    ? process.env.VITE_ALLOW_CROSS_ORIGIN_API
    : (frontendProductionEnv.VITE_ALLOW_CROSS_ORIGIN_API || ""),
  VITE_WOO_DISABLED: Object.prototype.hasOwnProperty.call(process.env, "VITE_WOO_DISABLED")
    ? process.env.VITE_WOO_DISABLED
    : (frontendProductionEnv.VITE_WOO_DISABLED || ""),
};

const viteBin =
  process.platform === "win32"
    ? path.join("node_modules", ".bin", "vite.cmd")
    : path.join("node_modules", ".bin", "vite");

const viteResult = spawnSync(viteBin, ["build"], {
  stdio: "inherit",
  env,
});

if (viteResult.status !== 0) {
  process.exit(typeof viteResult.status === "number" ? viteResult.status : 1);
}

const tagAssetsResult = spawnSync(process.execPath, [path.join("scripts", "tag-assets.js")], {
  stdio: "inherit",
  env,
});

process.exit(typeof tagAssetsResult.status === "number" ? tagAssetsResult.status : 0);
