/* Parent accounts: scrypt-hashed passwords and an HMAC-signed session cookie.
 *
 * Deliberately dependency-free — node:crypto does both jobs — and deliberately
 * server-side only: the browser holds one opaque cookie, the game socket is
 * refused without it, and nothing about the child rides in the token but the
 * parent's account id.
 */
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const SECRET = process.env.SESSION_SECRET ?? "soyle-dev-secret-not-for-prod";
const SESSION_DAYS = 30;

export function hashPassword(pw: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(pw, salt, 32).toString("hex");
  return `${salt}:${hash}`;
}

export function checkPassword(pw: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const got = scryptSync(pw, salt, 32);
  const want = Buffer.from(hash, "hex");
  return got.length === want.length && timingSafeEqual(got, want);
}

function sign(payload: string): string {
  return createHmac("sha256", SECRET).update(payload).digest("base64url");
}

/** email -> opaque cookie value: base64url(email)|expiry|hmac. */
export function makeSession(email: string): string {
  const exp = Date.now() + SESSION_DAYS * 86400_000;
  const body = `${Buffer.from(email).toString("base64url")}|${exp}`;
  return `${body}|${sign(body)}`;
}

/** cookie value -> email, or null if forged or expired. */
export function readSession(token: string | undefined): string | null {
  if (!token) return null;
  const parts = token.split("|");
  if (parts.length !== 3) return null;
  const [email64, exp, mac] = parts as [string, string, string];
  const body = `${email64}|${exp}`;
  const want = sign(body);
  if (mac.length !== want.length
      || !timingSafeEqual(Buffer.from(mac), Buffer.from(want))) return null;
  if (Date.now() > Number(exp)) return null;
  try { return Buffer.from(email64, "base64url").toString(); } catch { return null; }
}

export function sessionCookie(token: string): string {
  return `sid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`;
}

export function clearCookie(): string {
  return "sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0";
}

export function cookieValue(header: string | undefined, name: string): string | undefined {
  return header?.split(";").map((c) => c.trim())
    .find((c) => c.startsWith(name + "="))?.slice(name.length + 1);
}
