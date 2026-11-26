import { describe, it, expect } from 'vitest';
import { readPfxInfo, pfxValidTo, pickFreshest, daysLeft, TlsCertError, type TlsBundle } from '../../src/sber/tlsCert';
import { FIXTURE_P12_BASE64, FIXTURE_P12_PASSWORD, FIXTURE_P12_VALID_TO, FIXTURE_P12_VALID_FROM } from '../fixtures/sberTlsFixture';

const pfx = Buffer.from(FIXTURE_P12_BASE64, 'base64');

describe('readPfxInfo', () => {
  it('читает срок и CN из .p12', () => {
    const info = readPfxInfo(pfx, FIXTURE_P12_PASSWORD);
    expect(info.validTo.toISOString()).toBe(FIXTURE_P12_VALID_TO.toISOString());
    expect(info.validFrom.toISOString()).toBe(FIXTURE_P12_VALID_FROM.toISOString());
    expect(info.subject).toBe('CI02745214-PROM-test-fixture');
  });

  it('неверный пароль — понятная ошибка', () => {
    expect(() => readPfxInfo(pfx, 'wrong')).toThrow(TlsCertError);
    expect(() => readPfxInfo(pfx, 'wrong')).toThrow(/Неверный пароль/);
  });

  it('не .p12 — понятная ошибка', () => {
    expect(() => readPfxInfo(Buffer.from('not a certificate'), 'x')).toThrow(/не похож на сертификат/);
  });

  it('pfxValidTo не бросает', () => {
    expect(pfxValidTo(pfx, 'wrong')).toBeNull();
    expect(pfxValidTo(pfx, FIXTURE_P12_PASSWORD)?.toISOString()).toBe(FIXTURE_P12_VALID_TO.toISOString());
  });
});

describe('pickFreshest', () => {
  const b = (source: 'file' | 'db', validTo: string | null): TlsBundle =>
    ({ pfx: Buffer.from(source), passphrase: 'p', source, validTo: validTo ? new Date(validTo) : null });

  it('берёт сертификат, действующий дольше', () => {
    expect(pickFreshest([b('file', '2027-05-06'), b('db', '2027-11-01')])?.source).toBe('db');
    expect(pickFreshest([b('file', '2028-01-01'), b('db', '2027-11-01')])?.source).toBe('file');
  });

  it('неизвестный срок проигрывает известному, но один — берётся', () => {
    expect(pickFreshest([b('file', null), b('db', '2027-11-01')])?.source).toBe('db');
    expect(pickFreshest([b('file', null), null])?.source).toBe('file');
  });

  it('нет ни одного — null', () => {
    expect(pickFreshest([null, undefined])).toBeNull();
  });
});

describe('daysLeft', () => {
  it('целые дни до конца, отрицательные после', () => {
    const now = Date.parse('2027-05-01T00:00:00Z');
    expect(daysLeft(new Date('2027-05-06T00:00:00Z'), now)).toBe(5);
    expect(daysLeft(new Date('2027-04-30T00:00:00Z'), now)).toBe(-1);
    expect(daysLeft(null, now)).toBeNull();
  });
});
