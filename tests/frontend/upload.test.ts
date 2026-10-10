import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const script = readFileSync('public/js/upload.js', 'utf8');
let upload: any;
let requests: Array<{ body: FormData; headers: Record<string, string> }>;

beforeEach(() => {
  requests = [];
  class Xhr {
    upload = { addEventListener: vi.fn() };
    listeners: Record<string, () => void> = {};
    headers: Record<string, string> = {};
    status = 202;
    responseText = JSON.stringify({ file_name: 'received.jpg' });
    addEventListener(event: string, listener: () => void) { this.listeners[event] = listener; }
    open() {}
    setRequestHeader(name: string, value: string) { this.headers[name] = value; }
    send(body: FormData) { requests.push({ body, headers: this.headers }); this.listeners.load(); }
  }
  upload = runInNewContext(`${script}\nUpload;`, {
    Blob, FormData, window: {}, XMLHttpRequest: Xhr, URL: { createObjectURL: vi.fn(() => 'blob:preview') },
    App: { notify: vi.fn(), baseUrl: '/api', apiKey: 'test-key' }, console,
  });
  upload.renderHistory = vi.fn();
  upload.updateCounter = vi.fn();
  upload._acquireWakeLock = vi.fn();
  upload._pollForInvoiceId = vi.fn();
  upload.dbDelete = vi.fn(async () => {});
});

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
    expect(upload.history[0].status).toBe('processing');
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
