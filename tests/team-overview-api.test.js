import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const mod = await import('../src/routes/usage/team-overview.js');
const { extractRuleCounts, aggregateCompliance, pickTopProject } = mod;

describe('extractRuleCounts', () => {
  it('returns zeros for null details', () => {
    assert.deepEqual(extractRuleCounts(null), { complied: 0, skipped: 0, triggered: 0 });
  });
  it('returns zeros for details without rule arrays', () => {
    assert.deepEqual(extractRuleCounts({ project: 'foo' }), { complied: 0, skipped: 0, triggered: 0 });
  });
  it('counts rules_complied and rules_skipped', () => {
    const d = { rules_complied: ['IR-003','IR-008'], rules_skipped: ['IR-009'] };
    assert.deepEqual(extractRuleCounts(d), { complied: 2, skipped: 1, triggered: 3 });
  });
  it('treats non-array rules fields as zero', () => {
    assert.deepEqual(
      extractRuleCounts({ rules_complied: 'IR-003', rules_skipped: null }),
      { complied: 0, skipped: 0, triggered: 0 }
    );
  });
});

describe('aggregateCompliance', () => {
  it('returns rate=null when no session triggers any rule', () => {
    const sessions = [{ details: { project: 'a' } }, { details: null }];
    const r = aggregateCompliance(sessions);
    assert.equal(r.triggered, 0);
    assert.equal(r.rate, null);
  });
  it('aggregates across sessions', () => {
    const sessions = [
      { details: { rules_complied: ['IR-003','IR-008'], rules_skipped: [] } },
      { details: { rules_complied: ['IR-009'], rules_skipped: ['IR-008'] } }
    ];
    const r = aggregateCompliance(sessions);
    assert.equal(r.complied, 3);
    assert.equal(r.triggered, 4);
    assert.equal(r.rate, 0.75);
  });
  it('returns zero complied and rate=null for empty sessions', () => {
    const r = aggregateCompliance([]);
    assert.equal(r.triggered, 0);
    assert.equal(r.rate, null);
    assert.equal(r.complied, 0);
  });
});

describe('pickTopProject', () => {
  it('returns null when no project in any session', () => {
    assert.equal(pickTopProject([{ details: {} }, { details: null }]), null);
  });
  it('picks highest count', () => {
    const ss = [
      { details: { project: 'ownmind' } },
      { details: { project: 'ring' } },
      { details: { project: 'ownmind' } }
    ];
    assert.equal(pickTopProject(ss), 'ownmind');
  });
  it('breaks ties by lexicographic order', () => {
    const ss = [
      { details: { project: 'ring' } },
      { details: { project: 'ownmind' } }
    ];
    assert.equal(pickTopProject(ss), 'ownmind');
  });
  it('returns null for empty sessions array', () => {
    assert.equal(pickTopProject([]), null);
  });
});
