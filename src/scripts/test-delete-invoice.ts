/**
 * Test invoice delete functionality
 * Creates a test invoice with items, deletes it, verifies it's gone.
 * Uses the repo directly, no HTTP required.
 *
 * Usage: npm run test:delete
 */
import '../config';
import { invoiceRepo } from '../database/repositories/invoiceRepo';
import { getDb } from '../database/db';

let passCount = 0;
let failCount = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    console.log(`  ✅ ${message}`);
    passCount++;
  } else {
    console.log(`  ❌ FAIL: ${message}`);
    failCount++;
  }
}

async function main(): Promise<void> {
  console.log('Delete Invoice Tests');
  console.log('====================');

  // Create a test invoice
  console.log('\n=== Setup: create test invoice with items ===');
  const invoice = invoiceRepo.create({
    file_name: 'test-delete.jpg',
    file_path: '/tmp/test-delete.jpg',
  });
  assert(!!invoice.id, `Created invoice with id: ${invoice.id}`);

  // Add a couple of items
  invoiceRepo.addItem({
    invoice_id: invoice.id,
    original_name: 'Test product 1',
    quantity: 5,
    unit: 'шт',
    price: 100,
    total: 500,
  });
  invoiceRepo.addItem({
    invoice_id: invoice.id,
    original_name: 'Test product 2',
    quantity: 2,
    unit: 'кг',
    price: 250,
    total: 500,
  });

  const withItems = invoiceRepo.getWithItems(invoice.id);
  assert(!!withItems, 'Invoice retrievable with items');
  assert(withItems?.items.length === 2, `Has 2 items, got ${withItems?.items.length}`);

  // Delete it
  console.log('\n=== Delete invoice ===');
  invoiceRepo.delete(invoice.id);

  // Verify gone
  const afterDelete = invoiceRepo.getById(invoice.id);
  assert(!afterDelete, `Invoice deleted (getById returns undefined)`);

  const itemsAfterDelete = invoiceRepo.getItems(invoice.id);
  assert(itemsAfterDelete.length === 0, `Items deleted (cascade), got ${itemsAfterDelete.length}`);

  // Verify direct DB check — no orphan rows
  console.log('\n=== Verify no orphan rows in DB ===');
  const db = getDb();
  const invRow = db.prepare('SELECT COUNT(*) as c FROM invoices WHERE id = ?').get(invoice.id) as { c: number };
  assert(invRow.c === 0, `invoices row count = 0, got ${invRow.c}`);

  const itemRows = db.prepare('SELECT COUNT(*) as c FROM invoice_items WHERE invoice_id = ?').get(invoice.id) as { c: number };
  assert(itemRows.c === 0, `invoice_items rows = 0, got ${itemRows.c}`);

  // Delete non-existent — should not throw
  console.log('\n=== Delete non-existent invoice (idempotency) ===');
  try {
    invoiceRepo.delete(999999999);
    assert(true, 'Delete of non-existent invoice does not throw');
  } catch (e: any) {
    assert(false, `Delete threw: ${e.message}`);
  }

  console.log('\n====================');
  console.log(`Results: ${passCount} passed, ${failCount} failed`);

  if (failCount > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
