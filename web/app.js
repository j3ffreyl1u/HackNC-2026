const money = (cents) => `$${(cents / 100).toFixed(2)}`;
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

async function refresh() {
  try {
    const { householdId } = await fetch('/api/config').then((response) => response.json());
    const response = await fetch(`/api/households/${encodeURIComponent(householdId)}/snapshot`);
    if (!response.ok) throw new Error('Snapshot unavailable');
    const data = await response.json();
    const billNames = new Map(data.bills.map((bill) => [bill.billId, bill.title]));
    document.querySelector('#balance').textContent = money(data.balanceCents);
    document.querySelector('#freshness').textContent = `Cycle ${escapeHtml(data.cycleId)} | Updated ${new Date().toLocaleTimeString()}`;
    document.querySelector('#bills').innerHTML = data.bills.map((bill) => `<article><b>${escapeHtml(bill.title)}</b><span>${money(bill.amountCents)} | ${escapeHtml(bill.status)}</span><small>Due ${escapeHtml(bill.dueDate)}</small></article>`).join('') || '<p>No bills in this cycle.</p>';
    document.querySelector('#contributions').innerHTML = data.contributions.map((item) => `<article><small>${escapeHtml(billNames.get(item.billId) || item.billId)}</small><b>${escapeHtml(item.userId)} | Agreed ${money(item.agreedCents)}</b><span>Confirmed ${money(item.confirmedCents)}${item.coveredForUserId ? ` for ${escapeHtml(item.coveredForUserId)}` : ''}</span></article>`).join('') || '<p>No contributions yet.</p>';
    document.querySelector('#debts').innerHTML = data.debts.map((debt) => `<article><b>${escapeHtml(debt.debtorId)} owes ${escapeHtml(debt.creditorId)}</b><span>${money(debt.remainingCents)} remaining</span></article>`).join('') || '<p>No outstanding coverage debt.</p>';
    document.querySelector('#activity').innerHTML = data.activity.slice(0, 8).map((item) => `<p>${escapeHtml(item.description)} <small>${escapeHtml(item.status)} | ${escapeHtml(new Date(item.occurredAt).toLocaleString())}</small></p>`).join('') || '<p>No activity yet.</p>';
  } catch {
    document.querySelector('#freshness').textContent = 'Temporarily unavailable; showing last known data';
  }
}

refresh();
setInterval(refresh, 2000);
