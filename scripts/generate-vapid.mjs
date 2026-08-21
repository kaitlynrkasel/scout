#!/usr/bin/env node
/**
 * Generate a VAPID key pair for Web Push.
 *
 * VAPID is how a push service knows the notification really came from Scout:
 * the server signs each request with the private key, and the browser checked
 * the matching public key when it subscribed. The pair is generated once and
 * then never changes — rotating it invalidates every existing subscription,
 * so every installed app would silently stop receiving notifications until it
 * re-subscribed.
 *
 *   node scripts/generate-vapid.mjs
 *
 * Put the output in the environment (Vercel → Settings → Environment
 * Variables). The private key is a credential: it belongs nowhere near git.
 */

import { generateKeyPairSync, createPublicKey } from "node:crypto";

const b64url = (buf) => buf.toString("base64url");

const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });

// The public key goes over the wire as the raw uncompressed point (0x04 ‖ X ‖ Y,
// 65 bytes). Node hands back DER, whose last 65 bytes are exactly that.
const der = createPublicKey(privateKey).export({ type: "spki", format: "der" });
const publicRaw = der.subarray(der.length - 65);

// The private key is the 32-byte scalar. Node's JWK export gives it directly,
// already base64url encoded.
const jwk = privateKey.export({ format: "jwk" });

if (publicRaw.length !== 65 || publicRaw[0] !== 0x04) {
  console.error("Unexpected public key shape — not an uncompressed P-256 point.");
  process.exit(1);
}
if (Buffer.from(jwk.d, "base64url").length !== 32) {
  console.error("Unexpected private key length — expected a 32-byte scalar.");
  process.exit(1);
}

console.log(`
Add these to your environment. The public one is safe to ship to browsers;
the private one is a credential — server-side only, never committed.

NEXT_PUBLIC_VAPID_PUBLIC_KEY=${b64url(publicRaw)}
VAPID_PRIVATE_KEY=${jwk.d}
VAPID_SUBJECT=mailto:you@yourdomain.com

VAPID_SUBJECT just needs to be a way to reach you if a push service has a
problem with your traffic. A mailto: or an https: URL both work.
`);
