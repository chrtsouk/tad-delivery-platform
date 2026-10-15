import { useEffect, useMemo, useState } from 'react';
import dayjs from 'dayjs';
import { get } from '../lib/api.js';

const STEP = 200, MAX = 1000;       // the server caps a request at 1000 rows
const addDay = (d) => new Date(Date.parse(`${d}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
const detailText = (d) => (d == null ? '' : JSON.stringify(d));
const when = (iso) => dayjs(iso).format('DD MMM YYYY HH:mm:ss');

function csvCell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;     // stop spreadsheets treating text as a formula
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function downloadCsv(rows) {
  const head = ['time', 'actor', 'action', 'entity', 'entity_id', 'detail'];
  const lines = [head.join(',')].concat(rows.map((r) => [r.at, r.actor, r.action, r.entity, r.entity_id, detailText(r.detail)].map(csvCell).join(',')));
  const url = URL.createObjectURL(new Blob([`﻿${lines.join('\r\n')}\r\n`], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url; a.download = `audit-log-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function Audit() {
  const [range, setRange] = useState({ from: '', to: '' });
  const [limit, setLimit] = useState(STEP);
  const [rows, setRows] = useState([]);
  const [state, setState] = useState({ loading: true, error: null });
  const [text, setText] = useState('');
  const [action, setAction] = useState('');
  const [open, setOpen] = useState(() => new Set());
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    setState({ loading: true, error: null });
    const p = new URLSearchParams({ limit: String(limit) });
    if (range.from) p.set('from', range.from);
    if (range.to) p.set('to', addDay(range.to));      // "to" is exclusive on the server, the picker's is inclusive
    get(`/api/audit?${p}`).then((r) => { if (live) { setRows(r.events); setState({ loading: false, error: null }); } }, (error) => live && setState({ loading: false, error }));
    return () => { live = false; };
  }, [range, limit, tick]);

  const actions = useMemo(() => [...new Set(rows.map((r) => r.action))].sort(), [rows]);
  const shown = useMemo(() => {
    const t = text.trim().toLowerCase();
    return rows.filter((r) => (!action || r.action === action) && (!t || [r.at, r.actor, r.action, r.entity, r.entity_id, detailText(r.detail)].some((v) => String(v ?? '').toLowerCase().includes(t))));
  }, [rows, text, action]);
  const mayHaveMore = rows.length >= limit && limit < MAX;
  const setDate = (k, v) => { setLimit(STEP); setRange((r) => ({ ...r, [k]: v })); };
  const toggle = (id) => setOpen((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const filtered = text.trim() || action || range.from || range.to;

  return (
    <div className="aud-page">
      <div className="row aud-head">
        <h2 style={{ margin: 0 }}>Audit log</h2>
        <span className="muted">Every change made by staff, drivers and the system.</span>
      </div>
      <div className="card aud-filters">
        <div className="aud-f-text"><label htmlFor="aud-q">Search</label><input id="aud-q" type="search" placeholder="Actor, action, order number, detail…" value={text} onChange={(e) => setText(e.target.value)} /></div>
        <div><label htmlFor="aud-action">Action</label>
          <select id="aud-action" value={action} onChange={(e) => setAction(e.target.value)}>
            <option value="">All actions</option>
            {actions.map((a) => <option key={a} value={a}>{a}</option>)}
            {action && !actions.includes(action) && <option value={action}>{action}</option>}
          </select>
        </div>
        <div><label htmlFor="aud-from">From</label><input id="aud-from" type="date" value={range.from} max={range.to || undefined} onChange={(e) => setDate('from', e.target.value)} /></div>
        <div><label htmlFor="aud-to">To (inclusive)</label><input id="aud-to" type="date" value={range.to} min={range.from || undefined} onChange={(e) => setDate('to', e.target.value)} /></div>
        <div className="aud-f-btns">
          <button type="button" onClick={() => { setText(''); setAction(''); setRange({ from: '', to: '' }); setLimit(STEP); }} disabled={!filtered}>Clear filters</button>
          <button type="button" className="dark" onClick={() => downloadCsv(shown)} disabled={!shown.length}>Export CSV ({shown.length})</button>
        </div>
      </div>

      {state.error && <div className="err" role="alert">{state.error.message} <button type="button" onClick={() => setTick((t) => t + 1)}>Try again</button></div>}
      {state.loading && !rows.length && <p className="muted" role="status">Loading…</p>}
      {!state.loading && !state.error && rows.length === 0 && <p className="muted">No audit events{range.from || range.to ? ' in this date range' : ' yet'}.</p>}
      {rows.length > 0 && shown.length === 0 && <p className="muted">Nothing matches those filters in the {rows.length} loaded events.{mayHaveMore ? ' Load more events to search further back.' : ''}</p>}

      {shown.length > 0 && (
        <div className="card aud-tablewrap">
          <table className="aud-table">
            <thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Entity</th><th>ID</th><th>Detail</th></tr></thead>
            <tbody>
              {shown.map((r) => {
                const d = detailText(r.detail), isOpen = open.has(r.id);
                return (
                  <tr key={r.id}>
                    <td className="aud-time">{when(r.at)}</td><td>{r.actor}</td><td><code>{r.action}</code></td><td>{r.entity ?? '—'}</td><td>{r.entity_id ?? '—'}</td>
                    <td className="aud-detail">
                      {!d ? <span className="muted">—</span> : (
                        <>
                          <button type="button" className="aud-more" aria-expanded={isOpen} onClick={() => toggle(r.id)}>{isOpen ? 'Hide' : 'Show'}</button>
                          {isOpen ? <pre>{JSON.stringify(r.detail, null, 2)}</pre> : <span className="aud-snip">{d.length > 70 ? `${d.slice(0, 70)}…` : d}</span>}
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {rows.length > 0 && (
        <div className="row aud-foot">
          <span className="muted">Showing {shown.length}{filtered ? ` of ${rows.length} loaded` : ''} event{shown.length === 1 ? '' : 's'}, newest first.</span>
          {mayHaveMore && <button type="button" onClick={() => setLimit((l) => Math.min(MAX, l + STEP))} disabled={state.loading}>{state.loading ? 'Loading…' : `Load more (${STEP})`}</button>}
          {!mayHaveMore && limit >= MAX && rows.length >= MAX && <span className="muted">That is the most the server returns at once — narrow the date range to see older events.</span>}
        </div>
      )}
    </div>
  );
}
