import { describe, it, expect } from 'vitest';
import {
  parseChatIds, parseValidChatIds, serializeChatIds, isValidChatId, MAX_CHAT_IDS,
} from '../../src/notifications/telegram/chatIds';

// Разбор списка chat_id. Без БД — выполняется и локально, и в CI.
// См. docs/superpowers/specs/2026-08-03-multiple-telegram-chats-design.md

describe('parseChatIds', () => {
  it('принимает любые разделители — id копируют откуда попало', () => {
    const expected = ['111', '222', '333'];
    expect(parseChatIds('111,222,333')).toEqual(expected);
    expect(parseChatIds('111 222 333')).toEqual(expected);
    expect(parseChatIds('111\n222\n333')).toEqual(expected);
    expect(parseChatIds('111; 222 ,333')).toEqual(expected);
    expect(parseChatIds('  111 ,\n 222 ;; 333  ')).toEqual(expected);
  });

  it('одиночный id остаётся валидным — старые аккаунты работают как раньше', () => {
    expect(parseChatIds('123456789')).toEqual(['123456789']);
  });

  it('схлопывает дубликаты, сохраняя порядок', () => {
    expect(parseChatIds('111,222,111,333,222')).toEqual(['111', '222', '333']);
  });

  it('пустой ввод — это пустой список, а не [""]', () => {
    for (const v of ['', '   ', ',,,', '\n', null, undefined]) {
      expect(parseChatIds(v as string)).toEqual([]);
    }
  });
});

describe('isValidChatId', () => {
  it('пропускает личные и групповые идентификаторы', () => {
    expect(isValidChatId('123456789')).toBe(true);
    // У групп и супергрупп chat_id отрицательный — это норма, не ошибка ввода.
    expect(isValidChatId('-1001234567890')).toBe(true);
  });

  it('отвергает всё, что не число', () => {
    for (const v of ['@channel', 'abc', '12a', '1.5', '1 2', '-', '', '--1']) {
      expect(isValidChatId(v)).toBe(false);
    }
  });
});

describe('parseValidChatIds', () => {
  it('отбрасывает мусор, оставляя пригодные для отправки', () => {
    expect(parseValidChatIds('111, @channel, -100222, abc')).toEqual(['111', '-100222']);
  });

  it('на полностью мусорном вводе не оставляет ничего — рассылать некуда', () => {
    expect(parseValidChatIds('@a, @b')).toEqual([]);
  });
});

describe('serializeChatIds', () => {
  it('пишет канонический вид через запятую', () => {
    expect(serializeChatIds(['111', '-100222'])).toBe('111,-100222');
  });

  it('пустой список превращает в null — уведомления выключены', () => {
    // null, а не пустая строка: колонка nullable, и «нет чатов» должно читаться
    // как отсутствие настройки.
    expect(serializeChatIds([])).toBeNull();
  });

  it('пережёвывает собственный вывод без изменений', () => {
    const canonical = serializeChatIds(parseChatIds('111\n-100222 ; 333'));
    expect(canonical).toBe('111,-100222,333');
    expect(serializeChatIds(parseChatIds(canonical as string))).toBe(canonical);
  });
});

describe('ограничение количества', () => {
  it('лимит задан и разумен', () => {
    expect(MAX_CHAT_IDS).toBeGreaterThan(1);
    expect(MAX_CHAT_IDS).toBeLessThanOrEqual(50);
  });
});
