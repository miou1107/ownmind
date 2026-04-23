/**
 * Semver 工具 — 統一版本比對邏輯
 * v1.17.0 起被多處使用（admin-clients、broadcast-filter、inject-broadcast）
 *
 * 規則：
 *  - 正規：`X.Y.Z` 三段數字
 *  - Pre-release：`X.Y.Z-<tag>`（如 `1.17.0-beta`、`1.17.0-dev`）視為**低於**對應 stable
 *    （遵守 SemVer 2.0.0：pre-release < release；讓 beta client 被標為需升級）
 *  - Build metadata：`X.Y.Z+<build>` 的 `+` 後段忽略
 *  - 非法格式（null / 'unknown' / 亂字串）→ fallback [0, 0, 0, 0]，自動被視為最舊
 *
 * Return shape：`[major, minor, patch, preFlag]`
 *  - preFlag = 1 代表 stable，0 代表 prerelease
 *  - compareSemver 以 numeric diff 排；stable（1）> prerelease（0），所以 stable 贏
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
