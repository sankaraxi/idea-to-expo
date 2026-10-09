// Pure Node (no framework imports) so scripts/*.mjs can reuse it.
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";

type ScryptOptions = { N: number; r: number; p: number; maxmem: number };
const scrypt = (password: string, salt: Buffer, keylen: number, options: ScryptOptions) =>
  new Promise<Buffer>((resolve, reject) =>
    scryptCallback(password, salt, keylen, options, (error, key) => (error ? reject(error) : resolve(key))),
  );

// scrypt, N=2^15 r=8 p=1 (~32 MB, tens of ms). Parameters are stored with each
// hash, so they can be raised later without invalidating existing passwords.
const DEFAULTS = { N: 2 ** 15, r: 8, p: 1 };
const KEY_LENGTH = 64;
const MAXMEM = 128 * 1024 * 1024;

export const MIN_PASSWORD_LENGTH = 8;

/** Format: scrypt$N$r$p$<salt b64>$<hash b64> */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, KEY_LENGTH, { ...DEFAULTS, maxmem: MAXMEM });
  return ["scrypt", DEFAULTS.N, DEFAULTS.r, DEFAULTS.p, salt.toString("base64"), hash.toString("base64")].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, saltB64, hashB64] = stored.split("$");
  if (scheme !== "scrypt" || !saltB64 || !hashB64) return false;
  const params = { N: Number(n), r: Number(r), p: Number(p) };
  if (!Number.isInteger(params.N) || params.N < 2 ** 10 || params.N > 2 ** 20 || !params.r || !params.p) return false;
  const expected = Buffer.from(hashB64, "base64");
  const actual = await scrypt(password, Buffer.from(saltB64, "base64"), expected.length, { ...params, maxmem: MAXMEM });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

let dummy: Promise<string> | null = null;
/** Burns the same time as a real check, so unknown emails are not distinguishable by timing. */
export async function verifyDummyPassword(password: string): Promise<void> {
  dummy ??= hashPassword("not-a-real-password");
  await verifyPassword(password, await dummy);
}
