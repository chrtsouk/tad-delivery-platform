import { useEffect, useRef, useState } from 'react';
import dayjs from 'dayjs';
import { get, post } from '../lib/api.js';

const CANCELLABLE = ['scheduled', 'new', 'accepted', 'preparing', 'ready', 'assigned', 'failed'];
const money = (p) => (p == null ? '—' : `£${(p / 100).toFixed(2)}`);
const when = (iso) => (iso ? dayjs(iso).format('ddd D MMM YYYY, HH:mm') : '—');

function Row({ k, children }) {
  return <div className="cal-row"><dt>{k}</dt><dd>{children}</dd></div>;
}

function OrderDetails({ orderId, onChanged, onClose }) {
  const [state, setState] = useState({ loading: true, error: null, data: null });
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => {
    let live = true;
    get(`/api/orders/${orderId}`).then((data) => live && setState({ loading: false, error: null, data }), (error) => live && setState({ loading: false, error, data: null }));
    return () => { live = false; };
  }, [orderId]);

  if (state.loading) return <p className="muted" role="status">Loading order…</p>;
  if (state.error) return <div className="err" role="alert">{state.error.message}</div>;
  const { order: o, timeline } = state.data;

  const cancel = async () => {
    if (!reason.trim()) { setErr('Please give a reason for cancelling.'); return; }
    setBusy(true); setErr('');
    try {
      await post(`/api/orders/${orderId}/transition`, { to: 'cancelled', reason: reason.trim() });
      onChanged();
      onClose();
    } catch (e) { setErr(e.message); setBusy(false); }
  };

  return (
    <>
      <dl className="cal-dl">
        <Row k="Status"><span className={`pill ${o.state === 'cancelled' || o.state === 'failed' ? 'late' : o.state === 'scheduled' ? 'warn' : 'ok'}`}>{o.state}</span></Row>
        <Row k="Scheduled for">{when(o.scheduled_for)}</Row>
        <Row k="Customer">{o.customer_name || '—'}{o.customer_phone ? ` · ${o.customer_phone}` : ''}</Row>
        <Row k="Address">{[o.address_line, o.postcode].filter(Boolean).join(', ') || (o.fulfilment === 'collection' ? 'Collection' : '—')}</Row>
        <Row k="Items">{o.items.map((i) => `${i.qty} × ${i.name}`).join(', ')}</Row>
        {o.notes && <Row k="Notes">{o.notes}</Row>}
        <Row k="Source">{o.source}</Row>
        <Row k="Total">{money(o.total_pence)} {o.paid ? <span className="pill ok">Paid online</span> : <span className="pill warn">Not paid</span>}</Row>
        {o.fail_reason && <Row k="Reason">{o.fail_reason}</Row>}
      </dl>
      <h4 className="cal-sub">Timeline</h4>
      {timeline.length === 0 ? <p className="muted">No events yet.</p> : (
        <ul className="cal-timeline">{timeline.map((t, i) => <li key={i}><span className="muted">{dayjs(t.at).format('D MMM HH:mm')}</span> {t.type.replace('state:', '→ ')}</li>)}</ul>
      )}
      {err && <div className="err" role="alert">{err}</div>}
      {asking ? (
        <div className="cal-ask">
          <label htmlFor="cal-reason">Why is this order being cancelled?</label>
          <textarea id="cal-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus placeholder="e.g. Customer called to cancel" />
          <div className="row">
            <button type="button" className="primary" onClick={cancel} disabled={busy}>{busy ? 'Cancelling…' : 'Confirm cancellation'}</button>
            <button type="button" onClick={() => { setAsking(false); setErr(''); }} disabled={busy}>Keep order</button>
          </div>
        </div>
      ) : (
        <div className="row cal-actions">
          {CANCELLABLE.includes(o.state)
            ? <button type="button" className="primary" onClick={() => setAsking(true)}>Cancel order…</button>
            : <span className="muted">This order can no longer be cancelled ({o.state}).</span>}
          <button type="button" onClick={onClose}>Close</button>
        </div>
      )}
    </>
  );
}

function ShiftDetails({ ev, onClose }) {
  const mins = Math.max(0, Math.round((ev.end - ev.start) / 60000));
  return (
    <>
      <dl className="cal-dl">
        <Row k="Driver">{ev.raw.title}</Row>
        <Row k="Clocked in">{when(ev.start)}</Row>
        <Row k="Clocked out">{ev.raw.open ? <span className="pill ok">Still on shift</span> : when(ev.end)}</Row>
        <Row k={ev.raw.open ? 'On shift so far' : 'Length'}>{Math.floor(mins / 60)} h {String(mins % 60).padStart(2, '0')} min</Row>
      </dl>
      <div className="row cal-actions"><button type="button" onClick={onClose}>Close</button></div>
    </>
  );
}

/** Dialog for a calendar event: pre-orders load the order and offer cancel; shifts show the times. */
export default function EventModal({ ev, onClose, onChanged }) {
  const ref = useRef(null);
  useEffect(() => {
    const prev = document.activeElement;
    ref.current?.focus();
    const key = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('keydown', key); prev?.focus?.(); };
  }, [onClose]);
  const isOrder = ev.kind === 'pre-order';
  return (
    <div className="cal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="cal-modal card" role="dialog" aria-modal="true" aria-labelledby="cal-modal-title" ref={ref} tabIndex={-1}>
        <div className="row cal-modal-head">
          <h3 id="cal-modal-title">{isOrder ? `Pre-order ${ev.raw.title}` : `Shift — ${ev.raw.title}`}</h3>
          <button type="button" className="cal-x" aria-label="Close" onClick={onClose}>×</button>
        </div>
        {isOrder ? <OrderDetails orderId={Number(String(ev.id).slice(1))} onChanged={onChanged} onClose={onClose} /> : <ShiftDetails ev={ev} onClose={onClose} />}
      </div>
    </div>
  );
}
