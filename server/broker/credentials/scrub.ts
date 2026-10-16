/**
 * Token scrubbing for anything the broker stores or shows from upstream text (status reasons, error
 * messages): exact known secrets, `Bearer …`/`Basic …`, JWTs, secret-looking query parameters and common
 * key prefixes are replaced, control characters dropped, and the result capped. Not a guarantee against
 * every secret format: the exact-string pass is what protects the credentials the broker holds.
 */

const REDACTED = "[redacted]";

export function scrubText(text: string, secrets: readonly (string | null | undefined)[] = [], max = 500): string {
  // oxlint-disable-next-line no-control-regex -- dropping control characters is the point here
  let s = String(text).replace(/[\u0000-\u0008\u000b-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, " ");
  for (const secret of secrets) {
    if (secret && secret.length >= 6) s = s.split(secret).join(REDACTED);
  }
  s = s
    .replace(/\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`)
    .replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, REDACTED)
    .replace(/\b(access_token|refresh_token|id_token|code|client_secret|api_?key|key|token|secret|password|sig|signature)=[^&\s"']+/gi, `$1=${REDACTED}`)
    .replace(/\b(?:sk|pk|rk|ghp|gho|ghs|ghu|ghr|github_pat|xox[abprs]|ntn|secret|glpat)[-_][A-Za-z0-9_-]{12,}/g, REDACTED);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
