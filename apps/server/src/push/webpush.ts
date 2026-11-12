// Web Push: RFC 8291 (aes128gcm 暗号化) + RFC 8292 (VAPID) を WebCrypto で実装。
import { b64urlDecode, b64urlEncode, concatBytes, utf8 } from '../util';

export interface PushTarget {
  endpoint: string;
  p256dh: string; // base64url, 65 bytes uncompressed P-256
  auth: string; // base64url, 16 bytes
}

export interface VapidKeys {
  publicKey: string; // base64url 65 bytes
  privateKey: string; // base64url 32 bytes (d)
  subject: string; // mailto: or https:
}

const RECORD_SIZE = 4096;

type Bytes = Uint8Array<ArrayBuffer>;
const bytes = (u: Uint8Array): Bytes => new Uint8Array(u) as Bytes;

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Bytes> {
  const k = await crypto.subtle.importKey('raw', bytes(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, bytes(data))) as Bytes;
}

/** HKDF (RFC 5869) で 1 ブロック（≤32 bytes）だけ取り出す */
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, len: number): Promise<Bytes> {
  const prk = await hmac(salt, ikm);
  const t = await hmac(prk, concatBytes(info, new Uint8Array([1])));
  return t.slice(0, len) as Bytes;
}

function publicJwk(raw: Uint8Array): JsonWebKey {
  if (raw.length !== 65 || raw[0] !== 4) throw new Error('invalid P-256 public key');
  return { kty: 'EC', crv: 'P-256', x: b64urlEncode(raw.slice(1, 33)), y: b64urlEncode(raw.slice(33, 65)), ext: true };
}

export async function importEcdhPublic(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', bytes(raw), { name: 'ECDH', namedCurve: 'P-256' }, true, []);
}

export async function importPrivate(d: Uint8Array, pub: Uint8Array, alg: 'ECDH' | 'ECDSA'): Promise<CryptoKey> {
  const jwk: JsonWebKey = { ...publicJwk(pub), d: b64urlEncode(d) };
  return crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: alg, namedCurve: 'P-256' },
    false,
    alg === 'ECDH' ? ['deriveBits'] : ['sign'],
  );
}

export interface EncryptOptions {
  /** テスト用: 送信側鍵と salt を固定 */
  senderPrivate?: Uint8Array;
  senderPublic?: Uint8Array;
  salt?: Uint8Array;
}

/** RFC 8291 aes128gcm。単一レコード（RECORD_SIZE 以内）のみ */
export async function encryptPayload(
  plaintext: Uint8Array,
  uaPublicB64: string,
  authB64: string,
  opts: EncryptOptions = {},
): Promise<Bytes> {
  const uaPublic = b64urlDecode(uaPublicB64);
  const authSecret = b64urlDecode(authB64);
  if (authSecret.length !== 16) throw new Error('invalid auth secret');
  if (plaintext.length + 1 + 16 + 86 > RECORD_SIZE) throw new Error('payload too large');

  let asPrivate: CryptoKey;
  let asPublic: Uint8Array;
  if (opts.senderPrivate && opts.senderPublic) {
    asPublic = opts.senderPublic;
    asPrivate = await importPrivate(opts.senderPrivate, asPublic, 'ECDH');
  } else {
    const kp = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
    asPrivate = kp.privateKey;
    asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  }
  const uaKey = await importEcdhPublic(uaPublic);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asPrivate, 256));

  const keyInfo = concatBytes(utf8('WebPush: info\0'), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);
  const salt = opts.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, utf8('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, utf8('Content-Encoding: nonce\0'), 12);

  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const padded = concatBytes(plaintext, new Uint8Array([2])); // 最終レコード区切り
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, bytes(padded)));

  const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return bytes(concatBytes(header, ct));
}

/** 受信側の復号（テスト・検証用） */
export async function decryptPayload(body: Uint8Array, uaPrivate: Uint8Array, uaPublic: Uint8Array, auth: Uint8Array): Promise<Uint8Array> {
  const salt = body.slice(0, 16);
  const idlen = body[20]!;
  const asPublic = body.slice(21, 21 + idlen);
  const ct = body.slice(21 + idlen);
  const priv = await importPrivate(uaPrivate, uaPublic, 'ECDH');
  const asKey = await importEcdhPublic(asPublic);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey }, priv, 256));
  const ikm = await hkdf(auth, ecdhSecret, concatBytes(utf8('WebPush: info\0'), uaPublic, asPublic), 32);
  const cek = await hkdf(salt, ikm, utf8('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, utf8('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const pt = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, bytes(ct)));
  let end = pt.length - 1;
  while (end >= 0 && pt[end] === 0) end--;
  if (pt[end] !== 2) throw new Error('invalid padding delimiter');
  return pt.slice(0, end);
}

/** RFC 8292 VAPID JWT (ES256) */
export async function vapidJwt(audience: string, keys: VapidKeys, now: Date, ttlSec = 12 * 3600): Promise<string> {
  const header = b64urlEncode(utf8(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64urlEncode(
    utf8(JSON.stringify({ aud: audience, exp: Math.floor(now.getTime() / 1000) + ttlSec, sub: keys.subject })),
  );
  const input = `${header}.${claims}`;
  const priv = await importPrivate(b64urlDecode(keys.privateKey), b64urlDecode(keys.publicKey), 'ECDSA');
  // WebCrypto の ECDSA 署名は IEEE P1363 (r||s) で JWS の形式と一致
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, priv, bytes(utf8(input)));
  return `${input}.${b64urlEncode(sig)}`;
}

export async function buildPushRequest(
  target: PushTarget,
  payload: unknown,
  keys: VapidKeys,
  now: Date,
  ttlSec = 86400,
): Promise<{ url: string; init: RequestInit }> {
  const url = new URL(target.endpoint);
  const jwt = await vapidJwt(url.origin, keys, now);
  const body = await encryptPayload(utf8(JSON.stringify(payload)), target.p256dh, target.auth);
  return {
    url: target.endpoint,
    init: {
      method: 'POST',
      headers: {
        authorization: `vapid t=${jwt}, k=${keys.publicKey}`,
        'content-encoding': 'aes128gcm',
        'content-type': 'application/octet-stream',
        ttl: String(ttlSec),
        urgency: 'normal',
      },
      body,
    },
  };
}
