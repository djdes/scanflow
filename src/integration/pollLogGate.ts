/**
 * Журнал опроса очереди 1С (п.20 пакета v2).
 *
 * Обработка 1С спрашивает /invoices/pending раз в минуту, и каждый пустой
 * опрос писал в integration_events строку «запросило очередь: 0» — сотни строк
 * в сутки на подключение, за которыми в журнале не видно настоящих событий.
 * Теперь непустой опрос пишется всегда, пустой — не чаще раза в час на
 * подключение: по журналу всё ещё видно, что 1С на связи.
 *
 * Состояние — в памяти процесса (Map по id подключения). После рестарта первый
 * опрос просто запишется — это безвредно.
 */
export const POLL_LOG_QUIET_MS = 60 * 60_000;

export type PollLogGate = (connectionId: number | null | undefined, rowCount: number, now?: number) => boolean;

export function createPollLogGate(quietMs: number = POLL_LOG_QUIET_MS): PollLogGate {
  const lastLoggedAt = new Map<number, number>();
  return (connectionId, rowCount, now = Date.now()) => {
    const key = connectionId ?? 0;
    const last = lastLoggedAt.get(key);
    if (rowCount > 0 || last === undefined || now - last >= quietMs) {
      lastLoggedAt.set(key, now);
      return true;
    }
    return false;
  };
}
