import { describe, expect, it } from 'vitest';
import { membersOf, merchantBody, simulationPayloads } from '../../scripts/simulate-fund.js';

describe('the Nessie sandbox simulator (one account per friend)', () => {
  it('builds one labelled purchase per row, each for the friend who paid', () => {
    const rows = simulationPayloads({ purchases: [{ memberId: 'mason', merchantId: 'hotel-merchant', dollars: 110, note: 'Cabin' }, { memberId: 'alex', merchantId: 'gas-merchant', dollars: 60 }] }, '2026-10-10');
    expect(rows.map((r) => [r.memberId, r.endpoint, r.body.amount, r.body.merchant_id])).toEqual([['mason', 'purchases', 110, 'hotel-merchant'], ['alex', 'purchases', 60, 'gas-merchant']]);
    expect(rows[0]!.body).toMatchObject({ status: 'completed', purchase_date: '2026-10-10', description: 'SIMULATED trip purchase: Cabin' });
    expect(rows[1]!.body.description).toMatch(/^SIMULATED/);
  });
  it('gives every friend named in the purchases an account, or exactly the members listed', () => {
    expect(membersOf({ purchases: [{ memberId: 'mason', category: 'gas', dollars: 5 }, { memberId: 'alex', category: 'gas', dollars: 5 }, { memberId: 'mason', category: 'hotel', dollars: 5 }] })).toEqual(['mason', 'alex']);
    expect(membersOf({ members: ['mason', 'alex', 'jordan', 'mason'], purchases: [] })).toEqual(['mason', 'alex', 'jordan']);
  });
  it('rejects fractional amounts instead of letting the sandbox truncate them', () => {
    expect(() => simulationPayloads({ purchases: [{ memberId: 'alex', merchantId: 'm', dollars: 90.5 }] }, '2026-10-10')).toThrow('whole dollars');
  });
  it('rejects a purchase for someone with no account, and unsafe member ids', () => {
    expect(() => simulationPayloads({ members: ['mason'], purchases: [{ memberId: 'alex', merchantId: 'm', dollars: 5 }] }, '2026-10-10')).toThrow('trip member who has an account');
    expect(() => membersOf({ members: ['../etc'], purchases: [] })).toThrow();
    expect(() => membersOf({ members: [], purchases: [] })).toThrow();
  });
  it('needs a merchant or a category on every purchase', () => {
    expect(() => simulationPayloads({ purchases: [{ memberId: 'mason', dollars: 5 }] }, '2026-10-10')).toThrow('merchant ID or a plain category');
  });
  it('sends the merchant category as a plain string, because the live sandbox rejects a list', () => {
    const body = merchantBody('gas', { street_number: '1', street_name: 'Simulation Way', city: 'Chapel Hill', state: 'NC', zip: '27514' });
    expect(body.category).toBe('gas');
    expect(Array.isArray(body.category)).toBe(false);
    expect(body.name).toBe('SIMULATED gas');
  });
});
