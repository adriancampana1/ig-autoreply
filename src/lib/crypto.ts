import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { quoteLargeIds } from './json.js';

const ALGORITHM = 'aes-256-gcm';

export interface TokenCipher {
  encrypt(plain: string): string;
  decrypt(encoded: string): string;
}

/** AES-256-GCM. Formato armazenado: base64(iv[12] | authTag[16] | ciphertext). */
export function createTokenCipher(base64Key: string): TokenCipher {
  const key = Buffer.from(base64Key, 'base64');
  if (key.length !== 32) throw new Error('ENCRYPTION_KEY precisa ter 32 bytes');
  return {
    encrypt(plain) {
      const iv = randomBytes(12);
      const cipher = createCipheriv(ALGORITHM, key, iv);
      const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
    },
    decrypt(encoded) {
      const data = Buffer.from(encoded, 'base64');
      const decipher = createDecipheriv(ALGORITHM, key, data.subarray(0, 12));
      decipher.setAuthTag(data.subarray(12, 28));
      return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8');
    },
  };
}

function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Valida o cabeçalho X-Hub-Signature-256 (HMAC-SHA256 do corpo bruto) contra qualquer um dos segredos aceitos. */
export function verifyHubSignature(rawBody: Buffer, header: string | undefined, secrets: readonly string[]): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const received = Buffer.from(header.slice('sha256='.length), 'hex');
  if (received.length !== 32) return false;
  return secrets.some((secret) => safeEqual(createHmac('sha256', secret).update(rawBody).digest(), received));
}

export interface SignedRequestPayload {
  user_id: string;
  algorithm: string;
  issued_at?: number;
  [key: string]: unknown;
}

function base64UrlDecode(value: string): Buffer {
  return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/** Decodifica e valida um `signed_request` da Meta (callbacks de desautorização e exclusão de dados). */
export function parseSignedRequest(signedRequest: string, secrets: readonly string[]): SignedRequestPayload | null {
  const [encodedSig, encodedPayload] = signedRequest.split('.', 2);
  if (!encodedSig || !encodedPayload) return null;
  const signature = base64UrlDecode(encodedSig);
  const valid = secrets.some((secret) =>
    safeEqual(createHmac('sha256', secret).update(encodedPayload).digest(), signature),
  );
  if (!valid) return null;
  try {
    const payload = JSON.parse(quoteLargeIds(base64UrlDecode(encodedPayload).toString('utf8'))) as SignedRequestPayload;
    if (payload.algorithm?.toUpperCase() !== 'HMAC-SHA256' || payload.user_id === undefined) return null;
    return { ...payload, user_id: String(payload.user_id) };
  } catch {
    return null;
  }
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}
