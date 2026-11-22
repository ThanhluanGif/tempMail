export interface ParsedMimeEmail {
  fromName: string;
  fromAddress: string;
  toAddress: string;
  subject: string;
  receivedAt: string;
  textBody: string;
  htmlBody: string;
  rawSource: string;
}

const utf8Decoder = new TextDecoder('utf-8', { fatal: false });

function decodeBase64ToBytes(input: string): Uint8Array {
  const clean = input.replace(/[^A-Za-z0-9+/=]/g, '');
  if (!clean) return new Uint8Array(0);
  try {
    const binary = atob(clean);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return new Uint8Array(0);
  }
}

function decodeQuotedPrintableToBytes(input: string): Uint8Array {
  const unfolded = input.replace(/=\r?\n/g, '');
  const out: number[] = [];
  for (let i = 0; i < unfolded.length; i++) {
    const ch = unfolded[i];
    if (ch === '=' && i + 2 < unfolded.length) {
      const hex = unfolded.slice(i + 1, i + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        out.push(parseInt(hex, 16));
        i += 2;
        continue;
      }
    }
    out.push(unfolded.charCodeAt(i) & 0xff);
  }
  return new Uint8Array(out);
}

/**
 * Decodes RFC-2047 encoded-words in email headers (e.g. =?UTF-8?B?...?= or =?UTF-8?Q?...?=).
 */
export function decodeMimeHeader(value: string): string {
  if (!value) return '';
  // Remove whitespace between adjacent encoded words per RFC 2047
  const collapsed = value.replace(/\?=\s+=\?/g, '?==?');
  return collapsed.replace(
    /=\?([^?]+)\?([BQ])\?([^?]*)\?=/gi,
    (_full, _charset: string, encoding: string, encodedText: string) => {
      try {
        if (encoding.toUpperCase() === 'B') {
          return utf8Decoder.decode(decodeBase64ToBytes(encodedText));
        }
        const qText = encodedText.replace(/_/g, ' ');
        return utf8Decoder.decode(decodeQuotedPrintableToBytes(qText));
      } catch {
        return encodedText;
      }
    }
  );
}

function parseHeadersBlock(headerBlock: string): Map<string, string> {
  const headers = new Map<string, string>();
  const unfolded = headerBlock.replace(/\r?\n[ \t]+/g, ' ');
  for (const line of unfolded.split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const val = line.slice(idx + 1).trim();
    if (key && !headers.has(key)) {
      headers.set(key, val);
    }
  }
  return headers;
}

function decodeBodyByTransferEncoding(body: string, encoding: string): string {
  const enc = encoding.trim().toLowerCase();
  if (enc === 'base64') {
    return utf8Decoder.decode(decodeBase64ToBytes(body));
  }
  if (enc === 'quoted-printable') {
    return utf8Decoder.decode(decodeQuotedPrintableToBytes(body));
  }
  return body;
}

function extractBoundary(contentType: string): string | null {
  const match = contentType.match(/boundary\s*=\s*(?:"([^"]+)"|([^\s;]+))/i);
  return match ? (match[1] || match[2] || '').trim() : null;
}

function extractMimeParts(
  rawSection: string,
  depth = 0
): { textParts: string[]; htmlParts: string[] } {
  const result = { textParts: [] as string[], htmlParts: [] as string[] };
  if (depth > 4) return result;

  const sepMatch = rawSection.match(/\r?\n\r?\n/);
  if (!sepMatch || sepMatch.index === undefined) {
    result.textParts.push(rawSection.trim());
    return result;
  }

  const headerBlock = rawSection.slice(0, sepMatch.index);
  const bodyBlock = rawSection.slice(sepMatch.index + sepMatch[0].length);
  const headers = parseHeadersBlock(headerBlock);
  const contentType = headers.get('content-type') || 'text/plain; charset=utf-8';
  const transferEncoding = headers.get('content-transfer-encoding') || '7bit';
  const lowerCt = contentType.toLowerCase();

  if (lowerCt.includes('multipart/')) {
    const boundary = extractBoundary(contentType);
    if (boundary) {
      const marker = `--${boundary}`;
      const chunks = bodyBlock.split(marker);
      for (let i = 1; i < chunks.length; i++) {
        const chunk = chunks[i];
        if (!chunk || chunk.startsWith('--')) continue;
        const trimmed = chunk.replace(/^\r?\n/, '').replace(/\r?\n$/, '');
        const sub = extractMimeParts(trimmed, depth + 1);
        result.textParts.push(...sub.textParts);
        result.htmlParts.push(...sub.htmlParts);
      }
      return result;
    }
  }

  const decoded = decodeBodyByTransferEncoding(bodyBlock, transferEncoding).trim();
  if (lowerCt.includes('text/html')) {
    result.htmlParts.push(decoded);
  } else if (lowerCt.includes('text/plain') || !lowerCt.includes('/')) {
    result.textParts.push(decoded);
  }
  return result;
}

function parseAddressHeader(raw: string): { name: string; address: string } {
  const decoded = decodeMimeHeader(raw);
  const match = decoded.match(/^(.*?)\s*<([^>]+)>$/);
  if (match) {
    const cleanName = match[1].replace(/^["'\s]+|["'\s]+$/g, '');
    return { name: cleanName || match[2].split('@')[0], address: match[2].trim() };
  }
  const trimmed = decoded.trim();
  return { name: trimmed.split('@')[0] || 'Người gửi', address: trimmed };
}

/**
 * Parses a raw RFC-822 / MIME email (e.g. from Cloudflare Email Routing)
 * into structured metadata, plain text, and HTML bodies.
 */
export function parseRawMimeEmail(
  rawEmail: string,
  envelopeFrom = '',
  envelopeTo = ''
): ParsedMimeEmail {
  const sepMatch = rawEmail.match(/\r?\n\r?\n/);
  const headerBlock = sepMatch && sepMatch.index !== undefined ? rawEmail.slice(0, sepMatch.index) : '';
  const headers = parseHeadersBlock(headerBlock);

  const fromHeader = headers.get('from') || envelopeFrom || 'unknown@sender';
  const parsedFrom = parseAddressHeader(fromHeader);
  const toHeader = headers.get('to') || envelopeTo || '';
  const parsedTo = parseAddressHeader(toHeader);
  const subject = decodeMimeHeader(headers.get('subject') || '') || '(Không có tiêu đề)';

  const rawDate = headers.get('date');
  const parsedMs = rawDate ? Date.parse(rawDate) : NaN;
  const receivedAt = Number.isNaN(parsedMs)
    ? new Date().toISOString()
    : new Date(parsedMs).toISOString();

  const { textParts, htmlParts } = extractMimeParts(rawEmail);
  const textBody = textParts.join('\n\n').trim();
  const htmlBody = htmlParts.join('\n').trim();

  return {
    fromName: parsedFrom.name,
    fromAddress: parsedFrom.address || envelopeFrom || 'unknown@sender',
    toAddress: (envelopeTo || parsedTo.address).toLowerCase(),
    subject,
    receivedAt,
    textBody,
    htmlBody,
    rawSource: rawEmail.slice(0, 64_000),
  };
}
