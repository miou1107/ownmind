/**
 * Semver utility — unified version comparison logic
 * Used in many places since v1.17.0 (admin-clients, broadcast-filter, inject-broadcast)
 *
 * Rules:
 *  - Canonical: `X.Y.Z` three numeric segments
 *  - Pre-release: `X.Y.Z-<tag>` (e.g. `1.17.0-beta`, `1.17.0-dev`) is treated as **lower** than the corresponding stable
 *    (follows SemVer 2.0.0: pre-release < release; so a beta client gets flagged as needing an upgrade)
 *  - Build metadata: the part after `+` in `X.Y.Z+<build>` is ignored
 *  - Invalid format (null / 'unknown' / garbage string) -> fallback [0, 0, 0, 0], automatically treated as the oldest
 *
 * Return shape: `[major, minor, patch, preFlag]`
 *  - preFlag = 1 means stable, 0 means prerelease
 *  - compareSemver sorts by numeric diff; stable (1) > prerelease (0), so stable wins
 */

export function parseSemver(v) {
  const raw = String(v ?? '').trim();
  if (!raw) return [0, 0, 0, 0];

  const noBuild = raw.split('+')[0];
  const dashIdx = noBuild.indexOf('-');
  const core = dashIdx === -1 ? noBuild : noBuild.slice(0, dashIdx);
  const preTag = dashIdx === -1 ? '' : noBuild.slice(dashIdx + 1);
  const hasPrerelease = preTag.length > 0;

  const segs = core.split('.').slice(0, 3).map((s) => parseInt(s, 10));
  if (segs.length < 3 || segs.some((n) => Number.isNaN(n))) return [0, 0, 0, 0];

  return [segs[0], segs[1], segs[2], hasPrerelease ? 0 : 1];
}

export function compareSemver(a, b) {
  const [a1, a2, a3, aPre] = parseSemver(a);
  const [b1, b2, b3, bPre] = parseSemver(b);
  if (a1 !== b1) return a1 - b1;
  if (a2 !== b2) return a2 - b2;
  if (a3 !== b3) return a3 - b3;
  return aPre - bPre;
}

export function isLower(a, b) {
  return compareSemver(a, b) < 0;
}

export function isLowerOrEqual(a, b) {
  return compareSemver(a, b) <= 0;
}

export function isHigher(a, b) {
  return compareSemver(a, b) > 0;
}
