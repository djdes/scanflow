import { convertInvoiceLine } from './lineConversion';
import { invoiceRepo, type InvoiceItem } from '../database/repositories/invoiceRepo';
import { makeSupplierKey } from '../database/repositories/supplierMappingRepo';

/**
 * Пересчитать существующую строку в единицу 1С от её значений «как в
 * накладной» (raw_*) через единую точку convertInvoiceLine. Строки, созданные
 * до v2 (conv_source='legacy_stored'), автоматически НЕ пересчитываются —
 * настоящих исходных значений у них нет, а повторное умножение уже
 * пересчитанного количества и было главной бедой. Возвращает true, если
 * строка изменилась.
 */
export async function reconvertStoredItem(
  item: InvoiceItem,
  invoice: { owner_user_id: number | null; supplier_inn: string | null; supplier: string | null },
  opts: { onecGuid?: string | null; mappedName?: string | null; pack?: { size: number; unit: string } | null; mappingId?: number | null; force?: boolean } = {},
): Promise<boolean> {
  if (item.conv_source === 'legacy_stored' && !opts.force) return false;
  const conv = await convertInvoiceLine({
    ownerUserId: invoice.owner_user_id,
    supplierKey: makeSupplierKey(invoice.supplier_inn, invoice.supplier),
    name: item.original_name,
    raw: {
      quantity: item.raw_quantity ?? item.quantity,
      unit: item.raw_unit ?? item.unit,
      price: item.raw_price ?? item.price,
      total: item.raw_total ?? item.total,
    },
    onecGuid: opts.onecGuid !== undefined ? opts.onecGuid : item.onec_guid,
    mappedName: opts.mappedName ?? item.mapped_name,
    mapping: opts.pack ? { mapping_id: opts.mappingId ?? null, pack_size: opts.pack.size, pack_unit: opts.pack.unit } : null,
  });
  const changed = conv.quantity !== item.quantity || conv.unit !== item.unit || conv.price !== item.price
    || (conv.conversion.qty_flag ?? null) !== (item.qty_flag ?? null);
  if (changed || item.conv_source !== conv.conversion.conv_source) {
    await invoiceRepo.updateItemConversion(item.id, {
      quantity: conv.quantity, unit: conv.unit, price: conv.price,
      conv_factor: conv.conversion.conv_factor, conv_note: conv.conversion.conv_note,
      conv_source: conv.conversion.conv_source, qty_flag: conv.conversion.qty_flag,
      qty_flag_note: conv.conversion.qty_flag_note,
    });
  }
  return changed;
}

