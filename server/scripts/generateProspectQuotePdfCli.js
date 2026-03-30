#!/usr/bin/env node

const { generateProspectQuotePdf } = require('../services/salesProspectQuotePdfService');

const readStdin = async () => new Promise((resolve, reject) => {
  const chunks = [];
  process.stdin.on('data', (chunk) => chunks.push(chunk));
  process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  process.stdin.on('error', reject);
});

const main = async () => {
  const raw = await readStdin();
  const payload = raw ? JSON.parse(raw) : {};
  const quote = payload && typeof payload === 'object' ? payload.quote || {} : {};
  const rendered = await generateProspectQuotePdf(quote);
  process.stdout.write(JSON.stringify({
    filename: rendered.filename,
    pdfBase64: Buffer.from(rendered.pdf).toString('base64'),
    debug: rendered.diagnostics || null,
  }));
};

main().catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
  process.exit(1);
});
