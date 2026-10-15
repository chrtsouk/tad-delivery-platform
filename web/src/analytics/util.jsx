import { useCallback, useEffect, useState } from 'react';
import { get } from '../lib/api.js';

/* The server buckets by SHOP-LOCAL day (settings.timezone, default Europe/London). Dates here are shop-local calendar dates (YYYY-MM-DD). */
let TZ = 'Europe/London';
export const setShopTz = (tz) => { if (tz) TZ = tz; };
export const DAY_MS = 86400000;
export const ymd = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(d));
export const todayShop = () => ymd(Date.now());
export const todayUtc = todayShop;
export const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
export const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '') && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
export const longDay = (day) => new Date(`${day}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
export const hhmm = (iso) => (iso ? new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso)) : '—');

export const fmtNum = (n) => (n == null ? '—' : Number(n).toLocaleString('en-GB'));
export const fmtPct = (n) => (n == null ? '—' : `${n}%`);
export const fmtMin = (n) => (n == null ? '—' : `${n} min`);

/** Fetch `path` whenever it changes. `path` null = do nothing. Returns { data, error, loading, reload }. */
export function useFetch(path, { every = 0, keepOnError = false } = {}) {
  const [state, setState] = useState({ data: null, error: null, loading: Boolean(path) });
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  useEffect(() => {
    if (!path) { setState({ data: null, error: null, loading: false }); return undefined; }
    let live = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    get(path).then((data) => live && setState({ data, error: null, loading: false }), (error) => live && setState((s) => ({ data: keepOnError ? s.data : null, error, loading: false })));
    return () => { live = false; };
  }, [path, tick, keepOnError]);
  useEffect(() => {
    if (!every) return undefined;
    const t = setInterval(reload, every);
    return () => clearInterval(t);
  }, [every, reload]);
  return { ...state, reload };
}

export function Status({ loading, error, empty, emptyText = 'Nothing to show for this period.', onRetry }) {
  if (error) return <div className="err" role="alert">{error.message || 'Something went wrong.'}{onRetry && <> <button type="button" onClick={onRetry}>Try again</button></>}</div>;
  if (loading) return <p className="muted" role="status">Loading…</p>;
  if (empty) return <p className="muted ana-empty">{emptyText}</p>;
  return null;
}

/** Two date inputs (inclusive range). Calls onChange({from,to}) only with valid, ordered dates. */
export function RangePicker({ from, to, onChange }) {
  const set = (k, v) => {
    if (!isDay(v)) return;
    const next = { from, to, [k]: v };
    if (next.from > next.to) { if (k === 'from') next.to = next.from; else next.from = next.to; }
    onChange(next);
  };
  const preset = (days) => onChange({ from: addDays(todayUtc(), -(days - 1)), to: todayUtc() });
  return (
    <div className="ana-range no-print">
      <div><label htmlFor="ana-from">From</label><input id="ana-from" type="date" value={from} max={to} onChange={(e) => set('from', e.target.value)} /></div>
      <div><label htmlFor="ana-to">To (inclusive)</label><input id="ana-to" type="date" value={to} min={from} max={todayUtc()} onChange={(e) => set('to', e.target.value)} /></div>
      <div className="ana-presets">
        <button type="button" onClick={() => preset(7)}>Last 7 days</button>
        <button type="button" onClick={() => preset(14)}>Last 14 days</button>
        <button type="button" onClick={() => preset(30)}>Last 30 days</button>
      </div>
    </div>
  );
}
