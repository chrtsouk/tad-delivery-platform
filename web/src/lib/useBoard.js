import { useCallback, useEffect, useRef, useState } from 'react';
import { get } from './api.js';

/** Live board snapshot: loads /api/board, re-loads on every server event (SSE /api/stream) and every 20 s as a safety net. */
export function useBoard() {
  const [board, setBoard] = useState(null);
  const [error, setError] = useState(null);
  const [live, setLive] = useState(false);
  const timer = useRef(null);
  const refresh = useCallback(async () => {
    try { setBoard(await get('/api/board')); setError(null); } catch (e) { setError(e); }
  }, []);
  useEffect(() => {
    refresh();
    const poll = setInterval(refresh, 20000);
    const es = new EventSource('/api/stream');
    const kick = () => { clearTimeout(timer.current); timer.current = setTimeout(refresh, 250); };
    es.addEventListener('hello', () => setLive(true));
    ['order', 'batch', 'board'].forEach((ev) => es.addEventListener(ev, kick));
    es.onerror = () => setLive(false);
    return () => { clearInterval(poll); es.close(); clearTimeout(timer.current); };
  }, [refresh]);
  return { board, error, live, refresh };
}
