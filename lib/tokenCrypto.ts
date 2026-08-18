// Application-layer encryption for OAuth refresh tokens at rest. The database
// already sits behind RLS + the service role, but a leaked service key would
// otherwise hand over send-access to every connected mailbox. Sealing tokens
// with a key that lives ONLY in the deploy env (TOKEN_ENC_KEY) means a DB/key
// leak alone yields ciphertext.
//
// Design constraints honored here:
// - openToken() passes legacy plaintext rows through untouched, so existing
//   connections keep working; they seal on their next reconnect.
// - sealToken() no-ops when TOKEN_ENC_KEY is unset (local dev without the key
//   still works, just unencrypted).
// - AES-256-GCM, random IV per seal, format "enc1:<iv>:<tag>:<ciphertext>"
//   (base64url), versioned for future rotation.

import crypto from "crypto";

const PREFIX = "enc1:";

function key(): Buffer | null {
  const raw = process.env.TOKEN_ENC_KEY || "";
  if (!raw) return null;
  // Accept a base64/base64url or hex 32-byte key; hash anything else down to
  // 32 bytes so a passphrase also works.
  try {
    const b = Buffer.from(raw, "base64");
    if (b.length === 32) return b;
  } catch {}
  try {
    const h = Buffer.from(raw, "hex");
    if (h.length === 32) return h;
  } catch {}
  return crypto.createHash("sha256").update(raw).digest();
}

export function sealToken(plain: string): string {
  const k = key();
  if (!k || !plain || plain.startsWith(PREFIX)) return plain;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", k, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return (
    PREFIX +
    iv.toString("base64url") +
    ":" +
    tag.toString("base64url") +
    ":" +
    ct.toString("base64url")
  );
}

export function openToken(stored: string): string {
  const s = String(stored || "");
  if (!s.startsWith(PREFIX)) return s; // legacy plaintext row
  const k = key();
  if (!k) throw new Error("TOKEN_ENC_KEY is not set but the stored token is encrypted");
  const [iv, tag, ct] = s.slice(PREFIX.length).split(":");
  const decipher = crypto.createDecipheriv("aes-256-gcm", k, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ct, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
