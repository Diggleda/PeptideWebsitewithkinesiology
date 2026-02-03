#!/usr/bin/env node
/**
 * Converts the DOCX source documents into the HTML snippets consumed
 * by the React app. Uses macOS `textutil` so inline formatting such
 * as font sizes is preserved.
 */
const path = require('path');
const fs = require('fs/promises');
const { execFile } = require('child_process');

const projectRoot = path.resolve(__dirname, '..');

const documents = [
  {
    docx: 'src/content/landing/Physicians-choice.docx',
    html: 'src/content/landing/physicians-choice.html',
  },
  {
    docx: 'src/content/landing/Care-Compliance.docx',
    html: 'src/content/landing/care-compliance.html',
  },
  {
    // Source doc is versioned in this repo; keep `terms.html` as the stable output path.
    docx: 'src/content/legal/Terms-of-service-2.docx',
    html: 'src/content/legal/terms.html',
  },
  {
    // Source doc is versioned in this repo; keep `privacy.html` as the stable output path.
    docx: 'src/content/legal/Privacy-policy-4.docx',
    html: 'src/content/legal/privacy.html',
  },
  {
    docx: 'src/content/legal/Shipping-Handling.docx',
    html: 'src/content/legal/shipping.html',
  },
];

function convertWithTextutil(inputPath) {
  return new Promise((resolve, reject) => {
    execFile(
      'textutil',
      ['-convert', 'html', inputPath, '-stdout'],
      { maxBuffer: 10 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

const EMAIL_REGEX = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

function linkifyEmails(html) {
  let out = '';
  let index = 0;
  let inAnchor = false;

  while (index < html.length) {
    const nextTag = html.indexOf('<', index);
    if (nextTag === -1) {
      const tail = html.slice(index);
      out += inAnchor
        ? tail
        : tail.replace(EMAIL_REGEX, (email) => `<a href="mailto:${email}">${email}</a>`);
      break;
    }

    const text = html.slice(index, nextTag);
    out += inAnchor
      ? text
      : text.replace(EMAIL_REGEX, (email) => `<a href="mailto:${email}">${email}</a>`);

    const tagEnd = html.indexOf('>', nextTag);
    if (tagEnd === -1) {
      out += html.slice(nextTag);
      break;
    }

    const tag = html.slice(nextTag, tagEnd + 1);
    const tagLower = tag.toLowerCase();
    if (tagLower.startsWith('<a ') || tagLower === '<a>') {
      inAnchor = true;
    } else if (tagLower.startsWith('</a')) {
      inAnchor = false;
    }

    out += tag;
    index = tagEnd + 1;
  }

  return out;
}

function replaceRegionalAdministrator(html) {
  return html.replace(/regional administrator/gi, (match) => {
    const firstChar = match.charAt(0);
    if (firstChar && firstChar === firstChar.toUpperCase()) {
      return "Representative";
    }
    return "representative";
  });
}

function normalizeSupportEmails(html) {
  // Underwriting/compliance requires a domain-based email. Keep a single canonical contact email.
  return html.replace(/support@peppro\.com/gi, 'support@peppro.net');
}

async function convertDocument({ docx, html }) {
  const inputPath = path.join(projectRoot, docx);
  const outputPath = path.join(projectRoot, html);
  const publicContentRoot = path.join(projectRoot, 'public', 'content');

  const rawHtml = await convertWithTextutil(inputPath);
  const styleBlocks = [...rawHtml.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((match) => match[0]);
  let styles = '';
  if (styleBlocks.length) {
    styles = styleBlocks
      .join('\n')
      // Remove any @font-face declarations so we inherit the site font.
      .replace(/@font-face[\s\S]*?}/gi, '')
      // Remove inline font-family overrides while preserving other styles.
      .replace(/font-family:[^;]+;?/gi, '');
  }

  const bodyMatch = rawHtml.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const content = bodyMatch ? bodyMatch[1].trim() : rawHtml.trim();
  const finalHtml = `${styles ? `${styles}\n` : ''}${normalizeSupportEmails(replaceRegionalAdministrator(linkifyEmails(content)))}\n`;

  await fs.writeFile(outputPath, finalHtml, 'utf8');

  // Also mirror into `public/content/...` so dev + static builds can fetch these
  // documents at `/content/...` without requiring a special backend route.
  const marker = path.join('src', 'content') + path.sep;
  const normalizedHtml = html.split('/').join(path.sep);
  const idx = normalizedHtml.indexOf(marker);
  if (idx >= 0) {
    const relative = normalizedHtml.slice(idx + marker.length);
    const publicPath = path.join(publicContentRoot, relative);
    await fs.mkdir(path.dirname(publicPath), { recursive: true });
    await fs.writeFile(publicPath, finalHtml, 'utf8');
  }

  // Back-compat aliases (some deployments/link targets expect these at the web root).
  if (html.endsWith('src/content/landing/physicians-choice.html')) {
    await fs.writeFile(path.join(projectRoot, 'public', 'physicians-choice.html'), finalHtml, 'utf8');
  }
  if (html.endsWith('src/content/landing/care-compliance.html')) {
    await fs.writeFile(path.join(projectRoot, 'public', 'care-compliance.html'), finalHtml, 'utf8');
  }

  console.log(`Converted ${docx} -> ${html}`);
}

async function run() {
  for (const doc of documents) {
    await convertDocument(doc);
  }
}

run().catch((error) => {
  console.error('[convert-docx] Failed:', error);
  process.exitCode = 1;
});
