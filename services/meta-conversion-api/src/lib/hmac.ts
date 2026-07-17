import crypto from 'crypto';

export function verifyHmacSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  appSecret: string,
  allowUnsigned: boolean,
): { valid: boolean; error?: string; parsedBody?: unknown } {
  if (typeof signatureHeader !== 'string' || !signatureHeader.startsWith('sha256=')) {
    if (allowUnsigned) {
      try {
        return { valid: true, parsedBody: JSON.parse(rawBody.toString('utf-8')) };
      } catch {
        return { valid: false, error: 'Webhook payload is not valid JSON' };
      }
    }
    return { valid: false, error: 'Missing or malformed X-Hub-Signature-256 header' };
  }

  const expectedSig = `sha256=${crypto
    .createHmac('sha256', appSecret)
    .update(rawBody)
    .digest('hex')}`;

  const incomingBuf = Buffer.from(signatureHeader);
  const expectedBuf = Buffer.from(expectedSig);

  if (incomingBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(incomingBuf, expectedBuf)) {
    return { valid: false, error: 'Invalid webhook signature' };
  }

  try {
    return { valid: true, parsedBody: JSON.parse(rawBody.toString('utf-8')) };
  } catch {
    return { valid: false, error: 'Webhook payload is not valid JSON' };
  }
}
