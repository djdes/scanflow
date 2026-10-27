import { closeDb } from '../database/db';
import { onecNomenclatureRepo } from '../database/repositories/onecNomenclatureRepo';
import { catalogMcpSource, syncCatalogFromMcp } from '../integration/onecCatalogMcp';
import { configuredUsageOwners, getOnecUsage, usageSource } from '../integration/onecUsage';

/** Проверка и синхронизация каталогов перед перезапуском при выкладке. */
async function main(): Promise<void> {
  const owners = configuredUsageOwners();
  for (const owner of owners) {
    if (!Number.isSafeInteger(owner) || owner <= 0 || !usageSource(owner)) throw new Error('Invalid 1C usage owner/source');
    if (catalogMcpSource(owner)) {
      const synced = await syncCatalogFromMcp(owner, null, 'deploy');
      console.log(`1C catalog MCP: company ${owner} synced (${synced.items} items, ${synced.folders} folders)`);
    }
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
