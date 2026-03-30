#!/usr/bin/env node

const readline = require('node:readline');
const { chromium } = require('playwright');
const {
  buildChromiumLaunchOptions,
  generateProspectQuotePdfWithBrowser,
} = require('../services/salesProspectQuotePdfService');

let browserPromise = null;

const writeResponse = (payload) => {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
};

const closeBrowser = async () => {
  if (!browserPromise) {
    return;
  }
  try {
    const browser = await browserPromise;
    await browser.close();
  } catch {
    // Ignore browser shutdown issues; the worker will be restarted by the caller.
  } finally {
    browserPromise = null;
  }
};

const getBrowser = async () => {
  if (!browserPromise) {
    browserPromise = chromium.launch(buildChromiumLaunchOptions()).catch((error) => {
      browserPromise = null;
      throw error;
    });
  }
  return browserPromise;
};

const renderQuote = async ({ id, quote }) => {
  let browser = await getBrowser();
  try {
    const rendered = await generateProspectQuotePdfWithBrowser(browser, quote || {});
    writeResponse({
      id,
      filename: rendered.filename,
      pdfBase64: Buffer.from(rendered.pdf).toString('base64'),
    });
  } catch (error) {
    await closeBrowser();
    try {
      browser = await getBrowser();
      const rendered = await generateProspectQuotePdfWithBrowser(browser, quote || {});
      writeResponse({
        id,
        filename: rendered.filename,
        pdfBase64: Buffer.from(rendered.pdf).toString('base64'),
      });
    } catch (retryError) {
      writeResponse({
        id,
        error: retryError && retryError.stack ? retryError.stack : String(retryError),
      });
    }
  }
};

const queue = [];
let processing = false;

const drainQueue = async () => {
  if (processing) {
    return;
  }
  processing = true;
  try {
    while (queue.length > 0) {
      const payload = queue.shift();
      await renderQuote(payload);
    }
  } finally {
    processing = false;
  }
};

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

rl.on('line', (line) => {
  const raw = String(line || '').trim();
  if (!raw) {
    return;
  }
  try {
    const payload = JSON.parse(raw);
    queue.push({
      id: payload && typeof payload === 'object' ? payload.id || null : null,
      quote: payload && typeof payload === 'object' ? payload.quote || {} : {},
    });
  } catch (error) {
    writeResponse({
      id: null,
      error: error && error.stack ? error.stack : String(error),
    });
    return;
  }
  void drainQueue();
});

const shutdown = async () => {
  rl.close();
  await closeBrowser();
  process.exit(0);
};

process.stdin.on('end', () => {
  void shutdown();
});

process.on('SIGINT', () => {
  void shutdown();
});

process.on('SIGTERM', () => {
  void shutdown();
});
