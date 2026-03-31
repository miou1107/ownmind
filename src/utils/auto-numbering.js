/**
 * 從現有 code 列表產生下一個 IR-XXX 編號
 * @param {Array<string|null>} existingCodes - 現有的 code 值（可能含 null）
 * @returns {string} 下一個編號，如 'IR-014'
 */
export function generateNextIronRuleCode(existingCodes) {
  const nums = (existingCodes || [])
    .filter(c => c && /^IR-\d+$/.test(c))
    .map(c => parseInt(c.replace('IR-', ''), 10));

  const max = nums.length > 0 ? Math.max(...nums) : 0;
  return `IR-${String(max + 1).padStart(3, '0')}`;
}
