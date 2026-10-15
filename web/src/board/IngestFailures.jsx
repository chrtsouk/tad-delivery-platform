import { useEffect, useState } from 'react';
import { get, post } from '../lib/api.js';

/** Incoming platform orders (HubRise…) that could not be created — kept so none is lost; retry or dismiss. */
export default function IngestFailures({ count, onChanged }) {
  const [rows, setRows] = useState([]);
  const [msg, setMsg] = useState('');
  useEffect(() => { if (count) get('/api/ingest/failures').then((r) => setRows(r.failures)).catch(() => {}); else setRows([]); }, [count]);
  if (!count || !rows.length) return null;
  const retry = async (id) => { try { await post(`/api/ingest/failures/${id}/retry`); setMsg(''); onChanged?.(); } catch (e) { setMsg(e.message); } };
  const dismiss = async (id) => { await post(`/api/ingest/failures/${id}/dismiss`); onChanged?.(); };
  return (
    <div className="brd-late" role="alert" style={{ background: '#fdf3d8', borderColor: '#e6c36a', color: '#5c4400' }}>
      <strong>{rows.length} incoming order{rows.length > 1 ? 's' : ''} could not be created.</strong>
      {rows.map((f) => (
        <div key={f.id} className="row" style={{ marginTop: 6 }}>
          <span>{f.source} {f.external_id || ''} — {f.error}</span>
          <button type="button" onClick={() => retry(f.id)}>Retry</button>
          <button type="button" onClick={() => dismiss(f.id)}>Dismiss</button>
        </div>
      ))}
      {msg && <div className="err" style={{ marginTop: 6 }}>{msg}</div>}
    </div>
  );
}
