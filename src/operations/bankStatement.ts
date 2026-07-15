import crypto from 'crypto';

export interface ParsedBankEntry {
  operationDate: string;
  amount: number;
  direction: 'debit' | 'credit';
  counterparty: string | null;
  counterpartyInn: string | null;
  account: string | null;
  purpose: string | null;
  externalId: string | null;
  operationHash: string;
}

function decode(buffer: Buffer): string {
  const utf8 = buffer.toString('utf8');
  if (!utf8.includes('\uFFFD')) return utf8.replace(/^\uFEFF/, '');
  return new TextDecoder('windows-1251').decode(buffer).replace(/^\uFEFF/, '');
}

function delimiterFor(line: string): string {
  const candidates = [';', '\t', ','];
  return candidates.sort((a, b) => line.split(b).length - line.split(a).length)[0];
}

function parseLine(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (quoted && line[i + 1] === '"') { current += '"'; i++; }
      else quoted = !quoted;
    } else if (char === delimiter && !quoted) {
      cells.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current.trim());
  return cells;
}

function normaliseHeader(value: string): string {
  return value.toLocaleLowerCase('ru-RU').replace(/[ё]/g, 'е').replace(/[^a-zа-я0-9]+/g, ' ').trim();
}

function column(headers: string[], aliases: string[]): number {
  const normalized = aliases.map(normaliseHeader);
  return headers.findIndex(header => normalized.includes(header));
}

function parseAmount(raw: string | undefined): number | null {
  if (!raw) return null;
  const value = Number(raw.replace(/\s/g, '').replace(',', '.').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(value) && value !== 0 ? Math.abs(value) : null;
}

function parseSignedAmount(raw: string | undefined): number | null {
  if (!raw) return null;
  const value = Number(raw.replace(/\s/g, '').replace(',', '.').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(value) && value !== 0 ? value : null;
}

function parseDate(raw: string | undefined): string | null {
  if (!raw) return null;
  const value = raw.trim().split(/[ T]/)[0];
  let match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) return `${match[1]}-${match[2]}-${match[3]}`;
  match = value.match(/^(\d{2})[./-](\d{2})[./-](\d{4})$/);
  if (match) return `${match[3]}-${match[2]}-${match[1]}`;
  return null;
}

function textOrNull(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, 4000) : null;
}

export function parseBankStatement(buffer: Buffer): ParsedBankEntry[] {
  const lines = decode(buffer).split(/\r?\n/).filter(line => line.trim());
  if (lines.length < 2) throw new Error('В выписке нет строк операций');
  const delimiter = delimiterFor(lines[0]);
  const headers = parseLine(lines[0], delimiter).map(normaliseHeader);
  const indexes = {
    date: column(headers, ['дата', 'дата операции', 'operation date', 'date']),
    amount: column(headers, ['сумма', 'amount', 'сумма операции']),
    debit: column(headers, ['дебет', 'расход', 'списание', 'debit']),
    credit: column(headers, ['кредит', 'приход', 'зачисление', 'credit']),
    direction: column(headers, ['направление', 'тип операции', 'direction']),
    counterparty: column(headers, ['контрагент', 'получатель', 'плательщик', 'counterparty']),
    inn: column(headers, ['инн контрагента', 'инн получателя', 'инн плательщика', 'инн', 'counterparty inn']),
    account: column(headers, ['счет контрагента', 'расчетный счет', 'счёт', 'account']),
    purpose: column(headers, ['назначение платежа', 'назначение', 'purpose', 'описание']),
    externalId: column(headers, ['номер документа', 'идентификатор операции', 'номер операции', 'document number', 'id']),
  };
  if (indexes.date < 0 || (indexes.amount < 0 && indexes.debit < 0 && indexes.credit < 0)) {
    throw new Error('Не найдены обязательные колонки «Дата» и «Сумма/Дебет/Кредит»');
  }

  const result: ParsedBankEntry[] = [];
  for (const line of lines.slice(1)) {
    const cells = parseLine(line, delimiter);
    const operationDate = parseDate(cells[indexes.date]);
    const debit = indexes.debit >= 0 ? parseAmount(cells[indexes.debit]) : null;
    const credit = indexes.credit >= 0 ? parseAmount(cells[indexes.credit]) : null;
    const genericSigned = indexes.amount >= 0 ? parseSignedAmount(cells[indexes.amount]) : null;
    const generic = genericSigned == null ? null : Math.abs(genericSigned);
    const directionText = indexes.direction >= 0 ? normaliseHeader(cells[indexes.direction] || '') : '';
    const direction: 'debit' | 'credit' = debit != null || (genericSigned != null && genericSigned < 0) || /расход|спис|debit/.test(directionText) ? 'debit' : 'credit';
    const amount = debit ?? credit ?? generic;
    if (!operationDate || amount == null) continue;
    const counterparty = indexes.counterparty >= 0 ? textOrNull(cells[indexes.counterparty]) : null;
    const counterpartyInnRaw = indexes.inn >= 0 ? (cells[indexes.inn] || '').replace(/\D/g, '') : '';
    const counterpartyInn = /^\d{10}(\d{2})?$/.test(counterpartyInnRaw) ? counterpartyInnRaw : null;
    const account = indexes.account >= 0 ? textOrNull(cells[indexes.account]) : null;
    const purpose = indexes.purpose >= 0 ? textOrNull(cells[indexes.purpose]) : null;
    const externalId = indexes.externalId >= 0 ? textOrNull(cells[indexes.externalId]) : null;
    const fingerprint = [operationDate, amount.toFixed(2), direction, counterpartyInn, counterparty, purpose, externalId]
      .map(value => String(value || '').toLocaleLowerCase('ru-RU').trim()).join('|');
    result.push({
      operationDate, amount, direction, counterparty, counterpartyInn, account,
      purpose, externalId, operationHash: crypto.createHash('sha256').update(fingerprint).digest('hex'),
    });
  }
  if (result.length === 0) throw new Error('Не удалось прочитать ни одной операции');
  return result;
}

export function safeCsvCell(value: unknown): string {
  const raw = String(value ?? '');
  const escaped = /^[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return `"${escaped.replace(/"/g, '""')}"`;
}
