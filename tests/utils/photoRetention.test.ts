import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Каталог processed/ — временный, список эталонов — из замоканного репозитория.
const cfg = vi.hoisted(() => ({ processedDir: '' }));
const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));

vi.mock('../../src/config', () => ({ config: cfg }));
vi.mock('../../src/utils/logger', () => ({ logger: log }));
vi.mock('../../src/database/db', () => ({
  getDb: () => { throw new Error('очистка фото ходит в БД только через goldenRepo'); },
}));
vi.mock('../../src/database/repositories/goldenRepo', () => ({
  goldenRepo: { listGoldenFileNames: vi.fn() },
}));
vi.mock('../../src/database/repositories/photoRepo', () => ({
  photoRepo: { listNotYetExpiredFileNames: vi.fn() },
}));

import { goldenRepo } from '../../src/database/repositories/goldenRepo';
import { photoRepo } from '../../src/database/repositories/photoRepo';
import { cleanupOldPhotos } from '../../src/utils/photoRetention';

const listGolden = vi.mocked(goldenRepo.listGoldenFileNames);
const listUnsent = vi.mocked(photoRepo.listNotYetExpiredFileNames);
const DAY = 24 * 60 * 60 * 1000;

function put(name: string, ageDays: number): void {
  const p = path.join(cfg.processedDir, name);
  fs.writeFileSync(p, 'jpeg-bytes');
  const t = new Date(Date.now() - ageDays * DAY);
  fs.utimesSync(p, t, t);
}

const exists = (name: string) => fs.existsSync(path.join(cfg.processedDir, name));

beforeEach(() => {
  vi.clearAllMocks();
  listUnsent.mockResolvedValue([]);
  cfg.processedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'retention-'));
  put('old-golden.jpg', 120);
  put('old-page2-golden.jpg', 120);
  put('old-plain.jpg', 120);
  put('fresh.jpg', 5);
  put('.gitkeep', 400);
});

afterEach(() => {
  fs.rmSync(cfg.processedDir, { recursive: true, force: true });
});

describe('cleanupOldPhotos', () => {
  it('старые фото удаляются, фото эталонов (все страницы) остаются', async () => {
    listGolden.mockResolvedValue(['old-golden.jpg', 'old-page2-golden.jpg']);
    const r = await cleanupOldPhotos();
    expect(r.deleted).toBe(1);
    expect(r.keptGolden).toBe(2);
    expect(exists('old-plain.jpg')).toBe(false);
    expect(exists('old-golden.jpg')).toBe(true);
    expect(exists('old-page2-golden.jpg')).toBe(true);
    expect(exists('fresh.jpg')).toBe(true);
    expect(exists('.gitkeep')).toBe(true);
  });

  it('колонки golden ещё нет (до миграции 71) → предупреждение и очистка как раньше', async () => {
    listGolden.mockRejectedValue(Object.assign(new Error("Unknown column 'golden' in 'where clause'"), {
      code: 'ER_BAD_FIELD_ERROR', errno: 1054,
    }));
    const r = await cleanupOldPhotos();
    expect(r.deleted).toBe(3);
    expect(exists('old-golden.jpg')).toBe(false);
    expect(exists('fresh.jpg')).toBe(true);
    expect(log.warn).toHaveBeenCalled();
  });

  it('БД недоступна → очистка пропущена целиком (фото эталона важнее места на диске)', async () => {
    listGolden.mockRejectedValue(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
    const r = await cleanupOldPhotos();
    expect(r).toEqual({ deleted: 0, freedMB: 0, keptGolden: 0, keptUnsent: 0 });
    expect(exists('old-plain.jpg')).toBe(true);
    expect(exists('old-golden.jpg')).toBe(true);
    expect(log.error).toHaveBeenCalled();
  });

  it('нет каталога processed/ — ничего не делает и в БД не ходит', async () => {
    fs.rmSync(cfg.processedDir, { recursive: true, force: true });
    const r = await cleanupOldPhotos();
    expect(r).toEqual({ deleted: 0, freedMB: 0, keptGolden: 0, keptUnsent: 0 });
    expect(listGolden).not.toHaveBeenCalled();
  });

  it('фото накладной, не отправленной в 1С (или отправленной недавно), не удаляется', async () => {
    listGolden.mockResolvedValue([]);
    listUnsent.mockResolvedValue(['old-plain.jpg']);
    const r = await cleanupOldPhotos();
    expect(r.keptUnsent).toBe(1);
    expect(exists('old-plain.jpg')).toBe(true);
    expect(exists('old-golden.jpg')).toBe(false);
    expect(listUnsent).toHaveBeenCalledWith(90);
  });

  it('список неотправленных не получен → очистка пропущена целиком', async () => {
    listGolden.mockResolvedValue([]);
    listUnsent.mockRejectedValue(new Error('connect ECONNREFUSED'));
    const r = await cleanupOldPhotos();
    expect(r.deleted).toBe(0);
    expect(exists('old-plain.jpg')).toBe(true);
  });
});
