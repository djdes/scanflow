export interface PurposeContext {
  invoice_number: string | null;
  invoice_date: string | null; // ISO YYYY-MM-DD
  total_sum: number | null;
  vat_sum: number | null;
  vat_rate: number | null;
  supplier: string | null;
}

const MAX_PURPOSE = 210;

function formatVatClause(ctx: PurposeContext): string {
  if (ctx.vat_sum === null || ctx.vat_sum <= 0) return 'Без НДС';
  const rate = ctx.vat_rate ?? 20;
  const amt = ctx.vat_sum.toFixed(2);
  return `в т.ч. НДС ${rate}% — ${amt} руб.`;
}

function formatDateDot(iso: string | null): string {
  if (!iso) return 'б/д';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${m[3]}.${m[2]}.${m[1]}`;
}

export function renderPurpose(template: string, ctx: PurposeContext): string {
  const subs: Record<string, string> = {
    invoice_number: ctx.invoice_number ?? 'б/н',
    invoice_date_dot: formatDateDot(ctx.invoice_date),
    invoice_date_iso: ctx.invoice_date ?? 'б/д',
    total: ctx.total_sum?.toFixed(2) ?? '0.00',
    vat_amount: ctx.vat_sum?.toFixed(2) ?? '0.00',
    vat_rate: ctx.vat_rate?.toString() ?? '0',
    supplier: ctx.supplier ?? '',
    vat_clause: formatVatClause(ctx),
  };
  let out = template.replace(/\{(\w+)\}/g, (_m, key) =>
    Object.prototype.hasOwnProperty.call(subs, key) ? subs[key] : `{${key}}`,
  );
  out = sanitizePurpose(out);
  if (out.length > MAX_PURPOSE) {
    out = out.slice(0, MAX_PURPOSE - 3) + '...';
  }
  return out;
}

export function sanitizePurpose(s: string): string {
  return s
    .replace(/[«»“”„]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/ /g, ' ')
    .replace(/[—–]/g, '-');
}
