import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resetDb, closeTestDb } from '../helpers/db';
import { getDb } from '../../src/database/db';
import { invoiceRepo } from '../../src/database/repositories/invoiceRepo';

// The name 1C creates Номенклатура from is mapped_name (else original_name).
// A user-set name must persist into mapped_name, clear any catalog match, and be
// flagged (name_overridden) so the UI can confirm what will be sent to 1C.
describe.runIf((process.env.DB_NAME || '').includes('test'))('setItemCustomName', () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await closeTestDb(); });

  async function mkItem(onecGuid: string | null): Promise<number> {
    const inv = Number((await getDb().prepare(
      `INSERT INTO invoices (file_name, file_path, status) VALUES ('f','/f','processed')`
    ).run()).lastInsertRowid);
    const r = await getDb().prepare(
      `INSERT INTO invoice_items (invoice_id, original_name, mapped_name, onec_guid, total, vat_rate)
       VALUES (?, 'Скан кривое имя', ?, ?, 100, 20)`
    ).run(inv, onecGuid ? 'Catalog Name' : null, onecGuid);
    return Number(r.lastInsertRowid);
  }

  it('persists the custom name, clears the match, and flags the override', async () => {
    const itemId = await mkItem('old-guid-123');
    const out = await invoiceRepo.setItemCustomName(itemId, '  Салфетки GRATIAS Эконом 24x24  ');
    expect(out?.mapped_name).toBe('  Салфетки GRATIAS Эконом 24x24  '); // repo stores verbatim (route trims)
    expect(out?.onec_guid).toBeNull();
    expect(out?.name_overridden).toBe(1);
  });

  it('a later catalog mapping supersedes the override flag', async () => {
    const itemId = await mkItem(null);
    await invoiceRepo.setItemCustomName(itemId, 'Моё название');
    expect((await invoiceRepo.getItemById(itemId))?.name_overridden).toBe(1);

    await invoiceRepo.mapItem(itemId, 'new-guid-456', 'Каталожное имя');
    const after = await invoiceRepo.getItemById(itemId);
    expect(after?.onec_guid).toBe('new-guid-456');
    expect(after?.name_overridden).toBe(0);
  });
});
