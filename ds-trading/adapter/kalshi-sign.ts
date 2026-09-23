// Kalshi trade-api v2 request signing — RSA-PSS / SHA-256 over
// `${timestampMs}${METHOD}${path}` (path includes /trade-api/v2 prefix,
// excludes query string). WebCrypto only: runs identically in Workers and
// Node >= 20. BYO key: the PEM never leaves the caller's env/secret.

function pemBodyToDer(pem: string, header: string, footer: string): Uint8Array {
  const body = pem.replace(header, "").replace(footer, "").replace(/\s+/g, "");
  const bin = atob(body);
  const der = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) der[i] = bin.charCodeAt(i);
  return der;
}

/** DER definite-length encoding for a given content length. */
function derLen(n: number): number[] {
  if (n < 0x80) return [n];
  const bytes: number[] = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return [0x80 | bytes.length, ...bytes];
}

/**
 * Wrap a PKCS#1 RSAPrivateKey DER in a PKCS#8 PrivateKeyInfo:
 * SEQUENCE { INTEGER 0, SEQUENCE { OID rsaEncryption, NULL }, OCTET STRING pkcs1 }.
 * Kalshi's console hands out PKCS#1 (BEGIN RSA PRIVATE KEY); WebCrypto only
 * imports PKCS#8, so the wrap happens here rather than via openssl on the
 * Operator's terminal.
 */
export function wrapPkcs1InPkcs8(pkcs1: Uint8Array): Uint8Array {
  const version = [0x02, 0x01, 0x00];
  const algorithm = [
    0x30, 0x0d, // SEQUENCE(13)
    0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, // OID 1.2.840.113549.1.1.1
    0x05, 0x00, // NULL
  ];
  const octet = [0x04, ...derLen(pkcs1.length)];
  const contentLen = version.length + algorithm.length + octet.length + pkcs1.length;
  const out = new Uint8Array(2 + derLen(contentLen).length - 1 + 1 + contentLen);
  let i = 0;
  out[i++] = 0x30;
  for (const b of derLen(contentLen)) out[i++] = b;
  for (const b of version) out[i++] = b;
  for (const b of algorithm) out[i++] = b;
  for (const b of octet) out[i++] = b;
  out.set(pkcs1, i);
  return out;
}

/** Accepts unencrypted PKCS#8 (BEGIN PRIVATE KEY) or PKCS#1 (BEGIN RSA PRIVATE KEY). */
export async function importKalshiPrivateKey(pem: string): Promise<CryptoKey> {
  let der: Uint8Array;
  if (pem.includes("-----BEGIN PRIVATE KEY-----")) {
    der = pemBodyToDer(pem, "-----BEGIN PRIVATE KEY-----", "-----END PRIVATE KEY-----");
  } else if (pem.includes("-----BEGIN RSA PRIVATE KEY-----")) {
    der = wrapPkcs1InPkcs8(
      pemBodyToDer(pem, "-----BEGIN RSA PRIVATE KEY-----", "-----END RSA PRIVATE KEY-----"),
    );
  } else {
    throw new Error(
      "expected an RSA private key PEM (BEGIN PRIVATE KEY or BEGIN RSA PRIVATE KEY); encrypted keys are not supported",
    );
  }
  return crypto.subtle.importKey(
    "pkcs8",
    der.buffer as ArrayBuffer,
    { name: "RSA-PSS", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

export interface KalshiAuthHeaders {
  "KALSHI-ACCESS-KEY": string;
  "KALSHI-ACCESS-SIGNATURE": string;
  "KALSHI-ACCESS-TIMESTAMP": string;
}

export async function signKalshiRequest(
  key: CryptoKey,
  accessKeyId: string,
  method: string,
  path: string,
  timestampMs: number = Date.now(),
): Promise<KalshiAuthHeaders> {
  const message = `${timestampMs}${method.toUpperCase()}${path}`;
  const sig = await crypto.subtle.sign(
    { name: "RSA-PSS", saltLength: 32 }, // salt = digest length (SHA-256)
    key,
    new TextEncoder().encode(message),
  );
  let bin = "";
  for (const b of new Uint8Array(sig)) bin += String.fromCharCode(b);
  return {
    "KALSHI-ACCESS-KEY": accessKeyId,
    "KALSHI-ACCESS-SIGNATURE": btoa(bin),
    "KALSHI-ACCESS-TIMESTAMP": String(timestampMs),
  };
}
