export interface OcrWord {
  text: string;
  x: number;    // left
  y: number;    // top
  width: number;
  height: number;
  confidence?: number;
}

export interface OcrResult {
  text: string;
  engine: string;
  confidence?: number;
  structured?: ParsedInvoiceData;
  words?: OcrWord[];  // Слова с координатами (для position-aware parsing)
}

export interface ParsedInvoiceData {
  invoice_number?: string;
  invoice_date?: string;
  invoice_type?: 'счет_на_оплату' | 'торг_12' | 'упд' | 'счет_фактура';
  supplier?: string;
  supplier_inn?: string;
  supplier_bik?: string;
  supplier_account?: string;
  supplier_corr_account?: string;
  supplier_address?: string;
  total_sum?: number;
  vat_sum?: number;
  items: ParsedInvoiceItem[];
}

export interface ParsedInvoiceItem {
  name: string;
  quantity?: number;
  unit?: string;
  price?: number;
  total?: number;
  vat_rate?: number;
  // "№ п/п" / "No" — sequential 1-based position in the items table on THIS
  // page. Used by the watcher to detect that a new invoice starting with
  // row_no=10 is a continuation of a previous one that ended at row_no=9.
  row_no?: number;
  // Index (1-based) into the CatalogEntry array passed to the Claude prompt
  // when LLM-mapper mode is on. Watcher resolves it to onec_guid before
  // saving the item. null when Claude didn't find a confident match.
  catalog_idx?: number | null;
}

export interface OcrEngine {
  name: string;
  recognize(imagePath: string): Promise<OcrResult>;
}
