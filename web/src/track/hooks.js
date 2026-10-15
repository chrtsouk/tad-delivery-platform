import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchInbox, fetchOrder } from './api.js';

const TERMINAL = ['delivered', 'collected', 'cancelled', 'removed', 'failed'];

/** Poll the order: 5 s while out for delivery, 15 s otherwise (60 s once finished); paused while the tab is hidden. */
export function useOrder(token) {
  const [order, setOrder] = useState(null);
  const [error, setError] = useState(null); // { status, message } — fatal when there is no order yet
  const [offline, setOffline] = useState(typeof navigator !== 'undefined' && navigator.onLine === false);
  const [loading, setLoading] = useState(true);
  const stateRef = useRef(null);
  const timer = useRef(0);
  const busy = useRef(false);
  const dead = useRef(false);

  const load = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const data = await fetchOrder(token);
      if (dead.current) return;
      stateRef.current = data.state;
      setOrder(data); setError(null); setOffline(false);
    } catch (e) {
      if (dead.current) return;
      if (e.status === 0) setOffline(true);
      else if (e.status === 404 || e.status === 400) { stateRef.current = null; setOrder(null); setError({ status: e.status, message: e.message }); }
      else setError((prev) => prev ?? { status: e.status, message: e.message });
    } finally {
      busy.current = false;
      if (!dead.current) setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    dead.current = false;
    const schedule = () => {
      clearTimeout(timer.current);
      const s = stateRef.current;
      const ms = s === 'out' ? 5000 : s && TERMINAL.includes(s) ? 60000 : 15000;
      timer.current = setTimeout(async () => {
        if (document.visibilityState === 'visible') await load();
        if (!dead.current) schedule();
      }, ms);
    };
    load().then(schedule);
    const onVis = () => { if (document.visibilityState === 'visible') { load().then(schedule); } };
    const onOnline = () => { load().then(schedule); };
    const onOffline = () => setOffline(true);
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => { dead.current = true; clearTimeout(timer.current); document.removeEventListener('visibilitychange', onVis); window.removeEventListener('online', onOnline); window.removeEventListener('offline', onOffline); };
  }, [load]);

  const retry = useCallback(() => { setLoading(true); setError(null); load(); }, [load]);
  return { order, error, offline, loading, retry, refresh: load };
}

/** Poll the inbox every 20 s; messages that arrive after the page opened are returned as banners. Works without push. */
export function useInbox(token, enabled, onNew) {
  const [banners, setBanners] = useState([]);
  const seen = useRef(null);
  const cb = useRef(onNew);
  cb.current = onNew;

  useEffect(() => {
    if (!enabled) return undefined;
    let dead = false;
    const poll = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const { messages = [] } = await fetchInbox(token);
        if (dead) return;
        if (seen.current === null) { seen.current = new Set(messages.map((m) => m.id)); return; }
        const fresh = messages.filter((m) => !seen.current.has(m.id));
        if (fresh.length) {
          fresh.forEach((m) => seen.current.add(m.id));
          setBanners((b) => [...fresh.reverse(), ...b].slice(0, 3));
          cb.current?.(fresh);
        }
      } catch { /* inbox is best-effort */ }
    };
    poll();
    const id = setInterval(poll, 20000);
    return () => { dead = true; clearInterval(id); };
  }, [token, enabled]);

  const dismiss = useCallback((id) => setBanners((b) => b.filter((m) => m.id !== id)), []);
  return { banners, dismiss };
}
