import React, { useCallback, useEffect, useState } from 'react';
import dayjs from 'dayjs';
import { get, post } from '../lib/api.js';
import FlagModal from '../components/FlagModal.jsx';
import AskDialog from '../components/AskDialog.jsx';
import { useToasts } from '../components/Toasts.jsx';
import '../components/ui.css';
import '../components/pages.css';

export default function Flags() {
  const { toast, node } = useToasts();
  const [flags, setFlags] = useState(null);
  const [all, setAll] = useState(false);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const [dialog, setDialog] = useState(null);

  const load = useCallback(async () => {
    try { setFlags((await get(`/api/flags${all ? '?all=1' : ''}`)).flags); setError(''); } catch (e) { setError(e.message); }
  }, [all]);
  useEffect(() => { load(); }, [load]);

  const blocked = flags?.filter((f) => !f.cleared_at && f.level === 'blocked').length ?? 0;
  const flagged = flags?.filter((f) => !f.cleared_at && f.level === 'flagged').length ?? 0;
  return (
    <div className="flg">
      <div className="row">
        <h2 style={{ margin: 0 }}>Flagged and blocked</h2>
        {flags && <span className="muted">{blocked} blocked · {flagged} flagged</span>}
        <span style={{ flex: 1 }} />
        <label className="set-check"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Show cleared</label>
        <button type="button" className="primary" onClick={() => setAdding(true)}>Flag or block…</button>
      </div>
      <p className="muted">A blocked phone number or address cannot place a new order on the website or on Add order (you can override on Add order). A flagged one only shows a warning.</p>
      {error && <div className="err" role="alert">{error}</div>}
      {!flags && !error && <p className="muted"><span className="ui-spin" /> Loading…</p>}
      {flags?.length === 0 && <p className="ui-empty card">Nobody is flagged or blocked. You can flag a customer from an order card (⋯ → Flag customer) or here.</p>}
      <div className="flg-list">
        {flags?.map((f) => (
          <article key={f.id} className={`flg-item ${f.level}${f.cleared_at ? ' cleared' : ''}`}>
            <div>
              <strong>{f.level === 'blocked' ? 'Blocked' : 'Flagged'} {f.kind === 'phone' ? 'phone' : 'address'}: {f.label}</strong>
              <div>{f.reason}</div>
              <div className="muted">Added {dayjs(f.created_at).format('D MMM YYYY HH:mm')} by {f.created_by}{f.cleared_at ? ` · cleared ${dayjs(f.cleared_at).format('D MMM YYYY HH:mm')}` : ''}</div>
            </div>
            {!f.cleared_at && <button type="button" onClick={() => setDialog({ title: `Clear this ${f.level === 'blocked' ? 'block' : 'flag'}?`, body: `${f.label} will be able to order normally again.`, confirmText: 'Clear', onSubmit: async () => { await post(`/api/flags/${f.id}/clear`); toast('Cleared', 'ok'); await load(); } })}>Clear</button>}
          </article>
        ))}
      </div>
      {adding && <FlagModal onClose={() => setAdding(false)} onDone={() => { toast('Saved', 'ok'); load(); }} />}
      {dialog && <AskDialog {...dialog} onClose={() => setDialog(null)} />}
      {node}
    </div>
  );
}
