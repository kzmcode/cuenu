#!/usr/bin/env node
// VAPID 鍵ペア（P-256）を生成し、base64url で出力する。
// 使い方: pnpm --filter @cuenu/server vapid:generate
//   出力を .dev.vars に貼るか、`wrangler secret put VAPID_PUBLIC_KEY` 等で登録する。
const b64url = (buf) => Buffer.from(buf).toString('base64url');
const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const pub = await crypto.subtle.exportKey('raw', kp.publicKey);
const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
console.log(`VAPID_PUBLIC_KEY=${b64url(pub)}`);
console.log(`VAPID_PRIVATE_KEY=${jwk.d}`);
console.log('VAPID_SUBJECT=mailto:you@example.com  # 自分の連絡先に変更');
