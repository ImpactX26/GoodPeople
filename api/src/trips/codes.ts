import { createCipheriv, createDecipheriv, createHash, randomBytes, randomInt } from "node:crypto";
import type { DeliveryTrip } from "./types.ts";
// Persistent installs must configure a stable secret; local memory installs can use an ephemeral key.
const key = createHash("sha256").update(process.env.TRIP_CODE_SECRET || randomBytes(32)).digest();
export function checkCodeConfig() {
  if (process.env.DATABASE_URL && !process.env.TRIP_CODE_SECRET) throw new Error("Set TRIP_CODE_SECRET before enabling persistent delivery trips.");
}
export const hashCode = (salt: string, code: string) => createHash("sha256").update(`${salt}:${code}`).digest("hex");
export function newCode(exclude?: string): DeliveryTrip["codes"]["pickup"] {
  let code: string;
  do { code = String(randomInt(1000, 10000)); }
  while (code === exclude || /^(\d)\1{3}$/.test(code) || "01234567890123456789".includes(code) || "98765432109876543210".includes(code));
  const salt = randomBytes(16).toString("hex"), iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(code, "utf8"), cipher.final()]);
  return { seal: Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64"), salt, hash: hashCode(salt, code), tries: 0, lockedUntil: 0 };
}
export function revealCode(seal: string) {
  const b = Buffer.from(seal, "base64"), decipher = createDecipheriv("aes-256-gcm", key, b.subarray(0, 12));
  decipher.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([decipher.update(b.subarray(28)), decipher.final()]).toString("utf8");
}
