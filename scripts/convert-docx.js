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
    docx: 'src/content/legal/Terms-of-service-7.docx',
    html: 'src/content/legal/terms.html',
  },
  {
    // Source doc is versioned in this repo; keep `privacy.html` as the stable output path.
    docx: 'src/content/legal/Privacy-policy-6.docx',
    html: 'src/content/legal/privacy.html',
  },
  {
    docx: 'src/content/legal/Shipping-Handling.docx',
    html: 'src/content/legal/shipping.html',
  },
];

const staticMirrors = [
  'src/content/legal/contact.html',
  'src/content/legal/returns.html',
  'src/content/legal/open-source-notices.html',
];

const force = process.argv.includes('--force');

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
  return html
    .replace(/support@peppro\.net/gi, 'support@trufusionlabs.com')
    .replace(/support@trufusion\.com/gi, 'support@trufusionlabs.com');
}

function normalizeBrandTerms(html) {
  return html
    .replace(/api\.peppro\.net/gi, 'api.trufusionlabs.com')
    .replace(/shop\.peppro\.net/gi, 'shop.trufusionlabs.com')
    .replace(/port\.peppro\.net/gi, 'port.trufusionlabs.com')
    .replace(/www\.peppro\.net/gi, 'www.trufusionlabs.com')
    .replace(/peppro\.net/gi, 'trufusionlabs.com')
    .replace(/PepPro/g, 'TrufusionLabs')
    .replace(/PEPPRO/g, 'TRUFUSION')
    .replace(/Peppro/g, 'Trufusion')
    .replace(/peppro/g, 'trufusion');
}

function cleanInlineHtml(html) {
  return String(html || '')
    .replace(/<span\b[^>]*>/gi, '')
    .replace(/<\/span>/gi, '')
    .replace(/class="[^"]*"/gi, '')
    .replace(/style="[^"]*"/gi, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function textFromHtml(html) {
  return cleanInlineHtml(html)
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .trim();
}

function formatMetadataLine(line) {
  const match = textFromHtml(line).match(/^(Effective Date|Last Updated|Version):\s*(.+)$/i);
  if (!match) {
    return cleanInlineHtml(line);
  }
  const canonicalLabel = match[1].toLowerCase() === 'version'
    ? 'Version'
    : match[1].toLowerCase() === 'last updated'
      ? 'Last Updated'
      : 'Effective Date';
  return `<strong>${canonicalLabel}:</strong> ${match[2].trim()}`;
}

function formatLegalParagraph(innerHtml) {
  const lines = String(innerHtml || '')
    .split(/<br\s*\/?>/gi)
    .map(cleanInlineHtml)
    .filter(Boolean);
  if (lines.length === 0) {
    return null;
  }

  const plainLines = lines.map(textFromHtml);
  const isMetadataBlock = plainLines.every((line) =>
    /^(Effective Date|Last Updated|Version):\s*.+$/i.test(line),
  );
  if (isMetadataBlock) {
    return `<p>${lines.map(formatMetadataLine).join('<br>')}</p>`;
  }

  const joined = lines.join('<br>');
  const plainText = textFromHtml(joined);
  if (/^(Terms of Service|Privacy Policy|Shipping Policy)$/i.test(plainText)) {
    return `<p><strong>${plainText}</strong></p>`;
  }
  if (/^\d+\.\s+\S/.test(plainText) && plainText.length <= 140) {
    return `<p><strong>${joined}</strong></p>`;
  }
  return `<p>${joined}</p>`;
}

function formatLegalDocumentHtml(content) {
  const paragraphs = [];
  const paragraphRegex = /<p\b[^>]*>([\s\S]*?)<\/p>/gi;
  let match;
  while ((match = paragraphRegex.exec(content)) !== null) {
    const paragraph = formatLegalParagraph(match[1]);
    if (paragraph) {
      paragraphs.push(`  ${paragraph}`);
    }
  }

  if (paragraphs.length === 0) {
    return `<div class="legal-docx-content">\n  ${cleanInlineHtml(content)}\n</div>\n`;
  }

  return `<div class="legal-docx-content">\n${paragraphs.join('\n')}\n</div>\n`;
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
  const normalizedContent = normalizeBrandTerms(normalizeSupportEmails(replaceRegionalAdministrator(linkifyEmails(content))));
  const isLegalDoc = html.includes('src/content/legal/');
  const finalHtml = isLegalDoc
    ? formatLegalDocumentHtml(normalizedContent)
    : `${styles ? `${styles}\n` : ''}${normalizedContent}\n`;

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

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function getPublicMirrorTargets(html) {
  const targets = [];
  const publicContentRoot = path.join(projectRoot, 'public', 'content');
  const marker = path.join('src', 'content') + path.sep;
  const normalizedHtml = html.split('/').join(path.sep);
  const idx = normalizedHtml.indexOf(marker);
  if (idx >= 0) {
    const relative = normalizedHtml.slice(idx + marker.length);
    targets.push(path.join(publicContentRoot, relative));
  }

  if (html.endsWith('src/content/landing/physicians-choice.html')) {
    targets.push(path.join(projectRoot, 'public', 'physicians-choice.html'));
  }
  if (html.endsWith('src/content/landing/care-compliance.html')) {
    targets.push(path.join(projectRoot, 'public', 'care-compliance.html'));
  }

  return targets;
}

async function mirrorStaticHtml(relativeSource) {
  const sourcePath = path.join(projectRoot, relativeSource);
  const publicContentRoot = path.join(projectRoot, 'public', 'content');
  const marker = path.join('src', 'content') + path.sep;
  const normalizedSource = relativeSource.split('/').join(path.sep);
  const idx = normalizedSource.indexOf(marker);
  if (idx < 0) {
    return;
  }
  const relative = normalizedSource.slice(idx + marker.length);
  const publicPath = path.join(publicContentRoot, relative);
  const content = await fs.readFile(sourcePath, 'utf8');
  await fs.mkdir(path.dirname(publicPath), { recursive: true });
  await fs.writeFile(publicPath, content, 'utf8');
  console.log(`Mirrored ${relativeSource} -> ${path.relative(projectRoot, publicPath)}`);
}

async function needsConversion({ docx, html }) {
  if (force) {
    return true;
  }

  const inputPath = path.join(projectRoot, docx);
  const outputPath = path.join(projectRoot, html);
  const mirrorTargets = await getPublicMirrorTargets(html);

  const [inputStat, outputExists] = await Promise.all([
    fs.stat(inputPath),
    pathExists(outputPath),
  ]);

  if (!outputExists) {
    return true;
  }

  const outputStat = await fs.stat(outputPath);
  if (inputStat.mtimeMs > outputStat.mtimeMs) {
    return true;
  }

  for (const target of mirrorTargets) {
    // eslint-disable-next-line no-await-in-loop
    const exists = await pathExists(target);
    if (!exists) {
      return true;
    }
    // eslint-disable-next-line no-await-in-loop
    const stat = await fs.stat(target);
    if (inputStat.mtimeMs > stat.mtimeMs) {
      return true;
    }
  }

  return false;
}

async function run() {
  const decisions = await Promise.all(
    documents.map(async (doc) => ({
      doc,
      shouldConvert: await needsConversion(doc),
    })),
  );

  const pending = decisions.filter((entry) => entry.shouldConvert).map((entry) => entry.doc);
  if (pending.length === 0) {
    console.log('DOCX content is up to date; skipping conversion.');
  } else {
    await Promise.all(pending.map((doc) => convertDocument(doc)));
  }

  await Promise.all(staticMirrors.map((source) => mirrorStaticHtml(source)));
}

run().catch((error) => {
  console.error('[convert-docx] Failed:', error);
  process.exitCode = 1;
});
