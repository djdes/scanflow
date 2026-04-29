import { describe, it, expect } from 'vitest';
import { renderRealtime, renderDigest } from '../../src/notifications/templates';
import type { EventPayload } from '../../src/notifications/types';

// Intl.NumberFormat('ru-RU') puts U+00A0 (non-breaking space) between thousand
// groups. Build the expected formatted strings via toLocaleString so the test
// doesn't depend on exotic chars surviving through editor / git diff tooling.
const NBSP = String.fromCharCode(160);

const samplePayload: EventPayload = {
  invoice_id: 1318,
  invoice_number: 'НФНФ-000085',
  supplier: 'ООО "Свит лайф фудсервис"',
  total_sum: 66714.11,
};

describe('renderRealtime', () => {
  it('builds subject and html for photo_uploaded', () => {
    const out = renderRealtime('photo_uploaded', samplePayload);
    expect(out.subject).toBe('Фото загружено');
    expect(out.html).toContain('НФНФ-000085');
    expect(out.html).toContain(`66${NBSP}714,11 ₽`);
    expect(out.html).toContain('Свит лайф фудсервис');
  });

  it('escapes HTML in supplier name', () => {
    const out = renderRealtime('photo_uploaded', { ...samplePayload, supplier: '<script>x</script>' });
    expect(out.html).not.toContain('<script>x</script>');
    expect(out.html).toContain('&lt;script&gt;x&lt;/script&gt;');
  });

  it('shows error_message for recognition_error', () => {
    const out = renderRealtime('recognition_error', { ...samplePayload, error_message: 'Claude API timeout' });
    expect(out.html).toContain('Claude API timeout');
  });

  it('handles missing optional fields gracefully', () => {
    const out = renderRealtime('photo_uploaded', { invoice_id: 5 });
    expect(out.html).toContain('#5'); // falls back to id when no invoice_number
    expect(out.html).toContain('—');  // dash for missing supplier/total
  });
});

describe('renderDigest', () => {
  it('groups events by type and counts them', () => {
    const out = renderDigest([
      {
        event_type: 'photo_uploaded',
        events: [
          { payload: samplePayload, created_at: '2026-04-28 10:00:00' },
          { payload: { ...samplePayload, invoice_id: 2 }, created_at: '2026-04-28 10:05:00' },
        ],
      },
      {
        event_type: 'sent_to_1c',
        events: [{ payload: samplePayload, created_at: '2026-04-28 10:10:00' }],
      },
    ]);
    expect(out.subject).toBe('Дайджест (3 событий)');
    expect(out.html).toContain('Фото загружено (2)');
    expect(out.html).toContain('Отправлена в 1С (1)');
  });

  it('returns empty stub when no events', () => {
    const out = renderDigest([]);
    expect(out.subject).toContain('пусто');
  });
});
