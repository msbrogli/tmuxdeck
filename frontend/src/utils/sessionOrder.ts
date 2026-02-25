import type { TmuxSession } from '../types';

const SESSION_ORDER_KEY = 'sessionOrder';

export function getSessionOrder(containerId: string): string[] {
  try {
    const raw = localStorage.getItem(SESSION_ORDER_KEY);
    if (raw) {
      const map = JSON.parse(raw);
      return map[containerId] || [];
    }
  } catch { /* ignore */ }
  return [];
}

export function saveSessionOrder(containerId: string, order: string[]) {
  try {
    const raw = localStorage.getItem(SESSION_ORDER_KEY);
    const map = raw ? JSON.parse(raw) : {};
    map[containerId] = order;
    localStorage.setItem(SESSION_ORDER_KEY, JSON.stringify(map));
  } catch { /* ignore */ }
}

export function sortSessionsByOrder(sessions: TmuxSession[], containerId: string): TmuxSession[] {
  const order = getSessionOrder(containerId);
  if (order.length === 0) return sessions;
  const orderMap = new Map(order.map((id, idx) => [id, idx]));
  return [...sessions].sort((a, b) => {
    const ia = orderMap.get(a.id) ?? Infinity;
    const ib = orderMap.get(b.id) ?? Infinity;
    if (ia === Infinity && ib === Infinity) return 0;
    return ia - ib;
  });
}
