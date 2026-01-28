const fs = require('fs');
const path = require('path');

const stamp = process.env.FRONTEND_BUILD || new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
const buildDir = path.join(process.cwd(), 'build');
const assetsDir = path.join(buildDir, 'assets');
const indexPath = path.join(buildDir, 'index.html');
const hashedPattern = /^[a-z0-9._-]+-[a-z0-9]{8,}\.(js|css)$/i;

if (!fs.existsSync(indexPath) || !fs.existsSync(assetsDir)) {
  console.error('[tag-assets] Missing build artifacts; skipping');
  process.exit(0);
}

const renamedAssets = [];
const skippedAssets = [];

fs.readdirSync(assetsDir)
  .filter((file) => /\.(js|css)$/i.test(file))
  .forEach((file) => {
    // If the asset already carries a content hash (Vite default), leave it alone.
    if (hashedPattern.test(file)) {
      skippedAssets.push(file);
      return;
    }

    const ext = path.extname(file);
    const base = path.basename(file, ext);
    const newName = `${base}-${stamp}${ext}`;
    fs.renameSync(path.join(assetsDir, file), path.join(assetsDir, newName));
    renamedAssets.push({ original: file, next: newName });
  });

let html = fs.readFileSync(indexPath, 'utf8');

renamedAssets.forEach(({ original, next }) => {
  const escaped = original.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`/assets/${escaped}`, 'g');
  html = html.replace(pattern, `/assets/${next}`);
});

fs.writeFileSync(indexPath, html);
console.log(
  `[tag-assets] Renamed ${renamedAssets.length} assets with stamp ${stamp}; skipped ${skippedAssets.length} pre-hashed assets`,
);
