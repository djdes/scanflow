/**
 * Тест webhook: отправляет тестовые данные на webhook URL
 * Использование: npm run test:webhook
 */
import '../config';
import { config } from '../config';

async function main(): Promise<void> {
  const url = process.argv[2] || config.webhook1cUrl;

  if (!url) {
    console.log('Usage: npm run test:webhook -- <url>');
    console.log('Or set WEBHOOK_1C_URL in .env');
    console.log('\nExample: npm run test:webhook -- http://localhost:8080/hs/invoices');
    process.exit(1);
  }

  const testPayload = {
    invoice_id: 999,
    invoice_number: 'TEST-001',
    invoice_date: '2026-01-30',
    supplier: 'ООО Тестовый поставщик',
    total_sum: 1538.00,
    items: [
      {
        name: 'Молоко 3.2% 1л',
        mapped_name: 'Молоко пастеризованное 3.2% 1л',
        quantity: 10,
        unit: 'шт',
        price: 89.90,
        total: 899.00,
      },
      {
        name: 'Сметана 20% 400г',
        mapped_name: 'Сметана 20% 400г',
        quantity: 5,
        unit: 'шт',
        price: 127.80,
        total: 639.00,
      },
    ],
  };

  console.log(`\n=== Webhook Test ===`);
  console.log(`URL: ${url}`);
  console.log(`\nPayload:`);
  console.log(JSON.stringify(testPayload, null, 2));

  console.log(`\nSending...`);

  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (config.webhook1cToken) {
      headers['Authorization'] = `Bearer ${config.webhook1cToken}`;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(testPayload),
      signal: AbortSignal.timeout(10_000),
    });

    console.log(`\nResponse status: ${response.status} ${response.statusText}`);
    const body = await response.text();
    console.log(`Response body: ${body.substring(0, 500)}`);
    console.log(`\nResult: ${response.ok ? 'SUCCESS' : 'FAILED'}`);
  } catch (err) {
    console.log(`\nError: ${(err as Error).message}`);
    console.log('Make sure the webhook URL is accessible');
  }
}

main().catch(console.error);
