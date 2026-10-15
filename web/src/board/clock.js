import { useSyncExternalStore } from 'react';

/**
 * ONE shared 1-second ticker for every timer on the board.
 * Components subscribe through useSyncExternalStore with a selector snapshot, so a card only re-renders when the value it
 * shows actually changes (the seconds display every second, the SLA colour only when it crosses amber/red).
 */
const listeners = new Set();
let timer = null;
function subscribe(fn) {
  listeners.add(fn);
  if (!timer) timer = setInterval(() => listeners.forEach((f) => f()), 1000);
  return () => { listeners.delete(fn); if (!listeners.size) { clearInterval(timer); timer = null; } };
}

/** Whole seconds since epoch; changes once a second. */
export const useSecond = () => useSyncExternalStore(subscribe, () => Math.floor(Date.now() / 1000), () => 0);

/** Age in minutes: the server's age_minutes at snapshot time plus the time elapsed since the snapshot arrived (never drifts). */
export const ageMinutes = (order, snapAt, now = Date.now()) => order.age_minutes + Math.max(0, now - snapAt) / 60000;

export function slaLevel(order, snapAt, settings, now = Date.now()) {
  if (!order || order.sla === 'done') return 'done';
  const age = ageMinutes(order, snapAt, now);
  if (age >= settings.late_after_minutes) return 'late';
  if (age >= settings.warn_after_minutes) return 'warn';
  return 'ok';
}

/** 'ok' | 'warn' | 'late' | 'done' — re-renders only when the level changes. */
export const useSla = (order, snapAt, settings) => useSyncExternalStore(subscribe, () => slaLevel(order, snapAt, settings), () => 'ok');

export const OPEN_ACTIVE = ['new', 'accepted', 'preparing', 'ready', 'assigned', 'out'];

/** Orders that are late right now (recomputed every second). */
export function useLateOrders(board, snapAt) {
  useSecond();
  if (!board) return [];
  const now = Date.now();
  return board.orders.filter((o) => OPEN_ACTIVE.includes(o.state) && slaLevel(o, snapAt, board.settings, now) === 'late');
}
