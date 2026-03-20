const fs = require("fs");
const { spawnSync } = require("child_process");
const path = require("path");
const dotenv = require("dotenv");

const repoRoot = process.cwd();
const productionEnvPath = path.join(repoRoot, ".env.production");
let productionEnv = {};

if (fs.existsSync(productionEnvPath)) {
  productionEnv = dotenv.parse(fs.readFileSync(productionEnvPath));
}

const stamp =
  process.env.FRONTEND_BUILD ||
  new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);

const env = {
  ...process.env,
  NODE_ENV: "production",
  FRONTEND_BUILD: process.env.FRONTEND_BUILD || stamp,
  VITE_FRONTEND_BUILD_ID: process.env.VITE_FRONTEND_BUILD_ID || stamp,
  // Prevent local dev env files like `.env.local` from leaking cross-origin API targets
  // into production bundles unless the build caller explicitly exports them.
  VITE_API_URL: Object.prototype.hasOwnProperty.call(process.env, "VITE_API_URL")
    ? process.env.VITE_API_URL
    : (productionEnv.VITE_API_URL || ""),
  VITE_ALLOW_CROSS_ORIGIN_API: Object.prototype.hasOwnProperty.call(process.env, "VITE_ALLOW_CROSS_ORIGIN_API")
    ? process.env.VITE_ALLOW_CROSS_ORIGIN_API
    : (productionEnv.VITE_ALLOW_CROSS_ORIGIN_API || ""),
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
