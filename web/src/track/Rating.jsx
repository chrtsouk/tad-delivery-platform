import { useState } from 'react';
import { postRating } from './api.js';

const WORDS = ['', 'Poor', 'Could be better', 'Good', 'Great', 'Brilliant'];

export default function Rating({ token, order, onRated }) {
  const [hover, setHover] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [done, setDone] = useState(order.rating ?? null);

  const send = async (n) => {
    setBusy(true); setErr('');
    try { const r = await postRating(token, n); setDone(r.rating); onRated?.(); }
    catch (e) { setErr(e.status === 0 ? 'You appear to be offline — try again in a moment.' : e.message); }
    finally { setBusy(false); }
  };

  if (done != null) {
    return (
      <section className="card rating" aria-live="polite">
        <p className="stars-done" aria-label={`You rated this ${done} out of 5`}>{'★'.repeat(done)}<span className="off">{'★'.repeat(5 - done)}</span></p>
        <p><strong>Thank you for your feedback!</strong></p>
        <p className="muted">It really helps us look after the next order.</p>
      </section>
    );
  }
  if (!order.can_rate) return null;
  const shown = hover || 0;
  return (
    <section className="card rating" aria-labelledby="rate-h">
      <h2 id="rate-h">How was your order?</h2>
      <div className="stars" role="group" aria-label="Rate your order from 1 to 5 stars" onMouseLeave={() => setHover(0)}>
        {[1, 2, 3, 4, 5].map((n) => (
          <button key={n} type="button" className={`star${n <= shown ? ' on' : ''}`} disabled={busy} aria-label={`${n} ${n === 1 ? 'star' : 'stars'} — ${WORDS[n]}`}
            onMouseEnter={() => setHover(n)} onFocus={() => setHover(n)} onBlur={() => setHover(0)} onClick={() => send(n)}>★</button>
        ))}
      </div>
      <p className="muted small" aria-live="polite">{busy ? 'Sending…' : shown ? WORDS[shown] : 'Tap a star'}</p>
      {err && <p className="notice notice-warn" role="alert">{err}</p>}
    </section>
  );
}
