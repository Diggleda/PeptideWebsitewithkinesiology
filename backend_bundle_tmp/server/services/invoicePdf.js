const roundCurrency = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  return Math.round((numeric + Number.EPSILON) * 100) / 100;
};

const currencySymbol = (code) => {
  const normalized = String(code || 'USD').trim().toUpperCase();
  if (normalized === 'USD') return '$';
  return `${normalized} `;
};

const formatMoney = (amount, currency) => {
  const symbol = currencySymbol(currency);
  const value = roundCurrency(amount);
  return `${symbol}${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

const escapePdfText = (value) => String(value || '')
  .replace(/\\/g, '\\\\')
  .replace(/\(/g, '\\(')
  .replace(/\)/g, '\\)')
  .replace(/\r/g, '');

const buildSimpleTextPdf = (lines) => {
  // Letter: 612 x 792 points
  const pageW = 612;
  const pageH = 792;
  const left = 72;
  const top = pageH - 72;
  const fontSize = 11;
  const leading = 14;

  const contentLines = [
    'BT',
    `/F1 ${fontSize} Tf`,
    `${left} ${top} Td`,
    `${leading} TL`,
  ];

  for (const raw of lines) {
    const text = escapePdfText(String(raw || '')).slice(0, 240);
    contentLines.push(`(${text}) Tj`);
    contentLines.push('T*');
  }
  contentLines.push('ET');
  const content = Buffer.from(`${contentLines.join('\n')}\n`, 'latin1');

  const objects = [];
  const obj = (num, body) => Buffer.concat([
    Buffer.from(`${num} 0 obj\n`, 'ascii'),
    body,
    Buffer.from('\nendobj\n', 'ascii'),
  ]);

  objects.push(obj(1, Buffer.from('<< /Type /Catalog /Pages 2 0 R >>', 'ascii')));
  objects.push(obj(2, Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>', 'ascii')));
  objects.push(obj(3, Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW} ${pageH}] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>`, 'ascii')));
  objects.push(obj(4, Buffer.from(`<< /Length ${content.length} >>\nstream\n`, 'ascii')));
  objects.push(content);
  objects.push(Buffer.from('\nendstream\nendobj\n', 'ascii'));
  objects.push(obj(5, Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', 'ascii')));

  // Build xref
  const header = Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1');
  const body = Buffer.concat(objects);

  const offsets = [];
  let cursor = header.length;
  // objects includes 5 objects + embedded content segment; track actual "obj" boundaries
  // We built object 4 in two parts; offsets should still align with object starts 1..5.
  // Rebuild with explicit offsets for each numbered object.
  const rebuiltObjects = [];
  const add = (buf, isObjStart) => {
    if (isObjStart) offsets.push(cursor);
    rebuiltObjects.push(buf);
    cursor += buf.length;
  };

  cursor = header.length;
  offsets.length = 0;
  rebuiltObjects.length = 0;
  add(objects[0], true); // 1
  add(objects[1], true); // 2
  add(objects[2], true); // 3
  add(objects[3], true); // 4 start
  add(objects[4], false); // content
  add(objects[5], false); // endstream/endobj
  add(objects[6], true); // 5

  const rebuiltBody = Buffer.concat(rebuiltObjects);

  const xrefStart = header.length + rebuiltBody.length;
  const xrefLines = ['xref', `0 ${offsets.length + 1}`, '0000000000 65535 f '];
  for (const offset of offsets) {
    xrefLines.push(`${String(offset).padStart(10, '0')} 00000 n `);
  }
  const xref = Buffer.from(`${xrefLines.join('\n')}\n`, 'ascii');
  const trailer = Buffer.from(
    `trailer\n<< /Size ${offsets.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`,
    'ascii',
  );

  return Buffer.concat([header, rebuiltBody, xref, trailer]);
};

const buildInvoicePdf = (wooOrder, { orderToken } = {}) => {
  const currency = String(wooOrder?.currency || 'USD').trim().toUpperCase() || 'USD';
  const number = String(wooOrder?.number || wooOrder?.id || orderToken || '').trim() || 'order';
  const createdAt = String(wooOrder?.date_created || wooOrder?.date_created_gmt || '').trim();
  const email = String(wooOrder?.billing?.email || '').trim();

  const lineItems = Array.isArray(wooOrder?.line_items) ? wooOrder.line_items : [];
  const lines = [];
  lines.push(`PepPro Invoice`);
  lines.push(`Order: #${number}`);
  if (createdAt) lines.push(`Date: ${createdAt}`);
  if (email) lines.push(`Customer: ${email}`);
  lines.push('');
  lines.push('Items:');

  let subtotal = 0;
  for (const item of lineItems) {
    const qty = Number(item?.quantity) || 0;
    const total = Number(item?.total) || 0;
    const name = String(item?.name || 'Item').trim();
    const sku = String(item?.sku || '').trim();
    const unit = qty > 0 ? total / qty : total;
    subtotal += total;
    const skuPart = sku ? ` (SKU: ${sku})` : '';
    lines.push(`${qty} x ${name}${skuPart} @ ${formatMoney(unit, currency)} = ${formatMoney(total, currency)}`);
  }

  const shippingTotal = Number(wooOrder?.shipping_total) || 0;
  const taxTotal = Number(wooOrder?.total_tax) || 0;
  const grandTotal = Number(wooOrder?.total) || roundCurrency(subtotal + shippingTotal + taxTotal);
  lines.push('');
  lines.push(`Subtotal: ${formatMoney(subtotal, currency)}`);
  lines.push(`Shipping: ${formatMoney(shippingTotal, currency)}`);
  lines.push(`Tax: ${formatMoney(taxTotal, currency)}`);
  lines.push(`Total: ${formatMoney(grandTotal, currency)}`);

  const pdf = buildSimpleTextPdf(lines);
  const filename = `PepPro_Invoice_${String(number).replace(/[^\w-]+/g, '') || 'order'}.pdf`;
  return { pdf, filename };
};

module.exports = {
  buildInvoicePdf,
};

