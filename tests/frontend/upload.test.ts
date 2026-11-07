import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const script = readFileSync('public/js/upload.js', 'utf8');
let upload: any;
let requests: Array<{ body: FormData; headers: Record<string, string> }>;
let responseStatus: number;
let responseBody: unknown;
let appStub: { notify: ReturnType<typeof vi.fn>; baseUrl: string; apiKey: string };

beforeEach(() => {
  requests = [];
  responseStatus = 202;
  responseBody = { file_name: 'received.jpg', job_id: 11, queued: true };
  class Xhr {
    upload = { addEventListener: vi.fn() };
    listeners: Record<string, () => void> = {};
    headers: Record<string, string> = {};
    status = responseStatus;
    responseText = JSON.stringify(responseBody);
    getResponseHeader() { return '10'; }
    addEventListener(event: string, listener: () => void) { this.listeners[event] = listener; }
    open() {}
    setRequestHeader(name: string, value: string) { this.headers[name] = value; }
    send(body: FormData) { requests.push({ body, headers: this.headers }); this.listeners[this.status === 0 ? 'error' : 'load'](); }
  }
  appStub = { notify: vi.fn(), baseUrl: '/api', apiKey: 'test-key' };
  upload = runInNewContext(`${script}\nUpload;`, {
    Blob, FormData, window: {}, XMLHttpRequest: Xhr, URL: { createObjectURL: vi.fn(() => 'blob:preview') },
    App: appStub, console,
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms), clearTimeout: (id: NodeJS.Timeout) => clearTimeout(id),
  });
  upload.renderHistory = vi.fn();
  upload.updateCounter = vi.fn();
  upload._acquireWakeLock = vi.fn();
  upload._pollForInvoiceId = vi.fn();
  upload.dbDelete = vi.fn(async () => {});
});
afterEach(() => vi.useRealTimers());

describe('Safari file uploads', () => {
  it('copies the full bytes before persisting and scheduling a photo', async () => {
    const original = new File([Uint8Array.from([0, 255, 1, 128])], 'invoice.jpg', { type: 'image/jpeg' });
    const read = vi.spyOn(original, 'arrayBuffer');
    upload.dbPut = vi.fn(async () => 7);
    upload._scheduleUpload = vi.fn();
    await upload.addFile(original);
    expect(read).toHaveBeenCalledOnce();
    const saved = upload.dbPut.mock.calls[0][0] as Blob;
    expect(saved).not.toBe(original);
    expect(saved).not.toBeInstanceOf(File);
    expect(new Uint8Array(await saved.arrayBuffer())).toEqual(Uint8Array.from([0, 255, 1, 128]));
    expect(upload._scheduleUpload).toHaveBeenCalledWith(0, saved);
  });

  it('reads old IndexedDB Files into memory again on retry and sends all bytes with the filename', async () => {
    const restored = new File([Uint8Array.from([255, 216, 0, 255, 217])], 'invoice.jpg', { type: 'image/jpeg' });
    const read = vi.spyOn(restored, 'arrayBuffer');
    upload.history = [{ id: 9, name: restored.name, status: 'uploading' }];
    await upload.doUpload(restored, 0, 9);
    expect(read).toHaveBeenCalledOnce();
    const sent = requests[0].body.get('file') as File;
    expect(sent.name).toBe('invoice.jpg');
    expect(sent.type).toBe('image/jpeg');
    expect(new Uint8Array(await sent.arrayBuffer())).toEqual(Uint8Array.from([255, 216, 0, 255, 217]));
    expect(upload.dbDelete).toHaveBeenCalledWith(9);
    expect(upload.history[0].status).toBe('server_queued');
  });

  it('keeps the locally saved photo when its bytes cannot be read fully', async () => {
    const damaged = { size: 50, type: 'image/jpeg', arrayBuffer: async () => new ArrayBuffer(5) };
    upload.history = [{ id: 9, name: 'invoice.jpg', status: 'uploading' }];
    await upload.doUpload(damaged, 0, 9);
    expect(requests).toHaveLength(0);
    expect(upload.history[0]).toMatchObject({ status: 'error', error: expect.stringContaining('Выберите его заново') });
    expect(upload.dbDelete).not.toHaveBeenCalled();
  });

  it('rejects an empty photo before adding it to the upload queue', async () => {
    upload.dbPut = vi.fn();
    upload._scheduleUpload = vi.fn();
    await upload.addFile(new File([], 'invoice.jpg'));
    expect(upload.history).toHaveLength(0);
    expect(upload.dbPut).not.toHaveBeenCalled();
    expect(upload._scheduleUpload).not.toHaveBeenCalled();
  });
});

describe('durable upload acknowledgement and automatic retry', () => {
  const file = () => new File(['photo-bytes'], 'photo.jpg', { type: 'image/jpeg' });
  async function send(status: number, body: unknown) {
    responseStatus = status; responseBody = body;
    upload.history = [{ id: 7, name: 'photo.jpg', status: 'uploading', _blob: file() }];
    upload._scheduleUpload = vi.fn();
    await upload.doUpload(file(), 0, 7);
  }
  it('only a durable receipt frees the local photo; a legacy asynchronous reply keeps it until confirmation', async () => {
    await send(202, { file_name: 'legacy.jpg' });
    expect(upload.dbDelete).not.toHaveBeenCalled();
    expect(upload._pollForInvoiceId).toHaveBeenCalledWith(0, 'legacy.jpg');
    await send(202, { file_name: 'queued.jpg', job_id: 22, queued: true });
    expect(upload.dbDelete).toHaveBeenCalledWith(7);
    expect(upload.history[0]).toMatchObject({ status: 'server_queued', jobId: 22 });
  });
  it.each([0, 503, 408])('retains the photo and automatically retries an interrupted upload (HTTP %s)', async status => {
    vi.useFakeTimers();
    await send(status, { error: 'temporarily unavailable' });
    expect(upload.history[0]).toMatchObject({ status: 'error', autoRetry: true });
    expect(upload.dbDelete).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    expect(upload._scheduleUpload).toHaveBeenCalledTimes(1);
  });
  it('respects Retry-After without waiting twice, and never auto-retries an invalid file', async () => {
    vi.useFakeTimers();
    await send(429, {});
    await vi.advanceTimersByTimeAsync(9000);
    expect(upload._scheduleUpload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(upload._scheduleUpload).toHaveBeenCalledTimes(1);
    await send(413, { error: 'too big' });
    await vi.advanceTimersByTimeAsync(60000);
    expect(upload._scheduleUpload).not.toHaveBeenCalled();
  });
  it('does not report an unacknowledged 2xx as a successful upload', async () => {
    vi.useFakeTimers();
    await send(202, {});
    expect(upload.history[0]).toMatchObject({ status: 'error', autoRetry: true });
    expect(upload.dbDelete).not.toHaveBeenCalled();
  });
  it('waits for the IndexedDB transaction commit before considering a photo locally saved', async () => {
    const tx: any = { objectStore: () => ({ add: () => ({ result: 42 }) }) };
    upload.db = { transaction: () => tx };
    let committed = false;
    const saving = upload.dbPut(new Blob(['bytes']), 'photo.jpg').then((id: number) => { committed = true; return id; });
    await Promise.resolve(); expect(committed).toBe(false);
    tx.oncomplete();
    expect(await saving).toBe(42);
  });
});

// Фото, снятое под одним входом, не уходит под другим (мобильное приложение, правило 48):
// общий телефон, выход и вход в другую компанию.
describe('photos belong to the login they were taken under', () => {
  const file = () => new File(['photo-bytes'], 'photo.jpg', { type: 'image/jpeg' });

  it('tags a saved photo with the current login, not with the key itself', async () => {
    const add = vi.fn(() => ({ result: 5 }));
    const tx: any = { objectStore: () => ({ add }) };
    upload.db = { transaction: () => tx };
    const saving = upload.dbPut(new Blob(['bytes']), 'photo.jpg');
    tx.oncomplete();
    await saving;
    const record = add.mock.calls[0][0];
    expect(record.owner).toBe(upload.ownerTag('test-key'));
    expect(record.owner).not.toContain('test-key');
    expect(upload.ownerTag('other-key')).not.toBe(record.owner);
  });

  it('does not send a photo of another login and keeps its local copy', async () => {
    upload.history = [{ id: 3, owner: upload.ownerTag('test-key'), name: 'photo.jpg', status: 'uploading' }];
    appStub.apiKey = 'next-company-key';
    await upload.doUpload(file(), 0, 3);
    expect(requests).toHaveLength(0);
    expect(upload.dbDelete).not.toHaveBeenCalled();
    expect(upload.history[0]).toMatchObject({ status: 'error', autoRetry: false, error: expect.stringContaining('другим входом') });
  });

  it('resumes only the photos of the current login after a restart', async () => {
    upload.db = {};
    upload._scheduleUpload = vi.fn();
    upload.dbGetAll = vi.fn(async () => [
      { id: 1, blob: new Blob(['a']), name: 'a.jpg', owner: upload.ownerTag('someone-else') },
      { id: 2, blob: new Blob(['b']), name: 'b.jpg', owner: upload.ownerTag('test-key') },
      { id: 3, blob: new Blob(['c']), name: 'c.jpg' },
    ]);
    await upload.retryPending();
    expect(upload.history.map((h: any) => h.id)).toEqual([2, 3]);
    expect(upload._scheduleUpload).toHaveBeenCalledTimes(2);
  });
});

// Сжатие фото перед отправкой: сервер всё равно уменьшает фото до 2400×3200
// (ocrManager.preprocessImage), поэтому длинная сторона 3200 — без потерь для
// распознавания, с запасом на повёрнутый лист.
describe('photo shrinking before upload', () => {
  it('shrinks only photos the browser can decode', () => {
    expect(upload.shrinkable('image/jpeg', 'IMG_1.JPG')).toBe(true);
    expect(upload.shrinkable('', 'scan.png')).toBe(true);
    expect(upload.shrinkable('image/webp', 'x')).toBe(true);
    expect(upload.shrinkable('application/pdf', 'invoice.pdf')).toBe(false);
    expect(upload.shrinkable('text/xml', 'upd.xml')).toBe(false);
    expect(upload.shrinkable('image/tiff', 'scan.tiff')).toBe(false);
  });

  it('fits the long side into 3200 px, never enlarges, keeps proportions', () => {
    expect(upload.photoPlan({ width: 4032, height: 3024, size: 4e6 })).toEqual({ width: 3200, height: 2400 });
    expect(upload.photoPlan({ width: 3024, height: 4032, size: 4e6 })).toEqual({ width: 2400, height: 3200 });
    expect(upload.photoPlan({ width: 8160, height: 6144, size: 18e6 })).toEqual({ width: 3200, height: 2409 });
  });

  it('leaves a small photo as it is; re-encodes a heavy one without resizing', () => {
    expect(upload.photoPlan({ width: 1600, height: 1200, size: 900_000 })).toBeNull();
    expect(upload.photoPlan({ width: 3000, height: 2000, size: 6e6 })).toEqual({ width: 3000, height: 2000 });
    expect(upload.photoPlan({ width: 0, height: 0, size: 6e6 })).toBeNull();
  });

  it('uses the result only when it is noticeably smaller', () => {
    expect(upload.photoBetter(4_000_000, 1_500_000)).toBe(true);
    expect(upload.photoBetter(1_000_000, 950_000)).toBe(false);
    expect(upload.photoBetter(1_000_000, 0)).toBe(false);
  });

  it('names the result .jpg', () => {
    expect(upload.jpegName('scan.PNG')).toBe('scan.jpg');
    expect(upload.jpegName('IMG_0001.jpeg')).toBe('IMG_0001.jpg');
    expect(upload.jpegName('photo')).toBe('photo.jpg');
  });

  it('sends the original when the photo cannot be shrunk here', async () => {
    const original = new Blob(['x'.repeat(10)], { type: 'image/jpeg' });
    const kept = await upload.shrinkPhoto(original, 'a.jpg');
    expect(kept).toMatchObject({ blob: original, name: 'a.jpg', shrunk: false });
  });

  it('stores and sends the shrunk photo under its new name', async () => {
    const shrunk = new Blob([Uint8Array.from([1, 2, 3])], { type: 'image/jpeg' });
    upload.shrinkPhoto = vi.fn(async () => ({ blob: shrunk, name: 'scan.jpg', shrunk: true }));
    upload.dbPut = vi.fn(async () => 8);
    upload._scheduleUpload = vi.fn();
    await upload.addFile(new File([Uint8Array.from([9, 9, 9, 9])], 'scan.png', { type: 'image/png' }));
    expect(upload.dbPut).toHaveBeenCalledWith(shrunk, 'scan.jpg');
    expect(upload.history[0].name).toBe('scan.jpg');
    expect(upload._scheduleUpload).toHaveBeenCalledWith(0, shrunk);
  });
});
