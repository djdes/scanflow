import { sberFetch } from './sberClient';

const CLIENT_INFO_URL = 'https://fintech.sberbank.ru:9443/fintech/api/v2/client-info';

export interface ClientInfo {
  orgName: string | null;
  accountNumber: string | null;
}

export async function fetchClientInfo(accessToken: string): Promise<ClientInfo> {
  const res = await sberFetch(CLIENT_INFO_URL, {
    headers: { Authorization: accessToken, Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`Sber client-info failed: ${res.status} ${res.body}`);
  }
  const data = res.json<{
    orgName?: string;
    organizationName?: string;
    name?: string;
    accounts?: Array<{ number?: string; accountNumber?: string; currency?: string }>;
  }>();
  const orgName = data.orgName ?? data.organizationName ?? data.name ?? null;
  const accounts = data.accounts ?? [];
  let accountNumber: string | null = null;
  if (accounts.length > 0) {
    const rub = accounts.find((a) => a.currency === 'RUB');
    const pick = rub ?? accounts[0];
    accountNumber = pick?.number ?? pick?.accountNumber ?? null;
  }
  return { orgName, accountNumber };
}
