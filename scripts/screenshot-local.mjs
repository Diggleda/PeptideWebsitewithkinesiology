import { chromium } from "playwright";

const url = process.argv[2] || "http://127.0.0.1:3000";
const outputPath = process.argv[3] || "artifacts/local-screenshot.png";
const width = Number(process.env.SCREENSHOT_WIDTH || 1440);
const height = Number(process.env.SCREENSHOT_HEIGHT || 1100);

const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage({
    viewport: {
      width: Number.isFinite(width) ? width : 1440,
      height: Number.isFinite(height) ? height : 1100,
    },
  });

  await page.goto(url, { waitUntil: "networkidle" });
  await page.screenshot({ path: outputPath, fullPage: true });
  console.log(outputPath);
} finally {
  await browser.close();
}
