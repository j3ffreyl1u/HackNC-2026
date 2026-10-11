/**
 * Writes simulated purchases to a friend's own Capital One Nessie SANDBOX account (fake money) when they text
 * "I just paid $60 for gas". The ledger then reads the accounts back. Nothing here touches a real bank.
 */
export interface NessieWriter {
  createAccount(label: string): Promise<string>;
  createMerchant(category: string): Promise<string>;
  postPurchase(accountId: string, merchantId: string, dollars: number, description: string, date: string): Promise<string>;
}

const ADDRESS = { street_number: '1', street_name: 'Simulation Way', city: 'Chapel Hill', state: 'NC', zip: '27514' };

/** Writes only to the sandbox, and only what the demo scripts (customers, accounts, merchants, purchases). */
export function createNessieWriter(config: { baseUrl: string; apiKey: string }, fetcher: typeof fetch = fetch): NessieWriter {
  const base = new URL(config.baseUrl);
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) throw new Error('Nessie requires a clean HTTPS base URL.');
  const post = async (path: string, body: unknown): Promise<string> => {
    const url = new URL(`${base.pathname.replace(/\/$/, '')}/${path}`, base.origin);
    url.searchParams.set('key', config.apiKey);
    let json: { _id?: string; objectCreated?: { _id?: string } };
    try {
      const response = await fetcher(url, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error();
      json = await response.json() as typeof json;
    } catch { throw new Error('The Nessie sandbox did not accept the demo request.'); }
    const id = json.objectCreated?._id ?? json._id;
    if (!id) throw new Error('The Nessie sandbox returned no ID.');
    return id;
  };
  return {
    async createAccount(label) {
      const customer = await post('customers', { first_name: 'SIMULATED', last_name: label, address: ADDRESS });
      return post(`customers/${encodeURIComponent(customer)}/accounts`, { type: 'Checking', nickname: `SIMULATED ${label}`, rewards: 0, balance: 0 });
    },
    createMerchant: (category) => post('merchants', { name: `SIMULATED ${category}`, category, address: ADDRESS, geocode: { lat: 35.9132, lng: -79.0558 } }),
    postPurchase(accountId, merchantId, dollars, description, date) {
      return post(`accounts/${encodeURIComponent(accountId)}/purchases`, { merchant_id: merchantId, medium: 'balance', status: 'completed', purchase_date: date, amount: dollars, description });
    },
  };
}
