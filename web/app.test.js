import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

// Run the real page script with a small DOM boundary double. This checks text and
// asynchronous rendering, not browser layout, CSS, canvas or accessibility.
class Element {
  children = [];
  attributes = {};
  hidden = false;
  textContent = '';
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener() {}
  get childElementCount() { return this.children.length; }
}
const text = (node) => [node.textContent, ...node.children.map(text)].join(' ');
const snapshot = { tripId: 'chapel-hill-weekend', revision: 12, status: 'approved', participants: [], candidates: [], acceptances: [], fundingStatus: 'tracking' };
const ledger = () => ({
  status: 'tracking', mode: 'mock', revision: 12, expectedEachDollars: 160, sharedSpentDollars: 200,
  members: [
    { memberId: 'mason', name: 'Mason', coveredDollars: 110, fairShareDollars: 67, netDollars: 43, byCategory: [{ category: 'accommodation', dollars: 110 }] },
    { memberId: 'alex', name: 'Alex', coveredDollars: 60, fairShareDollars: 67, netDollars: -7, byCategory: [{ category: 'fuel_parking_tolls', dollars: 60 }] },
    { memberId: 'jordan', name: 'Jordan', coveredDollars: 30, fairShareDollars: 66, netDollars: -36, byCategory: [{ category: 'activities', dollars: 30 }] },
  ],
  transfers: [{ from: 'Jordan', to: 'Mason', dollars: 36 }, { from: 'Alex', to: 'Mason', dollars: 7 }],
  spending: { byCategory: [], overCategories: [], unclassifiedDollars: 0, totalSpentDollars: 200, contingencyDollars: 30 },
  unclassifiedDollars: 0, unattributedDollars: 0,
});
async function page(initialFund = ledger(), fetchPage) {
  const elements = new Map();
  const query = (selector) => {
    if (!elements.has(selector)) elements.set(selector, new Element());
    return elements.get(selector);
  };
  let fund = initialFund;
  let snapshotFailed = false;
  let fundStatus = 200;
  let pendingFund;
  const context = createContext({
    URL, URLSearchParams, Intl,
    document: { querySelector: query, createElement: () => new Element(), body: { dataset: {} } },
    window: { location: { search: '' }, setInterval() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) },
    localStorage: { getItem: () => null },
    fetch: async (url) => {
      if (fetchPage) return fetchPage(url);
      if (url.endsWith('/snapshot')) {
        if (snapshotFailed) throw new Error('Offline');
        return { ok: true, json: async () => snapshot };
      }
      if (pendingFund) return pendingFund;
      return { ok: fundStatus === 200, status: fundStatus, json: async () => fund };
    },
  });
  const source = readFileSync(new URL('./app.js', import.meta.url), 'utf8')
    .replace("import './reef.js';", '')
    .replace('refresh();\nwindow.setInterval', 'globalThis.initialRefresh = refresh();\nwindow.setInterval');
  runInContext(source, context);
  await context.initialRefresh;
  return {
    fund: query('#fund'),
    refresh: () => runInContext('refresh()', context),
    refreshFund: () => runInContext('refreshFund(12)', context),
    setFund(value) { fund = value; },
    failSnapshot() { snapshotFailed = true; },
    failFund(status) { fundStatus = status; },
    deferFund(promise) { pendingFund = promise; },
  };
}

describe('Who covered what page', () => {
  it('renders the API nets with their correct direction and labels the simulation', async () => {
    const p = await page();
    expect(text(p.fund)).toMatch(/Mason.*is owed \$43/);
    expect(text(p.fund)).toMatch(/Alex.*owes \$7/);
    expect(text(p.fund)).toMatch(/Jordan.*owes \$36/);
    expect(text(p.fund)).toMatch(/simulat/i);
    expect(text(p.fund)).toMatch(/never moves money/i);
  });
  it('clears stale bank amounts when the snapshot cannot be refreshed', async () => {
    const p = await page();
    p.failSnapshot();
    await p.refresh();
    expect(text(p.fund)).toMatch(/tracking is unavailable/i);
    expect(text(p.fund)).not.toMatch(/\$|Mason|Alex|Jordan/);
    expect(text(p.fund)).toMatch(/simulat/i);
  });
  it('clears amounts on a 503 bank failure and keeps the simulation label', async () => {
    const p = await page();
    p.failFund(503);
    await p.refresh();
    expect(text(p.fund)).toMatch(/tracking is unavailable/i);
    expect(text(p.fund)).not.toContain('$');
    expect(text(p.fund)).toMatch(/simulat/i);
  });
  it('clears amounts when a 409 says the plan changed during the request', async () => {
    const p = await page();
    p.failFund(409);
    await p.refresh();
    expect(text(p.fund)).not.toContain('$');
    expect(text(p.fund)).toMatch(/plan changed/i);
  });
  it('does not leave amounts from the old revision on a mismatched fund response', async () => {
    const p = await page();
    p.setFund({ ...ledger(), revision: 13 });
    await p.refresh();
    expect(text(p.fund)).not.toContain('$');
    expect(text(p.fund)).toMatch(/plan changed/i);
  });
  it('hides the entire panel when tracking is disabled', async () => {
    const p = await page();
    p.setFund({ status: 'disabled', revision: 12 });
    await p.refresh();
    expect(p.fund.hidden).toBe(true);
    expect(text(p.fund).trim()).toBe('');
  });
  it('preserves the panel nodes when an unchanged ledger is polled again', async () => {
    const p = await page();
    const heading = p.fund.children[0];
    await p.refresh();
    expect(p.fund.children[0]).toBe(heading);
  });
  it('shows an empty ledger without suggesting anyone owes an unpaid contribution', async () => {
    const p = await page();
    const empty = ledger();
    empty.sharedSpentDollars = 0;
    empty.transfers = [];
    empty.members = empty.members.map(m => ({ ...m, coveredDollars: 0, fairShareDollars: 0, netDollars: 0, byCategory: [] }));
    p.setFund(empty);
    await p.refresh();
    expect(text(p.fund)).toMatch(/Nothing shared yet/i);
    expect(text(p.fund)).toMatch(/Nobody owes anything yet/i);
  });
  it('renders a not-ready reason without stale amounts', async () => {
    const p = await page();
    p.setFund({ status: 'not_ready', reason: 'Approve a plan first.', mode: 'mock', revision: 12 });
    await p.refresh();
    expect(text(p.fund)).toContain('Approve a plan first.');
    expect(text(p.fund)).not.toContain('$');
  });
  it('does not let an older response erase a newer error state', async () => {
    const p = await page();
    let finish;
    p.deferFund(new Promise(resolve => { finish = resolve; }));
    const inFlight = p.refreshFund();
    p.failSnapshot();
    await p.refresh();
    finish({ ok: true, json: async () => ledger() });
    await inFlight;
    expect(text(p.fund)).toMatch(/tracking is unavailable/i);
    expect(text(p.fund)).not.toContain('$');
  });
});
