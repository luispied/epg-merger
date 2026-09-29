// Credenciales dentro del link: cifradas con AES-GCM y la clave del Worker (TOKEN_KEY). El
// Worker las descifra solo para armar las URLs al servir y no las guarda en ningún lado. El
// cfgId va como dato asociado: un token copiado a otra configuración no se puede descifrar.

/** Credenciales del proveedor: Xtream (usuario y contraseña) o la URL de una lista M3U. */
export type Credentials = { u: string; p: string } | { url: string };

const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64urlEncode(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(text: string): Uint8Array<ArrayBuffer> {
  const s = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

export function randomId(bytes: number): string {
  return b64urlEncode(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(text)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

const keys = new Map<string, Promise<CryptoKey>>();

function importKey(secret: string): Promise<CryptoKey> {
  let key = keys.get(secret);
  if (!key) {
    const raw = b64urlDecode(secret.trim());
    if (raw.length !== 32) throw new Error('TOKEN_KEY tiene que ser una clave de 32 bytes en base64');
    key = crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
    keys.set(secret, key);
  }
  return key;
}

export async function encryptToken(secret: string, cfgId: string, creds: Credentials): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: enc.encode(cfgId) }, await importKey(secret), enc.encode(JSON.stringify(creds))));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return b64urlEncode(out);
}

/** Las credenciales del token, o null si no es válido para esta configuración. */
export async function decryptToken(secret: string, cfgId: string, token: string): Promise<Credentials | null> {
  try {
    const raw = b64urlDecode(token);
    if (raw.length < 13) return null;
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: raw.slice(0, 12), additionalData: enc.encode(cfgId) }, await importKey(secret), raw.slice(12));
    const creds = JSON.parse(dec.decode(pt));
    if (typeof creds?.url === 'string' || (typeof creds?.u === 'string' && typeof creds?.p === 'string')) return creds;
    return null;
  } catch {
    return null;
  }
}
