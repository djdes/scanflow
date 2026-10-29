-- Демо-данные дев-стенда ScanFlow (stand.sh подставляет __ROOT__ — путь к репозиторию).
-- Всё вымышленное: поставщики с ИНН, у которых неверная контрольная цифра (правило 36),
-- позиции 1С и суммы — пример из public/demo/invoices-2026-10-02/sample-invoice.svg.
-- Владелец — admin (id 1): список накладных показывает только свою компанию.

UPDATE analyzer_config SET mode = 'gpt', engine_flags = '{"learning":false}' WHERE id = 1;

INSERT INTO onec_nomenclature_cards (owner_user_id, guid, name, unit) VALUES
  (1, 'a0000000-0000-4000-8000-000000000001', 'Молоко 3,2% 1 л', 'шт'),
  (1, 'a0000000-0000-4000-8000-000000000002', 'Сметана 20% 400 г', 'шт'),
  (1, 'a0000000-0000-4000-8000-000000000003', 'Творог 9% 200 г', 'шт'),
  (1, 'a0000000-0000-4000-8000-000000000004', 'Масло сливочное 82,5% 180 г', 'шт'),
  (1, 'a0000000-0000-4000-8000-000000000005', 'Сыр Российский', 'кг'),
  (1, 'a0000000-0000-4000-8000-000000000006', 'Йогурт натуральный 150 г', 'шт'),
  (1, 'a0000000-0000-4000-8000-000000000007', 'Огурцы грунтовые', 'кг'),
  (1, 'a0000000-0000-4000-8000-000000000008', 'Томаты розовые', 'кг'),
  (1, 'a0000000-0000-4000-8000-000000000009', 'Зелень укроп', 'кг');

INSERT INTO supplier_cards (owner_user_id, inn, name, kpp, account, bank_bic, bank_corr_account, bank_name, verified, source) VALUES
  (1, '5024183907', 'ООО «Молочная ферма» (пример)', '502401001', '40702810000000000001', '044525225', '30101810400000000225', 'ПАО Сбербанк', 1, 'manual'),
  (1, '7708123451', 'ООО «Зелёный ряд» (пример)', '770801001', '40702810000000000003', '044525225', '30101810400000000225', 'ПАО Сбербанк', 1, 'manual');

-- 1. Готова к отправке в 1С: все строки сопоставлены, есть скан.
INSERT INTO invoices (owner_user_id, file_name, file_path, status, invoice_type, invoice_number, invoice_date, supplier, supplier_inn,
  total_sum, vat_sum, ocr_engine, upload_source, created_at, recognized_at)
VALUES (1, 'demo-rn1048.png', '__ROOT__/data/processed/demo-rn1048.png', 'processed', 'торг_12', 'РН-1048', '2026-10-02',
  'ООО «Молочная ферма» (пример)', '5024183907', 28560, 2596.36, 'gpt_api', 'web', NOW() - INTERVAL 2 HOUR, NOW() - INTERVAL 2 HOUR);
SET @i = LAST_INSERT_ID();
INSERT INTO invoice_items (invoice_id, row_no, original_name, mapped_name, onec_guid, mapping_confidence, quantity, unit, price, total, vat_rate,
  raw_quantity, raw_unit, raw_price, raw_total, conv_source, conv_factor) VALUES
  (@i, 1, 'Молоко 3,2% 1 л', 'Молоко 3,2% 1 л', 'a0000000-0000-4000-8000-000000000001', 1, 60, 'шт', 95, 5700, 10, 60, 'шт', 95, 5700, 'same', 1),
  (@i, 2, 'Сметана 20% 400 г', 'Сметана 20% 400 г', 'a0000000-0000-4000-8000-000000000002', 1, 24, 'шт', 110, 2640, 10, 24, 'шт', 110, 2640, 'same', 1),
  (@i, 3, 'Творог 9% 200 г', 'Творог 9% 200 г', 'a0000000-0000-4000-8000-000000000003', 1, 48, 'шт', 75, 3600, 10, 48, 'шт', 75, 3600, 'same', 1),
  (@i, 4, 'Масло сливочное 180 г', 'Масло сливочное 82,5% 180 г', 'a0000000-0000-4000-8000-000000000004', 0.92, 36, 'шт', 145, 5220, 10, 36, 'шт', 145, 5220, 'same', 1),
  (@i, 5, 'Сыр Российский, кг', 'Сыр Российский', 'a0000000-0000-4000-8000-000000000005', 1, 12, 'кг', 650, 7800, 10, 12, 'кг', 650, 7800, 'same', 1),
  (@i, 6, 'Йогурт натуральный 150 г', 'Йогурт натуральный 150 г', 'a0000000-0000-4000-8000-000000000006', 1, 60, 'шт', 60, 3600, 10, 60, 'шт', 60, 3600, 'same', 1);

-- 2. Требует внимания: одна строка без позиции 1С.
INSERT INTO invoices (owner_user_id, file_name, file_path, status, invoice_type, invoice_number, invoice_date, supplier, supplier_inn,
  total_sum, vat_sum, ocr_engine, upload_source, created_at, recognized_at)
VALUES (1, 'demo-zr311.jpg', '__ROOT__/data/processed/demo-zr311.jpg', 'processed', 'упд', 'ЗР-311', '2026-10-27',
  'ООО «Зелёный ряд» (пример)', '7708123451', 9480, 861.82, 'gpt_api', 'telegram', NOW() - INTERVAL 1 DAY, NOW() - INTERVAL 1 DAY);
SET @i = LAST_INSERT_ID();
INSERT INTO invoice_items (invoice_id, row_no, original_name, mapped_name, onec_guid, mapping_confidence, quantity, unit, price, total, vat_rate,
  raw_quantity, raw_unit, raw_price, raw_total, conv_source, conv_factor) VALUES
  (@i, 1, 'Огурцы грунт.', 'Огурцы грунтовые', 'a0000000-0000-4000-8000-000000000007', 0.88, 20, 'кг', 180, 3600, 10, 20, 'кг', 180, 3600, 'same', 1),
  (@i, 2, 'Томаты розовые', 'Томаты розовые', 'a0000000-0000-4000-8000-000000000008', 1, 15, 'кг', 320, 4800, 10, 15, 'кг', 320, 4800, 'same', 1),
  (@i, 3, 'Микрозелень горох', NULL, NULL, NULL, 12, 'шт', 90, 1080, 10, 12, 'шт', 90, 1080, 'same', 1);

-- 3. Уже в 1С.
INSERT INTO invoices (owner_user_id, file_name, file_path, status, invoice_type, invoice_number, invoice_date, supplier, supplier_inn,
  total_sum, vat_sum, ocr_engine, upload_source, created_at, recognized_at, approved_for_1c, approved_at, sent_at, onec_status, onec_updated_at)
VALUES (1, 'demo-rn1031.jpg', '__ROOT__/data/processed/demo-rn1031.jpg', 'sent_to_1c', 'торг_12', 'РН-1031', '2026-09-25',
  'ООО «Молочная ферма» (пример)', '5024183907', 11400, 1036.36, 'gpt_api', 'web', NOW() - INTERVAL 5 DAY, NOW() - INTERVAL 5 DAY,
  1, NOW() - INTERVAL 5 DAY, NOW() - INTERVAL 5 DAY, 'posted', NOW() - INTERVAL 5 DAY);
SET @i = LAST_INSERT_ID();
INSERT INTO invoice_items (invoice_id, row_no, original_name, mapped_name, onec_guid, mapping_confidence, quantity, unit, price, total, vat_rate,
  raw_quantity, raw_unit, raw_price, raw_total, conv_source, conv_factor) VALUES
  (@i, 1, 'Молоко 3,2% 1 л', 'Молоко 3,2% 1 л', 'a0000000-0000-4000-8000-000000000001', 1, 120, 'шт', 95, 11400, 10, 120, 'шт', 95, 11400, 'same', 1);

-- 4. В 1С и оплачена через Сбер.
INSERT INTO invoices (owner_user_id, file_name, file_path, status, invoice_type, invoice_number, invoice_date, supplier, supplier_inn,
  total_sum, vat_sum, ocr_engine, upload_source, created_at, recognized_at, approved_for_1c, approved_at, sent_at, onec_status, onec_updated_at)
VALUES (1, 'demo-rn1040.jpg', '__ROOT__/data/processed/demo-rn1040.jpg', 'sent_to_1c', 'торг_12', 'РН-1040', '2026-09-30',
  'ООО «Молочная ферма» (пример)', '5024183907', 7800, 709.09, 'gpt_api', 'email', NOW() - INTERVAL 3 DAY, NOW() - INTERVAL 3 DAY,
  1, NOW() - INTERVAL 3 DAY, NOW() - INTERVAL 3 DAY, 'posted', NOW() - INTERVAL 3 DAY);
SET @i = LAST_INSERT_ID();
INSERT INTO invoice_items (invoice_id, row_no, original_name, mapped_name, onec_guid, mapping_confidence, quantity, unit, price, total, vat_rate,
  raw_quantity, raw_unit, raw_price, raw_total, conv_source, conv_factor) VALUES
  (@i, 1, 'Сыр Российский, кг', 'Сыр Российский', 'a0000000-0000-4000-8000-000000000005', 1, 12, 'кг', 650, 7800, 10, 12, 'кг', 650, 7800, 'same', 1);
INSERT INTO sber_payments (invoice_id, external_id, status, payment_purpose, amount, payer_account, payee_inn, bank_status, bank_status_at)
VALUES (@i, 'demo-payment-1040', 'created', 'Оплата по накладной № РН-1040 от 30.09.2026', 7800, '40702810000000000002', '5024183907',
  'IMPLEMENTED', NOW() - INTERVAL 2 DAY);
