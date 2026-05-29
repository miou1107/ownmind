/**
 * Generate the next IR-XXX code from a list of existing codes.
 * @param {Array<string|null>} existingCodes - existing code values (may contain null)
 * @returns {string} the next code, e.g. 'IR-014'
 */
export function generateNextIronRuleCode(existingCodes) {
  const nums = (existingCodes || [])
    .filter(c => c && /^IR-\d+$/.test(c))
    .map(c => parseInt(c.replace('IR-', ''), 10));

  const max = nums.length > 0 ? Math.max(...nums) : 0;
  return `IR-${String(max + 1).padStart(3, '0')}`;
}
