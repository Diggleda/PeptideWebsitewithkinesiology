const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const repoRoot = process.cwd();
const buildDir = path.join(repoRoot, "build");
const outputArg = process.argv[2] || "frontend_flattened.zip";
const outputPath = path.resolve(repoRoot, outputArg);

if (!fs.existsSync(buildDir) || !fs.statSync(buildDir).isDirectory()) {
  console.error("[zip-frontend] Missing build/ directory. Run `npm run build` first.");
  process.exit(1);
}

if (fs.existsSync(outputPath)) {
  fs.rmSync(outputPath, { force: true });
}

const zipResult = spawnSync(
  "zip",
  ["-r", outputPath, ".", "-x", "*.DS_Store", "-x", "*/.DS_Store"],
  {
    cwd: buildDir,
    stdio: "inherit",
  },
);

if (zipResult.status !== 0) {
  process.exit(typeof zipResult.status === "number" ? zipResult.status : 1);
}

const verifyResult = spawnSync("unzip", ["-l", outputPath], {
  cwd: repoRoot,
  encoding: "utf8",
});

if (verifyResult.status !== 0) {
  console.error("[zip-frontend] Failed to inspect generated archive.");
  process.exit(typeof verifyResult.status === "number" ? verifyResult.status : 1);
}

const listing = verifyResult.stdout || "";
const hasRootIndex = /(^|\n)\s*\d+\s+.+\s+index\.html\s*$/m.test(listing);
const hasRootJs = /(^|\n)\s*\d+\s+.+\s+assets\/index-.*\.js\s*$/m.test(listing);
const hasRootCss = /(^|\n)\s*\d+\s+.+\s+assets\/index-.*\.css\s*$/m.test(listing);
const incorrectlyNestedBuild = /(^|\n)\s*\d+\s+.+\s+build\/index\.html\s*$/m.test(listing);

if (!hasRootIndex || !hasRootJs || !hasRootCss || incorrectlyNestedBuild) {
  console.error("[zip-frontend] Archive verification failed.");
  if (!hasRootIndex) console.error("  - Missing root index.html");
  if (!hasRootJs) console.error("  - Missing root assets/index-*.js");
  if (!hasRootCss) console.error("  - Missing root assets/index-*.css");
  if (incorrectlyNestedBuild) console.error("  - Archive is incorrectly nested under build/");
  process.exit(1);
}

console.log(`[zip-frontend] Created flattened archive: ${path.relative(repoRoot, outputPath)}`);
