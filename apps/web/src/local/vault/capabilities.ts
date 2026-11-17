/**
 * H-02 Browser Capability Probe
 * Checks Web Crypto (SubtleCrypto AES-GCM / PBKDF2) and IndexedDB availability.
 * Never falls back to plaintext storage when these primitives are unavailable.
 */

export interface VaultCapabilityReport {
  hasWebCrypto: boolean;
  hasIndexedDB: boolean;
  isSupported: boolean;
  missingReasons: string[];
}

export function detectVaultCapabilities(): VaultCapabilityReport {
  const hasWebCrypto =
    typeof globalThis.crypto !== 'undefined' &&
    typeof globalThis.crypto.subtle !== 'undefined' &&
    typeof globalThis.crypto.getRandomValues === 'function';

  const hasIndexedDB =
    typeof (globalThis as { indexedDB?: unknown }).indexedDB !== 'undefined' &&
    (globalThis as { indexedDB?: unknown }).indexedDB !== null;

  const missingReasons: string[] = [];
  if (!hasWebCrypto) {
    missingReasons.push(
      '当前浏览器环境不支持 Web Crypto API（或非 HTTPS/localhost 安全上下文），无法进行本地加密'
    );
  }
  if (!hasIndexedDB) {
    missingReasons.push(
      '当前浏览器环境不支持 IndexedDB（如受限隐私模式），无法安全持久化本地账本'
    );
  }

  return {
    hasWebCrypto,
    hasIndexedDB,
    isSupported: hasWebCrypto && hasIndexedDB,
    missingReasons,
  };
}
