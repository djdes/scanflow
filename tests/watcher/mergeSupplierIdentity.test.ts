import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resetDb, closeTestDb } from '../helpers/db';
import { getDb } from '../../src/database/db';
import { invoiceRepo } from '../../src/database/repositories/invoiceRepo';
import { FileWatcher } from '../../src/watcher/fileWatcher';
import { NomenclatureMapper } from '../../src/mapping/nomenclatureMapper';

describe.runIf((process.env.DB_NAME || '').includes('test'))('page merge uses the stored supplier identity', () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await closeTestDb(); });

  it.each([false, true])('merges initials into a full supplier name (verified directory: %s)', async (directory) => {
    const db = getDb();
    await db.prepare("UPDATE analyzer_config SET mode='claude_api', llm_mapper_enabled=0 WHERE id=1").run();
    const owner = Number((await db.prepare(`INSERT INTO users (username,password_hash,api_key,role,notify_events)
      VALUES ('merge-test','x','merge-test-key','user','[]')`).run()).lastInsertRowid);
    const inn = '123456789012';
    const fullName = 'ИП Иванов Иван Иванович';
    if (directory) await db.prepare(`INSERT INTO supplier_cards (owner_user_id,inn,name,bank_bic,verified)
      VALUES (?,?,?,'044525225',1)`).run(owner, inn, fullName);
    const head = Number((await db.prepare(`INSERT INTO invoices
      (file_name,file_path,status,invoice_number,supplier,supplier_inn,owner_user_id,total_sum,raw_text)
      VALUES ('merge-head.jpg','/x','processed','TEST-510',?,?,?,400,'{"items":[]}')`)
      .run(fullName, inn, owner)).lastInsertRowid);
    for (let row = 1; row <= 4; row++) await db.prepare(`INSERT INTO invoice_items
      (invoice_id,original_name,quantity,unit,price,total,row_no) VALUES (?,'Тестовый товар',1,'шт',100,100,?)`)
      .run(head, row);
    const tail = {
      invoice_number: 'TEST-510', invoice_date: null, supplier: 'ИП Иванов И. И.', supplier_inn: inn,
      total_sum: 450, vat_sum: null, invoice_type: 'упд',
      items: [{ name: 'Тестовый товар на второй странице', quantity: 1, unit: 'шт', price: 50, total: 50, row_no: 5, vat_rate: null }],
    };
    const ocr = {
      recognizeWithClaudeApi: async () => ({ text: JSON.stringify(tail), engine: 'claude_api', structured: tail }),
      analyzeMultiPageText: async () => { throw new Error('Use the lossless append fallback'); },
    };
    const watcher = new FileWatcher(ocr as never, new NomenclatureMapper());
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scanflow-merge-test-'));
    const photo = path.join(dir, 'tail.jpg');
    fs.writeFileSync(photo, `synthetic-page-${directory}`);
    try {
      const result = await watcher.processFile(photo, `merge-tail-${directory}.jpg`, undefined, { ownerUserId: owner });
      expect(result).toBe(head);
      const merged = await invoiceRepo.getWithItems(head);
      expect(merged?.items.map(i => i.row_no).sort((a, b) => Number(a) - Number(b))).toEqual([1, 2, 3, 4, 5]);
      expect(merged?.total_sum).toBe(450);
      expect(merged?.file_name).toContain(`merge-tail-${directory}.jpg`);
      expect(merged?.supplier).toBe(fullName);
      expect(Number((await db.prepare('SELECT COUNT(*) AS c FROM invoices').get<{ c: number }>())?.c)).toBe(1);
    } finally {
      if (fs.existsSync(photo)) fs.unlinkSync(photo);
      fs.rmdirSync(dir);
    }
  });
});
