import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeEnforcementAlerts } from '../src/utils/enforcement.js';

describe('computeEnforcementAlerts', () => {
  it('violation_rate >= 50% 回傳 critical', () => {
    const complianceData = [
      { rule_title: 'IR-009', rule_code: 'IR-009', action: 'violate', count: 3 },
      { rule_title: 'IR-009', rule_code: 'IR-009', action: 'comply', count: 2 },
    ];
    const result = computeEnforcementAlerts(complianceData, []);
    assert.equal(result.length, 1);
    assert.equal(result[0].severity, 'critical');
    assert.equal(result[0].violation_rate, 60);
    assert.ok(result[0].reinforcement_message.includes('嚴重警告'));
  });

  it('violation_rate >= 25% 回傳 warning', () => {
    const complianceData = [
      { rule_title: 'IR-012', rule_code: 'IR-012', action: 'violate', count: 1 },
      { rule_title: 'IR-012', rule_code: 'IR-012', action: 'comply', count: 3 },
    ];
    const result = computeEnforcementAlerts(complianceData, []);
    assert.equal(result[0].severity, 'warning');
    assert.ok(result[0].reinforcement_message.includes('警告'));
  });

  it('低頻違反回傳 notice', () => {
    const complianceData = [
      { rule_title: 'IR-001', rule_code: 'IR-001', action: 'violate', count: 1 },
      { rule_title: 'IR-001', rule_code: 'IR-001', action: 'comply', count: 10 },
    ];
    const result = computeEnforcementAlerts(complianceData, []);
    assert.equal(result[0].severity, 'notice');
    assert.ok(result[0].reinforcement_message.includes('注意'));
  });

  it('沒有違反記錄回傳空陣列', () => {
    const complianceData = [
      { rule_title: 'IR-001', rule_code: 'IR-001', action: 'comply', count: 5 },
    ];
    const result = computeEnforcementAlerts(complianceData, []);
    assert.equal(result.length, 0);
  });

  it('連續 2 session 違反升級為 critical', () => {
    const complianceData = [
      { rule_title: 'IR-012', rule_code: 'IR-012', action: 'violate', count: 1 },
      { rule_title: 'IR-012', rule_code: 'IR-012', action: 'comply', count: 8 },
    ];
    const lastSessionViolations = ['IR-012'];
    const result = computeEnforcementAlerts(complianceData, lastSessionViolations);
    assert.equal(result[0].severity, 'critical');
  });

  it('依 severity 排序：critical > warning > notice', () => {
    const complianceData = [
      { rule_title: 'A', rule_code: 'A', action: 'violate', count: 1 },
      { rule_title: 'A', rule_code: 'A', action: 'comply', count: 10 },
      { rule_title: 'B', rule_code: 'B', action: 'violate', count: 5 },
      { rule_title: 'B', rule_code: 'B', action: 'comply', count: 5 },
      { rule_title: 'C', rule_code: 'C', action: 'violate', count: 1 },
      { rule_title: 'C', rule_code: 'C', action: 'comply', count: 3 },
    ];
    const result = computeEnforcementAlerts(complianceData, []);
    assert.equal(result[0].severity, 'critical');
    assert.equal(result[1].severity, 'warning');
    assert.equal(result[2].severity, 'notice');
  });
});
