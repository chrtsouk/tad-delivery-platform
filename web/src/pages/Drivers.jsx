import React, { useCallback, useEffect, useMemo, useState } from 'react';
import dayjs from 'dayjs';
import { get, post } from '../lib/api.js';
import AskDialog from '../components/AskDialog.jsx';
import Icon from '../components/Icon.jsx';
import Modal from '../components/Modal.jsx';
import TrailModal from '../components/TrailModal.jsx';
import IncidentModal from '../components/IncidentModal.jsx';
import { useToasts } from '../components/Toasts.jsx';
import '../components/ui.css';
import '../components/pages.css';

const RANGES = [
  ['today', 'Today', () => ({ from: dayjs().startOf('day').toISOString() })],
  ['7d', 'Last 7 days', () => ({ from: dayjs().subtract(7, 'day').startOf('day').toISOString() })],
  ['30d', 'Last 30 days', () => ({ from: dayjs().subtract(30, 'day').startOf('day').toISOString() })],
  ['all', 'All time', () => ({})],
];
const STATE_LABEL = { available: 'Available', busy: 'On a run', offline: 'Offline in the app', off: 'Off shift' };

function TokenModal({ token, driver, onClose }) {
  const [copied, setCopied] = useState('');
  const copy = async () => {
    try { await navigator.clipboard.writeText(token); setCopied('Copied to the clipboard.'); }
    catch {
      const el = document.getElementById('drv-token'); const r = document.createRange(); r.selectNodeContents(el);
      const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
      setCopied('Select and copy the token above (the browser blocked automatic copying).');
    }
  };
  return (
    <Modal title={`App token for ${driver}`} onClose={onClose} footer={<button type="button" className="dark" onClick={onClose}>I have saved it</button>}>
      <div className="err" role="note"><strong>Shown once.</strong> Enter it in the TAD Drivers app. It cannot be viewed again; if it is lost, issue a new one.</div>
      <div id="drv-token" className="ui-tok" data-autofocus tabIndex={0}>{token}</div>
      <p><button type="button" onClick={copy}><Icon name="copy" /> Copy token</button> {copied && <span className="muted" role="status">{copied}</span>}</p>
    </Modal>
  );
}

function DriverCard({ d, onDone, toast, setDialog, setToken, setTrail, setIncident }) {
  const [zone, setZone] = useState('');
  const [busy, setBusy] = useState('');
  const run = async (what, fn, ok) => {
    setBusy(what);
    try { const r = await fn(); if (ok) toast(ok, 'ok'); await onDone(); return r; } catch (e) { toast(e.message, 'err'); } finally { setBusy(''); }
    return undefined;
  };
  const clockedIn = d.state !== 'off';
  const onRoad = d.run?.batch_status === 'out';
  return (
    <article className={`drv-card st-${d.state}`}>
      <header>
        <div>
          <h3><Icon name="user" /> {d.name || d.id}</h3>
          <div className="muted drv-sub">{d.phone || 'No phone on file'}{d.name ? ` · ${d.id}` : ''}</div>
        </div>
        <span className={`drv-state ${d.state}`}>{STATE_LABEL[d.state]}</span>
      </header>
      <dl className="drv-facts">
        <div><dt>Driver app</dt><dd>{d.online === true ? 'Online' : d.online === false ? 'Offline' : 'Unknown'}</dd></div>
        {clockedIn && <div><dt>Clocked in</dt><dd>{dayjs(d.clock_in_at).format('HH:mm')}{d.zone ? ` · ${d.zone}` : ''}</dd></div>}
        {d.run && <div><dt>Current run</dt><dd>{d.run.batch_status === 'out' ? 'Out delivering' : 'Collecting at the shop'}</dd></div>}
        {onRoad && d.run.return_eta_at && <div><dt>Back at</dt><dd>{dayjs(d.run.return_eta_at).format('HH:mm')}</dd></div>}
      </dl>
      {!clockedIn && (
        <div className="drv-clock">
          <label htmlFor={`zone-${d.id}`}>Zone (optional)</label>
          <input id={`zone-${d.id}`} value={zone} maxLength={40} onChange={(e) => setZone(e.target.value)} placeholder="e.g. Clapham" />
        </div>
      )}
      <div className="drv-actions">
        {!clockedIn
          ? <button type="button" className="primary" disabled={busy === 'in'} onClick={() => run('in', () => post(`/api/drivers/${d.id}/clock-in`, zone.trim() ? { zone: zone.trim() } : {}), `${d.name || d.id} clocked in`)}>{busy === 'in' ? 'Clocking in…' : 'Clock in'}</button>
          : <button type="button" className="dark" disabled={busy === 'out' || onRoad} title={onRoad ? 'This driver is out on a run. Clock out after they return.' : ''}
            onClick={() => run('out', () => post(`/api/drivers/${d.id}/clock-out`), `${d.name || d.id} clocked out`)}>{busy === 'out' ? 'Clocking out…' : 'Clock out'}</button>}
        <button type="button" disabled={busy === 'token'} onClick={() => setDialog({
          title: `Issue an app token for ${d.name || d.id}?`,
          body: 'This creates a new sign-in token for the TAD Drivers app. Any token issued before stops working.',
          confirmText: 'Issue token',
          onSubmit: async () => { const r = await post(`/api/drivers/${d.id}/token`); setToken({ token: r.token, driver: d.name || d.id }); },
        })}>Issue app token</button>
        <button type="button" onClick={() => setTrail(d)}>Route history</button>
        <button type="button" onClick={() => setIncident(d)}>Report incident</button>
      </div>
    </article>
  );
}

export default function Drivers() {
  const { toast, node } = useToasts();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [dialog, setDialog] = useState(null);
  const [token, setToken] = useState(null);
  const [trail, setTrail] = useState(null);
  const [incident, setIncident] = useState(null);
  const [range, setRange] = useState('7d');
  const [perf, setPerf] = useState({ loading: true, rows: [], err: '' });

  const load = useCallback(async () => {
    try { setData(await get('/api/drivers')); setError(''); } catch (e) { setError(e.message); }
  }, []);
  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, [load]);

  useEffect(() => {
    let live = true;
    const r = RANGES.find((x) => x[0] === range)[2]();
    const qs = new URLSearchParams(r).toString();
    setPerf((p) => ({ ...p, loading: true, err: '' }));
    get(`/api/analytics/drivers${qs ? `?${qs}` : ''}`).then((x) => live && setPerf({ loading: false, rows: x.drivers, err: '' })).catch((e) => live && setPerf({ loading: false, rows: [], err: e.message }));
    return () => { live = false; };
  }, [range]);

  const drivers = useMemo(() => {
    if (!data) return [];
    const shift = new Map();
    for (const [state, list] of [['available', data.available], ['busy', data.busy], ['offline', data.offline]]) for (const x of list) shift.set(x.driver_id, { state, ...x });
    const out = (data.fleetbase || []).map((f) => {
      const s = shift.get(f.id);
      return { id: f.id, name: f.name, phone: f.phone, online: f.online, state: s?.state || 'off', clock_in_at: s?.clock_in_at, zone: s?.zone, run: s?.state === 'busy' ? s : null };
    });
    for (const [id, s] of shift) if (!out.some((d) => d.id === id)) out.push({ id, name: s.name, online: null, state: s.state, clock_in_at: s.clock_in_at, zone: s.zone, run: s.state === 'busy' ? s : null });
    const order = { available: 0, busy: 1, offline: 2, off: 3 };
    return out.sort((a, b) => order[a.state] - order[b.state] || String(a.name || a.id).localeCompare(String(b.name || b.id)));
  }, [data]);

  const counts = data ? { available: data.available.length, busy: data.busy.length, offline: data.offline.length } : null;

  return (
    <div className="drv">
      <div className="row drv-head">
        <h2>Drivers</h2>
        {counts && <span className="muted">{counts.available} available · {counts.busy} on a run · {counts.offline} offline</span>}
        <span className="brd-spacer" style={{ flex: 1 }} />
        <button type="button" onClick={load}>Refresh</button>
      </div>

      {error && <div className="err" role="alert">Could not load drivers: {error}</div>}
      {!data && !error && <p className="muted"><span className="ui-spin" /> Loading drivers…</p>}
      {data && data.fleetbase === null && <div className="err" role="alert">The dispatch system (Fleetbase) did not answer, so only drivers who are clocked in are shown.</div>}
      {data && drivers.length === 0 && !error && <p className="ui-empty card">No drivers yet. Add drivers in Fleetbase and they will appear here.</p>}
      <div className="drv-grid">
        {drivers.map((d) => <DriverCard key={d.id} d={d} onDone={load} toast={toast} setDialog={setDialog} setToken={setToken} setTrail={setTrail} setIncident={setIncident} />)}
      </div>

      <section className="card drv-perf">
        <div className="row">
          <h3 style={{ margin: 0 }}>Performance</h3>
          <span style={{ flex: 1 }} />
          <div className="add-seg drv-range" role="radiogroup" aria-label="Period">
            {RANGES.map(([k, l]) => <button type="button" key={k} role="radio" aria-checked={range === k} className={range === k ? 'on' : ''} onClick={() => setRange(k)}>{l}</button>)}
          </div>
        </div>
        {perf.err && <div className="err" role="alert">{perf.err}</div>}
        {perf.loading ? <p className="muted"><span className="ui-spin" /> Loading…</p> : perf.rows.length === 0 ? <p className="ui-empty">No completed deliveries in this period.</p> : (
          <div className="drv-table-wrap">
            <table>
              <thead><tr><th>Driver</th><th>Deliveries</th><th>On time</th><th>Avg pickup to drop (min)</th><th>Avg order to door (min)</th><th>Failed</th></tr></thead>
              <tbody>
                {perf.rows.map((r) => (
                  <tr key={r.driver_id}>
                    <td>{r.name || r.driver_id}</td><td>{r.deliveries}</td><td>{r.on_time_pct == null ? '—' : `${r.on_time_pct}%`}</td>
                    <td>{r.avg_pickup_to_drop_min ?? '—'}</td><td>{r.avg_order_to_door_min ?? '—'}</td><td>{r.failed}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {dialog && <AskDialog {...dialog} onClose={() => setDialog(null)} />}
      {token && <TokenModal token={token.token} driver={token.driver} onClose={() => setToken(null)} />}
      {trail && <TrailModal driver={trail} onClose={() => setTrail(null)} />}
      {incident && <IncidentModal driverId={incident.id} drivers={drivers.map((x) => ({ id: x.id, name: x.name }))} onClose={() => setIncident(null)} onDone={() => toast('Incident saved', 'ok')} />}
      {node}
    </div>
  );
}
