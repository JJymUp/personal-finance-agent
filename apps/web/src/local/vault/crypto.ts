/**
 * Web Crypto standard AES-GCM-256 + PBKDF2-SHA256 implementation.
 * Local only, no third-party libraries, no custom crypto.
 */

export interface EncryptedPayload {
  version: '1.0';
  algorithm: 'AES-GCM-256';
  kdf: 'PBKDF2-SHA256';
  iterations: number;
  salt: string; // base64
  iv: string; // base64 (12 bytes)
  ciphertext: string; // base64
}

const ITERATIONS = 100_000;
const SALT_BYTE_LENGTH = 16;
const IV_BYTE_LENGTH = 12;

function arrayBufferToBase64(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToArrayBuffer(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Derives a CryptoKey from a user passphrase using PBKDF2
 */
export async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(passphrase),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt as BufferSource,
      iterations: ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Encrypts arbitrary plaintext with AES-GCM using a user passphrase
 */
export async function encryptData(plaintext: string, passphrase: string): Promise<EncryptedPayload> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTE_LENGTH));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTE_LENGTH));
  const key = await deriveKey(passphrase, salt);

  const enc = new TextEncoder();
  const encryptedBuffer = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: iv as BufferSource,
    },
    key,
    enc.encode(plaintext)
  );

  return {
    version: '1.0',
    algorithm: 'AES-GCM-256',
    kdf: 'PBKDF2-SHA256',
    iterations: ITERATIONS,
    salt: arrayBufferToBase64(salt),
    iv: arrayBufferToBase64(iv),
    ciphertext: arrayBufferToBase64(encryptedBuffer),
  };
}

/**
 * Decrypts an EncryptedPayload using a user passphrase
 * Throws an error if decryption fails (e.g. wrong passphrase or tampering)
 */
export async function decryptData(payload: EncryptedPayload, passphrase: string): Promise<string> {
  if (payload.version !== '1.0' || payload.algorithm !== 'AES-GCM-256') {
    throw new Error('Unsupported encryption payload format or version');
  }

  const salt = base64ToArrayBuffer(payload.salt);
  const iv = base64ToArrayBuffer(payload.iv);
  const ciphertext = base64ToArrayBuffer(payload.ciphertext);

  const key = await deriveKey(passphrase, salt);

  try {
    const decryptedBuffer = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: iv as BufferSource,
      },
      key,
      ciphertext as BufferSource
    );

    const dec = new TextDecoder();
    return dec.decode(decryptedBuffer);
  } catch {
    throw new Error('Decryption failed: invalid passphrase or corrupted data');
  }
}
