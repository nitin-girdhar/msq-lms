import crypto from 'node:crypto';
import { config } from '../config/index.js';

// AES-256-GCM authenticated encryption for secrets at rest (Meta app_secret and
// long-lived page access_token). Ciphertext is stored as:
//   enc:v1:<iv_b64>:<authTag_b64>:<ciphertext_b64>
//
// Decryption auto-detects the prefix, so pre-existing plaintext rows keep
// working during rollout — they are returned as-is and re-encrypted on next
// write. When no key is configured, values are stored in plaintext (the key is
// required in production; see config).

const ENC_PREFIX = 'enc:v1:';

function getKey(): Buffer | null {
  const raw = config.encryptionKey;
  if (!raw) return null;
  // Accept a 64-char hex or 44-char base64 (32-byte) key.
  const key = raw.length === 64 ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error('META_ENCRYPTION_KEY must decode to 32 bytes (64 hex chars or base64)');
  }
  return key;
}

export function encryptSecret(plaintext: string): string {
  const key = getKey();
  if (!key) return plaintext; // no key configured — store as-is
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENC_PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

export function decryptSecret(value: string | null | undefined): string {
  if (!value) return '';
  if (!value.startsWith(ENC_PREFIX)) return value; // legacy plaintext
  const key = getKey();
  if (!key) {
    throw new Error('Encrypted secret present but META_ENCRYPTION_KEY is not configured');
  }
  const [ivB64, tagB64, ctB64] = value.slice(ENC_PREFIX.length).split(':');
  if (!ivB64 || !tagB64 || !ctB64) throw new Error('Malformed encrypted secret');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf-8');
}
