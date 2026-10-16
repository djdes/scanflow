import { closeDb } from '../database/db';
import { onecNomenclatureRepo } from '../database/repositories/onecNomenclatureRepo';
import { getOnecUsage, usageSource } from '../integration/onecUsage';

/** Проверка перед перезапуском при выкладке. Только чтение, без отправки уведомлений. */
async function main(): Promise<void> {
  const sources = JSON.parse(process.env.ONEC_USAGE_MCP_CONFIG || '{}') as Record<string, unknown>;
  for (const key of Object.keys(sources)) {
    const owner = Number(key);
    if (!Number.isSafeInteger(owner) || owner <= 0 || !usageSource(owner)) throw new Error('Invalid 1C usage owner/source');
    const catalog = await onecNomenclatureRepo.listItems({ ownerUserId: owner, excludeFolders: true, limit: 1 });
    if (!catalog.length) throw new Error(`1C usage: company ${owner} has no catalog`);
    const snapshot = await getOnecUsage(owner, [catalog[0].guid]);
    if (!snapshot.available) throw new Error(`1C usage: company ${owner} source unavailable`);
    console.log(`1C usage: company ${owner} source OK`);
  }
}

if (require.main === module) {
  void main().catch(e => {
    console.error((e as Error).message);
    process.exitCode = 1;
  }).finally(() => closeDb());
}
