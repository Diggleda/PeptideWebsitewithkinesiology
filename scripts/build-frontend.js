const { spawnSync } = require("child_process");
const path = require("path");

const stamp =
  process.env.FRONTEND_BUILD ||
  new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);

const env = {
  ...process.env,
  FRONTEND_BUILD: process.env.FRONTEND_BUILD || stamp,
  VITE_FRONTEND_BUILD_ID: process.env.VITE_FRONTEND_BUILD_ID || stamp,
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

