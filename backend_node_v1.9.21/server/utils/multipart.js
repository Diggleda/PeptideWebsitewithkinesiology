const MAX_DEFAULT_BYTES = 25 * 1024 * 1024;

const parseMultipartBoundary = (contentType) => {
  const header = String(contentType || '');
  const match = header.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  return (match?.[1] || match?.[2] || '').trim() || null;
};

const readRequestBuffer = async (req, { maxBytes = MAX_DEFAULT_BYTES } = {}) => {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      const error = new Error('Upload too large');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
};

const parseMultipartSingleFile = async (
  req,
  { fieldName = 'file', maxBytes = MAX_DEFAULT_BYTES } = {},
) => {
  const boundary = parseMultipartBoundary(req.headers['content-type']);
  if (!boundary) {
    const error = new Error('Invalid multipart request');
    error.status = 400;
    throw error;
  }

  const body = await readRequestBuffer(req, { maxBytes });
  const delimiter = Buffer.from(`--${boundary}\r\n`);
  const nextBoundaryPrefix = Buffer.from(`\r\n--${boundary}`);
  const headerSeparator = Buffer.from('\r\n\r\n');

  let cursor = 0;
  while (true) {
    const partStart = body.indexOf(delimiter, cursor);
    if (partStart === -1) break;
    const headerStart = partStart + delimiter.length;
    const headerEnd = body.indexOf(headerSeparator, headerStart);
    if (headerEnd === -1) break;

    const headerText = body.slice(headerStart, headerEnd).toString('utf8');
    const dispositionLine = headerText
      .split('\r\n')
      .find((line) => /^content-disposition:/i.test(line));
    const typeLine = headerText
      .split('\r\n')
      .find((line) => /^content-type:/i.test(line));

    const nameMatch = dispositionLine?.match(/name="([^"]+)"/i);
    const filenameMatch = dispositionLine?.match(/filename="([^"]*)"/i);
    const partName = nameMatch?.[1] || null;
    const filename = filenameMatch?.[1] || null;
    const mimeType = typeLine ? typeLine.split(':').slice(1).join(':').trim() : null;

    const dataStart = headerEnd + headerSeparator.length;
    const dataEnd = body.indexOf(nextBoundaryPrefix, dataStart);
    if (dataEnd === -1) break;

    if (partName === fieldName && filename) {
      return {
        filename,
        mimeType,
        buffer: body.slice(dataStart, dataEnd),
      };
    }

    cursor = dataEnd + nextBoundaryPrefix.length;
  }

  const error = new Error('No file provided');
  error.status = 400;
  throw error;
};

module.exports = {
  parseMultipartSingleFile,
};

