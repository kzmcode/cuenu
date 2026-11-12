import { describe, expect, test } from 'vitest';
import { buildPushRequest, decryptPayload, encryptPayload, vapidJwt } from '../src/push/webpush';
import { b64urlDecode, b64urlEncode, utf8 } from '../src/util';

// RFC 8291 Appendix A のテストベクタ
const V = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  result:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

async function genUa() {
  const kp = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
  return { pub, priv: b64urlDecode(jwk.d!), auth: crypto.getRandomValues(new Uint8Array(16)) };
}

describe('RFC 8291 aes128gcm', () => {
  test('matches RFC 8291 test vector', async () => {
    const out = await encryptPayload(utf8(V.plaintext), V.uaPublic, V.auth, {
      senderPrivate: b64urlDecode(V.asPrivate),
      senderPublic: b64urlDecode(V.asPublic),
      salt: b64urlDecode(V.salt),
    });
    expect(b64urlEncode(out)).toBe(V.result);
  });

  test('decrypts RFC vector with receiver keys', async () => {
    const pt = await decryptPayload(b64urlDecode(V.result), b64urlDecode(V.uaPrivate), b64urlDecode(V.uaPublic), b64urlDecode(V.auth));
    expect(new TextDecoder().decode(pt)).toBe(V.plaintext);
  });

  test('roundtrip with random keys', async () => {
    const ua = await genUa();
    const msg = JSON.stringify({ title: 'Cuenu', body: '新しいAIの提案があります', memoId: 'x' });
    const ct = await encryptPayload(utf8(msg), b64urlEncode(ua.pub), b64urlEncode(ua.auth));
    expect(new TextDecoder().decode(await decryptPayload(ct, ua.priv, ua.pub, ua.auth))).toBe(msg);
  });
});

describe('VAPID', () => {
  test('JWT is ES256-verifiable with the public key', async () => {
    const kp = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    const pub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
    const d = (await crypto.subtle.exportKey('jwk', kp.privateKey)).d!;
    const keys = { publicKey: b64urlEncode(pub), privateKey: d, subject: 'mailto:owner@example.com' };
    const now = new Date('2026-11-04T00:00:00Z');
    const jwt = await vapidJwt('https://push.example.net', keys, now);
    const [h, c, s] = jwt.split('.');
    const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, kp.publicKey, b64urlDecode(s!), utf8(`${h}.${c}`));
    expect(ok).toBe(true);
    const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(c!)));
    expect(claims).toMatchObject({ aud: 'https://push.example.net', sub: 'mailto:owner@example.com' });
    expect(claims.exp).toBe(Math.floor(now.getTime() / 1000) + 12 * 3600);

    const ua = await genUa();
    const r = await buildPushRequest(
      { endpoint: 'https://push.example.net/abc', p256dh: b64urlEncode(ua.pub), auth: b64urlEncode(ua.auth) },
      { hi: 1 },
      keys,
      now,
    );
    const headers = r.init.headers as Record<string, string>;
    expect(headers['content-encoding']).toBe('aes128gcm');
    expect(headers.authorization).toMatch(/^vapid t=.+, k=/);
    expect(headers.ttl).toBeTruthy();
  });
});
