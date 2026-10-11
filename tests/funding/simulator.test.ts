import { expect, it } from 'vitest';
import { simulationPayloads } from '../../scripts/simulate-fund.js';
it('uses revision-bound contribution tags and explicitly labels simulated purchases', () => {
  const rows = simulationPayloads({ revision: 3, deposits: [{ memberId: 'alex', dollars: 90 }], purchases: [{ merchantId: 'merchant', dollars: 15 }] }, '2026-10-10');
  expect(rows[0].body).toMatchObject({ amount: 90, description: 'member=alex;rev=3' });
  expect(rows[1].body).toMatchObject({ amount: 15, description: 'SIMULATED trip purchase;rev=3' });
});
it('rejects fractional contributions instead of letting the sandbox truncate them', () => {
  expect(() => simulationPayloads({ revision: 3, deposits: [{ memberId: 'alex', dollars: 90.5 }], purchases: [] }, '2026-10-10')).toThrow('whole dollars');
});
