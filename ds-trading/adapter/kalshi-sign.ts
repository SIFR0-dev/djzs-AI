// Kalshi trade-api v2 request signing — RSA-PSS / SHA-256 over
// `${timestampMs}${METHOD}${path}` (path includes /trade-api/v2 prefix,
// excludes query string). WebCrypto only: runs identically in Workers and
// Node >= 20. BYO key: the PEM never leaves the caller's env/secret.

const PEM_HEADER = "-----BEGIN PRIVATE KEY-----";
const PEM_FOOTER = "-----END PRIVATE KEY-----";

function pemToDer(pem: string): ArrayBuffer {
  const body = pem
    .replace(PEM_HEADER, "")
    .replace(PEM_FOOTER, "")
    .replace(/\s+/g, "");
  const bin = atob(body);
  const der = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) der[i] = bin.charCodeAt(i);
  return der.buffer;
}

export async function importKalshiPrivateKey(pkcs8Pem: string): Promise<CryptoKey> {
  if (!pkcs8Pem.includes(PEM_HEADER)) {
    throw new Error(
      "expected an unencrypted PKCS#8 PEM (BEGIN PRIVATE KEY); convert RSA keys via `openssl pkcs8 -topk8 -nocrypt`",
    );
  }
  return crypto.subtle.importKey(
    "pkcs8",
    pemToDer(pkcs8Pem),
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
