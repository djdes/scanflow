const DADATA_URL = 'https://suggestions.dadata.ru/suggestions/api/4_1/rs/findById/party';

export class DadataNotConfiguredError extends Error {
  constructor() {
    super('DADATA_API_KEY not configured');
    this.name = 'DadataNotConfiguredError';
  }
}

export interface DadataParty {
  name: string | null;
  inn: string;
  kpp: string | null;
  address: string | null;
}

interface DadataResponse {
  suggestions?: Array<{
    value?: string;
    data?: {
      inn?: string;
      kpp?: string;
      name?: { full?: string; short?: string };
      address?: { value?: string };
    };
  }>;
}

/**
 * Look up a legal entity by INN. The API key is resolved as:
 *   explicit `apiKey` arg (from analyzer_config DB row) → process.env fallback.
 * This lets the key be set from the Settings UI without server access.
 */
export async function lookupPartyByInn(inn: string, apiKey?: string | null): Promise<DadataParty | null> {
  const key = (apiKey && apiKey.trim()) || process.env.DADATA_API_KEY;
  if (!key) throw new DadataNotConfiguredError();
  const res = await fetch(DADATA_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Token ${key}`,
      Accept: 'application/json',
    },
    body: JSON.stringify({ query: inn }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`DaData lookup failed: ${res.status} ${text}`);
  }
  const data = await res.json() as DadataResponse;
  const first = data.suggestions?.[0];
  if (!first) return null;
  return {
    name: first.data?.name?.full ?? first.value ?? null,
    inn: first.data?.inn ?? inn,
    kpp: first.data?.kpp ?? null,
    address: first.data?.address?.value ?? null,
  };
}
