#!/usr/bin/env node
// Genera el par de claves VAPID de los avisos push de Grilla (src/push.ts) y muestra cómo cargarlas.
// Corrélo en tu computadora: las claves no pasan por ningún chat ni se guardan en el repo.
//   node tools/gen_vapid.mjs
import { webcrypto as crypto } from 'node:crypto';

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
const pub = b64url(await crypto.subtle.exportKey('raw', pair.publicKey));
const priv = (await crypto.subtle.exportKey('jwk', pair.privateKey)).d;

console.log(`Clave pública (VAPID_PUBLIC_KEY):\n${pub}\n`);
console.log(`Clave privada (VAPID_PRIVATE_KEY): ${priv}\n`);
console.log('Cargalas en el Worker (desde la carpeta worker/):');
console.log('  npx wrangler secret put VAPID_PRIVATE_KEY     # pegá la clave privada cuando lo pida');
console.log('  npx wrangler secret put VAPID_PUBLIC_KEY      # pegá la clave pública');
console.log('(o en el panel de Cloudflare → Workers → grilla → Settings → Variables and Secrets).');
console.log('La privada es un secreto: no la compartas ni la subas al repo.');
