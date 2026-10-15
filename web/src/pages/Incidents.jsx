import React, { useCallback, useEffect, useState } from 'react';
import dayjs from 'dayjs';
import { get, post } from '../lib/api.js';
import AskDialog from '../components/AskDialog.jsx';
import IncidentModal from '../components/IncidentModal.jsx';
import { useToasts } from '../components/Toasts.jsx';
import '../components/ui.css';
import '../components/pages.css';

export default function Incidents() {
  const { toast, node } = useToasts();
  const [data, setData] = useState(null);
  const [drivers, setDrivers] = useState([]);
  const [status, setStatus] = useState('');
  const [type, setType] = useState('');
  const [range, setRange] = useState({ from: '', to: '' });
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const [dialog, setDialog] = useState(null);

  const qs = useCallback(() => {
    const p = new URLSearchParams();
    if (status) p.set('status', status);
    if (type) p.set('type', type);
    if (range.from) p.set('from', dayjs(range.from).startOf('day').toISOString());
    if (range.to) p.set('to', dayjs(range.to).add(1, 'day').startOf('day').toISOString());      // the picker's "to" is inclusive
    return p.toString();
  }, [status, type, range]);

  const load = useCallback(async () => {
    try { setData(await get(`/api/incidents?${qs()}`)); setError(''); } catch (e) { setError(e.message); }
  }, [qs]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { get('/api/drivers').then((d) => setDrivers((d.fleetbase || []).map((x) => ({ id: x.id, name: x.name })))).catch(() => {}); }, []);

  const open = data?.incidents.filter((i) => i.status === 'open').length ?? 0;
  return (
    <div className="inc">
      <div className="row">
        <h2 style={{ margin: 0 }}>Incidents</h2>
        {data && <span className="muted">{data.incidents.length} shown · {open} open</span>}
        <span style={{ flex: 1 }} />
        <a className="btn" href={`/api/incidents.csv?${qs()}`} download>Export CSV</a>
        <button type="button" className="primary" onClick={() => setAdding(true)}>Report an incident</button>
      </div>
      <div className="inc-filters card" style={{ marginTop: 10 }}>
        <label htmlFor="inc-f-status">Status</label>
        <select id="inc-f-status" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All</option><option value="open">Open</option><option value="resolved">Resolved</option></select>
        <label htmlFor="inc-f-type">Type</label>
        <select id="inc-f-type" value={type} onChange={(e) => setType(e.target.value)}><option value="">All</option>{Object.entries(data?.types || {}).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        <label htmlFor="inc-f-from">From</label><input id="inc-f-from" type="date" value={range.from} onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))} />
        <label htmlFor="inc-f-to">To</label><input id="inc-f-to" type="date" value={range.to} onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))} />
      </div>
      {error && <div className="err" role="alert">{error}</div>}
      {!data && !error && <p className="muted"><span className="ui-spin" /> Loading…</p>}
      {data?.incidents.length === 0 && <p className="ui-empty card">No incidents match. Drivers can report one from the app; you can report one here or from an order card (⋯ → Report incident).</p>}
      <div className="inc-list">
        {data?.incidents.map((i) => (
          <article key={i.id} className={`inc-item ${i.status}`}>
            <div>
              <strong>{i.type_label}</strong> <span className="ui-badge off">{i.status === 'open' ? 'Open' : 'Resolved'}</span>
              <div>{i.note}</div>
              <div className="muted">
                {dayjs(i.at).format('D MMM YYYY HH:mm')} · reported by {i.reporter === 'admin' ? 'the shop' : `driver ${i.driver_name || i.reporter.slice(7)}`}
                {i.order_number ? ` · order ${i.order_number}` : ''}{i.driver_id && i.reporter === 'admin' ? ` · driver ${i.driver_name || i.driver_id}` : ''}
              </div>
              {i.resolved_at && <div className="muted">Resolved {dayjs(i.resolved_at).format('D MMM HH:mm')}{i.resolved_note ? `: ${i.resolved_note}` : ''}</div>}
              {i.photo && <a href={`/api/uploads/${encodeURIComponent(i.photo)}`} target="_blank" rel="noreferrer"><img src={`/api/uploads/${encodeURIComponent(i.photo)}`} alt={`Photo for incident ${i.id}`} loading="lazy" /></a>}
            </div>
            {i.status === 'open' && <button type="button" className="dark" onClick={() => setDialog({ title: `Resolve incident #${i.id}`, field: { label: 'What was done?', required: false, placeholder: 'e.g. Called the customer, refunded' }, confirmText: 'Mark resolved', onSubmit: async (note) => { await post(`/api/incidents/${i.id}/resolve`, note ? { note } : {}); toast('Resolved', 'ok'); await load(); } })}>Resolve</button>}
          </article>
        ))}
      </div>
      {adding && <IncidentModal drivers={drivers} onClose={() => setAdding(false)} onDone={() => { toast('Incident saved', 'ok'); load(); }} />}
      {dialog && <AskDialog {...dialog} onClose={() => setDialog(null)} />}
      {node}
    </div>
  );
}
