import { supplierRepo } from '../database/repositories/supplierRepo';
import type { Invoice } from '../database/repositories/invoiceRepo';

/**
 * При выгрузке накладной в 1С (или показе в UI) подменяет supplier-поля
 * на выверенные данные из таблицы `suppliers`, если для ИНН есть запись
 * с `verified = 1`.
 *
 * OCR из накладной попадает в `invoices.supplier_*` как есть — со всеми
 * caps lock'ами, опечатками, пропавшими КПП и т.п. Когда юзер один раз
 * подтвердил карточку поставщика в `suppliers`, мы хотим, чтобы все
 * последующие выгрузки и Сбер-платёжки использовали этот выверенный
 * вариант, а не сырой OCR.
 *
 * Логика: если у накладной есть `supplier_inn` И в `suppliers` есть
 * запись с этим ИНН и `verified=1`, заменяем все supplier-поля на её
 * значения. Поля где у `suppliers` null — оставляем то что было в накладной
 * (например, у нас может быть address из OCR, а в suppliers ещё не введён).
 *
 * Возвращает НОВЫЙ объект — не мутирует входной.
 */
export async function enrichInvoiceWithSupplier<T extends Pick<Invoice,
  'supplier' | 'supplier_inn' | 'supplier_kpp' | 'supplier_bik' |
  'supplier_account' | 'supplier_corr_account' | 'supplier_address' | 'owner_user_id'
>>(invoice: T): Promise<T> {
  if (!invoice.supplier_inn) return invoice;
  // Справочник пер-тенантный: подтягиваем карточку только владельца накладной.
  // Накладная без владельца (файл положили прямо в inbox/) справочником не
  // обогащается — претендента на неё нет, а брать чужую карточку нельзя.
  if (invoice.owner_user_id == null) return invoice;
  const supplier = await supplierRepo.findByInn(invoice.supplier_inn, invoice.owner_user_id);
  if (!supplier || !supplier.verified) return invoice;

  return {
    ...invoice,
    supplier: supplier.name,
    supplier_kpp: supplier.kpp ?? invoice.supplier_kpp,
    supplier_bik: supplier.bank_bic ?? invoice.supplier_bik,
    supplier_account: supplier.account ?? invoice.supplier_account,
    supplier_corr_account: supplier.bank_corr_account ?? invoice.supplier_corr_account,
    supplier_address: supplier.address ?? invoice.supplier_address,
  };
}
