export const RECEIPT_MAX_BYTES = 3 * 1024 * 1024;
export const RECEIPT_MAX_COUNT = 5;
export const RECEIPT_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'] as const;
export type ReceiptMime = typeof RECEIPT_TYPES[number];

export class ReceiptValidationError extends Error {}

export function inspectReceipt(bytes: Uint8Array, declaredType: string): ReceiptMime {
  if (!bytes.length || bytes.length > RECEIPT_MAX_BYTES) throw new ReceiptValidationError('Choose a file between 1 byte and 3 MB.');
  let detected: ReceiptMime | undefined;
  const ascii = (offset: number, text: string) => text.split('').every((character, index) => bytes[offset + index] === character.charCodeAt(0));
  if (bytes.length >= 12 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) detected = 'image/jpeg';
  else if (bytes.length >= 24 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value) && ascii(12, 'IHDR')) detected = 'image/png';
  else if (bytes.length >= 20 && ascii(0, 'RIFF') && ascii(8, 'WEBP') && (ascii(12, 'VP8 ') || ascii(12, 'VP8L') || ascii(12, 'VP8X'))) detected = 'image/webp';
  else if (bytes.length >= 8 && ascii(0, '%PDF-')) detected = 'application/pdf';
  if (!detected) throw new ReceiptValidationError('Choose a JPG, PNG, WebP image or PDF receipt.');
  const declared = declaredType.toLowerCase().split(';')[0].trim().replace('image/jpg', 'image/jpeg');
  if (declared && declared !== 'application/octet-stream' && declared !== detected) throw new ReceiptValidationError('The file contents do not match its file type. Choose the original receipt file.');
  return detected;
}

export function receiptFileName(input: string, mime: ReceiptMime): string {
  const extension = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' }[mime];
  const base = input.normalize('NFC').replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069/\\"<>:|?*]/g, '_')
    .replace(/^\.+/, '').replace(/\.[^.]*$/, '').trim().slice(0, 120) || 'receipt';
  return `${base}.${extension}`;
}

export function receiptContentDisposition(name: string, attachment = false): string {
  const fallback = name.replace(/[^A-Za-z0-9._ -]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(name).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${attachment ? 'attachment' : 'inline'}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
