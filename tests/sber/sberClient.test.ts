import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('node:https', () => {
  const request = vi.fn();
  return { default: { request }, request };
});
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    default: { ...actual, readFileSync: vi.fn().mockReturnValue(Buffer.from('PFX-CONTENT')) },
    readFileSync: vi.fn().mockReturnValue(Buffer.from('PFX-CONTENT')),
  };
});

import https from 'node:https';
import { sberFetch, _resetTlsCache } from '../../src/sber/sberClient';

function fakeResponse(status: number, body: string) {
  const res = new EventEmitter() as EventEmitter & { statusCode: number; headers: object };
  res.statusCode = status;
  res.headers = {};
  process.nextTick(() => {
    res.emit('data', Buffer.from(body));
    res.emit('end');
  });
  return res;
}

function makeReq() {
  const req = new EventEmitter() as EventEmitter & {
    write: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
  };
  req.write = vi.fn();
  req.end = vi.fn();
  req.destroy = vi.fn();
  return req;
}

describe('sberFetch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetTlsCache();
    process.env.SBER_TLS_PFX = './certs/test.p12';
    process.env.SBER_TLS_PFX_PASSWORD = 'pwd';
    delete process.env.SBER_CA_CERT;
  });

  it('passes pfx + passphrase to https.request', async () => {
    const req = makeReq();
    (https.request as unknown as ReturnType<typeof vi.fn>).mockImplementation((_opts: object, cb: (r: unknown) => void) => {
      cb(fakeResponse(201, '{"ok":true}'));
      return req;
    });

    const out = await sberFetch('https://fintech.sberbank.ru:9443/fintech/api/v1/payments', {
      method: 'POST',
      headers: { Authorization: 'token' },
      body: '{}',
    });

    expect(out.status).toBe(201);
    expect(out.body).toBe('{"ok":true}');
    const opts = (https.request as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(opts.pfx).toBeInstanceOf(Buffer);
    expect(opts.passphrase).toBe('pwd');
    expect(opts.hostname).toBe('fintech.sberbank.ru');
    expect(opts.port).toBe(9443);
    expect(opts.path).toBe('/fintech/api/v1/payments');
    expect(opts.method).toBe('POST');
  });

  it('writes body when provided', async () => {
    const req = makeReq();
    (https.request as unknown as ReturnType<typeof vi.fn>).mockImplementation((_opts: object, cb: (r: unknown) => void) => {
      cb(fakeResponse(200, ''));
      return req;
    });

    await sberFetch('https://fintech.sberbank.ru:9443/test', { method: 'POST', body: 'hello' });
    expect(req.write).toHaveBeenCalledWith('hello');
    expect(req.end).toHaveBeenCalled();
  });

  it('rejects on request error', async () => {
    const req = makeReq();
    (https.request as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => {
      process.nextTick(() => req.emit('error', new Error('ECONNREFUSED')));
      return req;
    });

    await expect(sberFetch('https://x.test/y')).rejects.toThrow(/ECONNREFUSED/);
  });

  it('rejects on timeout', async () => {
    const req = makeReq();
    (https.request as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => {
      process.nextTick(() => req.emit('timeout'));
      return req;
    });

    await expect(sberFetch('https://x.test/y')).rejects.toThrow(/timed out/i);
    expect(req.destroy).toHaveBeenCalled();
  });

  it('throws when SBER_TLS_PFX not set', async () => {
    delete process.env.SBER_TLS_PFX;
    _resetTlsCache();
    await expect(sberFetch('https://x.test/y')).rejects.toThrow(/SBER_TLS_PFX/);
  });
});
