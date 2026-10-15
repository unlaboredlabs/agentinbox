import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"; // Crockford base32, lowercase

/** Random base32 string. 20 chars ≈ 100 bits. */
export function randomToken(length = 20): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i]! & 31];
  return out;
}

export type IdPrefix = "acc" | "agt" | "grt" | "evt" | "whk" | "dlv" | "apr" | "par";

export const newId = (prefix: IdPrefix): string => `${prefix}_${randomToken(20)}`;
