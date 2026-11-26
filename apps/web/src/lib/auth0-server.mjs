import { CompactEncrypt, compactDecrypt, createRemoteJWKSet, jwtVerify, base64url } from "jose";
import { createHash, randomBytes } from "node:crypto";

const enc = new TextEncoder();

export const TX_COOKIE = "fos_tx";
export const SESSION_COOKIE = "fos_session";

const key = () => base64url.decode(process.env.AUTH0_SESSION_SECRET);

export const randomToken = (bytes = 32) => base64url.encode(randomBytes(bytes));

export const pkceChallenge = (v) =>
  base64url.encode(createHash("sha256").update(v).digest());

export async function seal(payload) {
  return new CompactEncrypt(enc.encode(JSON.stringify(payload)))
    .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
    .encrypt(key());
}

export async function unseal(value) {
  const { plaintext } = await compactDecrypt(value, key());
  return JSON.parse(new TextDecoder().decode(plaintext));
}

export const cookieOptions = (minutes, path) => ({
  httpOnly: true,
  sameSite: "lax",
  path,
  maxAge: minutes * 60,
  secure: process.env.NODE_ENV === "production",
});

export async function verifyIdToken(idToken, nonce) {
  const base = process.env.AUTH0_ISSUER_BASE_URL;
  const jwks = createRemoteJWKSet(new URL(base + "/.well-known/jwks.json"));
  const { payload } = await jwtVerify(idToken, jwks, {
    algorithms: ["RS256"],
    issuer: base + "/",
    audience: process.env.AUTH0_CLIENT_ID,
  });
  if (payload.nonce !== nonce) throw new Error("nonce mismatch");
  const amr = Array.isArray(payload.amr) ? payload.amr : [];
  if (!amr.includes("mfa")) throw new Error("MFA not completed");
  return payload;
}