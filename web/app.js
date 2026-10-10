const money = (c) => `$${(c / 100).toFixed(2)}`;
const esc = (v) => String(v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function refresh() {
  try {
    const { householdId } = await fetch('/api/config').then(r => r.json());
    const response = await fetch(`/api/households/${encodeURIComponent(householdId)}/snapshot`);
    if (!response.ok) throw new Error();
    const d = await response.json();
    document.querySelector('#balance').textContent = money(d.balanceCents);
    document.querySelector('#freshness').textContent = `Cycle ${d.cycleId} · Updated ${new Date().toLocaleTimeString()}`;
    document.querySelector('#bills').innerHTML = d.bills.map(b => `<article><b>${esc(b.title)}</b><span>${money(b.amountCents)} · ${esc(b.status)}</span><small>Due ${esc(b.dueDate)}</small></article>`).join('') || '<p>No bills in this cycle.</p>';
    document.querySelector('#contributions').innerHTML = d.contributions.map(c => `<article><b>${esc(c.userId)} · ${money(c.agreedCents)}</b><span>Confirmed ${money(c.confirmedCents)}${c.coveredForUserId ? ` for ${esc(c.coveredForUserId)}` : ''}</span></article>`).join('') || '<p>No contributions yet.</p>';
    document.querySelector('#debts').innerHTML = d.debts.map(x => `<article><b>${esc(x.debtorId)} → ${esc(x.creditorId)}</b><span>${money(x.remainingCents)} remaining</span></article>`).join('') || '<p>No outstanding coverage debt.</p>';
    document.querySelector('#activity').innerHTML = d.activity.slice(0, 8).map(x => `<p>${esc(x.description)} <small>${esc(x.status)} · ${esc(new Date(x.occurredAt).toLocaleString())}</small></p>`).join('') || '<p>No activity yet.</p>';
  } catch { document.querySelector('#freshness').textContent = 'Temporarily unavailable · showing last known data'; }
}
refresh(); setInterval(refresh, 2000);
