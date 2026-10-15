import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import dayjs from 'dayjs';
import { get, post } from '../lib/api.js';
import { printProblem } from '../board/format.js';
import '../components/ui.css';
import '../components/pages.css';

const QUICK = ['Wings', 'Tenders', 'Burger', 'Fries', 'Mega box', 'Drink'];
const GROUPS = [['address_book', 'Saved addresses'], ['postcode', 'Postcode'], ['photon', 'Address search']];
let rowKey = 0;
const newRow = (name = '', qty = 1) => ({ key: ++rowKey, name, qty });
const digits = (s) => String(s || '').replace(/\D/g, '');
const localInput = (d) => dayjs(d).format('YYYY-MM-DDTHH:mm');

function useDebounced(value, ms) {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

export default function AddOrder() {
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [fulfilment, setFulfilment] = useState('delivery');
  const [line1, setLine1] = useState('');
  const [postcode, setPostcode] = useState('');
  const [geo, setGeo] = useState(null);
  const [items, setItems] = useState(() => [newRow()]);
  const [notes, setNotes] = useState('');
  const [later, setLater] = useState(false);
  const [when, setWhen] = useState('');
  const [total, setTotal] = useState('');
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [searchErr, setSearchErr] = useState('');
  const [book, setBook] = useState({ list: [], loading: false, err: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null);
  const [printMsg, setPrintMsg] = useState(null);
  const [fields, setFields] = useState([]);
  const [custom, setCustom] = useState({});
  const [flag, setFlag] = useState(null);
  const [warnings, setWarnings] = useState([]);
  const phoneRef = useRef(null);
  const reqBook = useRef(0);
  const reqSearch = useRef(0);

  const dPhone = useDebounced(phone, 250);
  const dQ = useDebounced(q, 250);
  const dLine1 = useDebounced(line1, 400);
  const dPostcode = useDebounced(postcode, 400);

  useEffect(() => { get('/api/settings').then((s) => setFields(s.custom_fields || [])).catch(() => {}); }, []);

  /* is this phone or address flagged / blocked? */
  useEffect(() => {
    const p = digits(dPhone).length >= 6 ? dPhone : '';
    const a = fulfilment === 'delivery' && dLine1.trim() && dPostcode.trim().length >= 5;
    if (!p && !a) { setFlag(null); return undefined; }
    let live = true;
    const qs = new URLSearchParams({ ...(p ? { phone: p } : {}), ...(a ? { line1: dLine1.trim(), postcode: dPostcode.trim() } : {}) });
    get(`/api/flags/check?${qs}`).then((r) => live && setFlag(r.level ? r : null)).catch(() => live && setFlag(null));
    return () => { live = false; };
  }, [dPhone, dLine1, dPostcode, fulfilment]);

  /* address book by phone: as soon as 6+ digits are typed */
  useEffect(() => {
    if (digits(dPhone).length < 6) { setBook({ list: [], loading: false, err: '' }); return; }
    const id = ++reqBook.current;
    setBook((b) => ({ ...b, loading: true, err: '' }));
    get(`/api/address/search?phone=${encodeURIComponent(dPhone)}`)
      .then((r) => { if (id === reqBook.current) setBook({ list: r.results.filter((x) => x.from === 'address_book'), loading: false, err: '' }); })
      .catch((e) => { if (id === reqBook.current) setBook({ list: [], loading: false, err: e.message }); });
  }, [dPhone]);

  /* address search box */
  useEffect(() => {
    if (dQ.trim().length < 3) { setResults([]); setSearching(false); setSearchErr(''); return; }
    const id = ++reqSearch.current;
    setSearching(true); setSearchErr('');
    get(`/api/address/search?q=${encodeURIComponent(dQ.trim())}${digits(phone).length >= 6 ? `&phone=${encodeURIComponent(phone)}` : ''}`)
      .then((r) => { if (id === reqSearch.current) { setResults(r.results); setSearching(false); } })
      .catch((e) => { if (id === reqSearch.current) { setResults([]); setSearching(false); setSearchErr(e.message); } });
  }, [dQ]); // eslint-disable-line react-hooks/exhaustive-deps

  const pick = useCallback((r) => {
    setError(null);
    if (r.from === 'postcode') { setPostcode(r.postcode || ''); setGeo(null); }
    else {
      if (r.line1) setLine1(r.line1);
      if (r.postcode) setPostcode(r.postcode);
      setGeo(typeof r.lat === 'number' && typeof r.lng === 'number' && r.postcode ? { lat: r.lat, lng: r.lng } : null);
      if (r.name) setName((n) => n || r.name);
    }
    setQ(''); setResults([]);
  }, []);

  const pickBook = (a) => { setName(a.name || name); setLine1(a.line1); setPostcode(a.postcode); setGeo(typeof a.lat === 'number' && typeof a.lng === 'number' ? { lat: a.lat, lng: a.lng } : null); setFulfilment('delivery'); setError(null); };

  const setItem = (key, patch) => setItems((l) => l.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const quickAdd = (label) => setItems((l) => {
    const hit = l.find((r) => r.name.trim().toLowerCase() === label.toLowerCase());
    if (hit) return l.map((r) => (r === hit ? { ...r, qty: Math.min(99, r.qty + 1) } : r));
    const empty = l.findIndex((r) => !r.name.trim());
    return empty >= 0 ? l.map((r, i) => (i === empty ? { ...r, name: label } : r)) : [...l, newRow(label)];
  });

  const reset = () => {
    setPhone(''); setName(''); setEmail(''); setFulfilment('delivery'); setLine1(''); setPostcode(''); setGeo(null); setItems([newRow()]); setNotes('');
    setLater(false); setWhen(''); setTotal(''); setQ(''); setResults([]); setError(null); setDone(null); setPrintMsg(null); setCustom({}); setFlag(null); setWarnings([]);
    setTimeout(() => phoneRef.current?.focus(), 0);
  };

  const submit = async (e, { override = false } = {}) => {
    e?.preventDefault();
    if (busy) return;
    for (const f of fields) if (f.required && f.type !== 'checkbox' && !String(custom[f.key] ?? '').trim()) return setError({ message: `${f.label} is needed.`, field: `cf-${f.key}` });
    const rows = items.map((r) => ({ name: r.name.trim(), qty: Math.max(1, Math.round(Number(r.qty) || 1)) })).filter((r) => r.name);
    if (!rows.length) return setError({ message: 'Add at least one item.', field: 'items' });
    if (fulfilment === 'delivery' && !line1.trim()) return setError({ message: 'The delivery address is needed.', field: 'address' });
    if (fulfilment === 'delivery' && !postcode.trim()) return setError({ message: 'The postcode is needed.', field: 'address' });
    let scheduled_for;
    if (later) {
      if (!when || Number.isNaN(Date.parse(when))) return setError({ message: 'Pick the date and time for the pre-order.', field: 'when' });
      if (Date.parse(when) <= Date.now()) return setError({ message: 'The pre-order time must be in the future.', field: 'when' });
      scheduled_for = new Date(when).toISOString();
    }
    let total_pence;
    if (total.trim() !== '') {
      const p = Number(total.replace(/[£,\s]/g, ''));
      if (!Number.isFinite(p) || p < 0) return setError({ message: 'The total must be an amount like 18.50.', field: 'total' });
      total_pence = Math.round(p * 100);
    }
    const body = {
      fulfilment, paid: true, items: rows,
      customer: Object.fromEntries(Object.entries({ name: name.trim(), phone: phone.trim(), email: email.trim() }).filter(([, v]) => v)),
      notes: notes.trim() || undefined, total_pence, scheduled_for, custom, ...(override ? { override_block: true } : {}),
    };
    if (fulfilment === 'delivery') body.address = { line1: line1.trim(), postcode: postcode.trim(), ...(geo || {}) };
    setBusy(true); setError(null);
    try { const r = await post('/api/orders', body); setWarnings(r.warnings || []); setDone(r.order); }
    catch (x) { setError({ message: x.message, code: x.code, field: x.code === 'outside_area' || x.code === 'unknown_postcode' ? 'address' : undefined }); }
    finally { setBusy(false); }
  };

  const printLabel = async () => {
    setPrintMsg(null);
    window.open(`/api/orders/${done.id}/label`, '_blank', 'noopener');
    try { await post(`/api/orders/${done.id}/print`); setPrintMsg({ ok: true, text: 'Label sent to the printer.' }); }
    catch (x) { setPrintMsg({ ok: false, text: printProblem(x) }); }
  };

  if (done) {
    return (
      <div className="add add-done card">
        <p className="muted">Order added</p>
        <div className="add-done-no" aria-live="polite">{done.number}</div>
        <p>{done.state === 'scheduled' ? `Pre-order for ${dayjs(done.scheduled_for).format('dddd D MMMM, HH:mm')}. It will appear on the board shortly before then.` : done.fulfilment === 'collection' ? 'Collection order. It is waiting on the board.' : 'Delivery order. It is waiting on the board.'}</p>
        <div className="row add-done-btns">
          <button type="button" className="dark" onClick={printLabel} data-autofocus>Print label</button>
          <button type="button" className="primary" onClick={reset}>Add another</button>
          <Link to="/" className="btn">Back to the board</Link>
        </div>
        {warnings.map((w, i) => <div key={i} className="err" role="status">{w.override ? 'Added over a block' : w.level === 'blocked' ? 'Blocked customer' : 'Flagged customer'}: {w.reasons.join('; ')}</div>)}
        {printMsg && <div className={printMsg.ok ? 'ok' : 'err'} role="status">{printMsg.text}</div>}
      </div>
    );
  }

  const fieldErr = (f) => (error?.field === f ? <div className="err" role="alert">{error.message}</div> : null);
  const grouped = GROUPS.map(([key, title]) => [title, results.filter((r) => r.from === key)]).filter(([, l]) => l.length);
  const hasPhone = digits(phone).length >= 6;

  return (
    <form className="add" onSubmit={submit} noValidate>
      <h2>Add a new order</h2>
      <p className="muted">For orders taken by phone or in person. The customer has already paid online.</p>
      {error && !error.field && <div className="err" role="alert">{error.message}</div>}
      {flag && (
        <div className={`add-flag ${flag.level}`} role="alert">
          <strong>{flag.level === 'blocked' ? 'Blocked: this customer or address cannot order.' : 'Flagged: take care with this customer or address.'}</strong>
          {flag.matches.map((m) => <div key={m.id}>{m.kind === 'phone' ? 'Phone' : 'Address'}: {m.reason}</div>)}
          {flag.level === 'blocked' && <div className="row" style={{ marginTop: 6 }}><span>You can still add the order if you are sure.</span><button type="button" className="danger" disabled={busy} onClick={() => submit(null, { override: true })}>Add anyway (override block)</button></div>}
        </div>
      )}

      <div className="add-grid">
        <section className="card">
          <h3>Customer</h3>
          <label htmlFor="add-phone">Phone</label>
          <input id="add-phone" ref={phoneRef} type="tel" inputMode="tel" autoComplete="off" autoFocus value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="07700 900123" />
          {hasPhone && (
            <div className="add-book" aria-live="polite">
              {book.loading && <span className="muted"><span className="ui-spin" /> Looking for saved addresses…</span>}
              {book.err && <span className="muted">Could not check saved addresses: {book.err}</span>}
              {!book.loading && !book.err && book.list.length === 0 && <span className="muted">New number: no saved addresses yet.</span>}
              {book.list.map((a, i) => (
                <button type="button" key={i} className="add-chip" onClick={() => pickBook(a)} title="Fill the form from this saved address">
                  <strong>{a.name || 'Saved address'}</strong><span>{a.label}</span>{a.uses > 1 && <em>used {a.uses}×</em>}
                </button>
              ))}
            </div>
          )}
          <div className="add-two">
            <div><label htmlFor="add-name">Name</label><input id="add-name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" /></div>
            <div><label htmlFor="add-email">Email (optional)</label><input id="add-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" /></div>
          </div>

          <div className="add-seg" role="radiogroup" aria-label="Delivery or collection">
            {[['delivery', 'Delivery'], ['collection', 'Collection']].map(([v, l]) => (
              <button type="button" key={v} role="radio" aria-checked={fulfilment === v} className={fulfilment === v ? 'on' : ''} onClick={() => { setFulfilment(v); setError(null); }}>{l}</button>
            ))}
          </div>

          {fulfilment === 'delivery' && (
            <>
              <label htmlFor="add-q">Find an address</label>
              <div className="add-search">
                <input id="add-q" value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" placeholder="Start typing a street or postcode" role="combobox" aria-expanded={results.length > 0} aria-controls="add-results"
                  onKeyDown={(e) => { if (e.key === 'Enter' && results.length) { e.preventDefault(); pick(results[0]); } if (e.key === 'Escape') setResults([]); }} />
                {(searching || searchErr || grouped.length > 0 || q.trim().length >= 3) && (
                  <div className="add-results" id="add-results" role="listbox">
                    {searching && <div className="muted add-res-note"><span className="ui-spin" /> Searching…</div>}
                    {searchErr && <div className="add-res-note err">{searchErr}</div>}
                    {!searching && !searchErr && grouped.length === 0 && dQ.trim().length >= 3 && <div className="muted add-res-note">No matches. Type the address into the boxes below.</div>}
                    {grouped.map(([title, list]) => (
                      <div key={title}>
                        <div className="add-res-h">{title}</div>
                        {list.map((r, i) => <button type="button" role="option" aria-selected="false" key={i} className="add-res" onClick={() => pick(r)}>{r.label}{r.from === 'address_book' && r.name ? <em> · {r.name}</em> : null}</button>)}
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div className="add-two add-addr">
                <div><label htmlFor="add-line1">Address</label><input id="add-line1" value={line1} onChange={(e) => { setLine1(e.target.value); setGeo(null); }} autoComplete="off" placeholder="House number and street" /></div>
                <div><label htmlFor="add-pc">Postcode</label><input id="add-pc" value={postcode} onChange={(e) => { setPostcode(e.target.value.toUpperCase()); setGeo(null); }} autoComplete="off" placeholder="SW11 1AB" /></div>
              </div>
              {fieldErr('address')}
            </>
          )}
        </section>

        <section className="card">
          <h3>Items</h3>
          <div className="add-quick" aria-label="Quick add">
            {QUICK.map((l) => <button type="button" key={l} onClick={() => quickAdd(l)}>+ {l}</button>)}
          </div>
          <datalist id="add-common">{QUICK.map((l) => <option key={l} value={l} />)}</datalist>
          <div className="add-items">
            {items.map((r, i) => (
              <div className="add-item" key={r.key}>
                <input list="add-common" aria-label={`Item ${i + 1} name`} value={r.name} onChange={(e) => setItem(r.key, { name: e.target.value })} placeholder="Item" autoComplete="off" />
                <div className="add-qty" role="group" aria-label={`Quantity for item ${i + 1}`}>
                  <button type="button" aria-label="One fewer" disabled={r.qty <= 1} onClick={() => setItem(r.key, { qty: r.qty - 1 })}>−</button>
                  <input type="number" min="1" max="99" inputMode="numeric" aria-label="Quantity" value={r.qty} onChange={(e) => setItem(r.key, { qty: e.target.value === '' ? '' : Math.max(1, Math.min(99, Number(e.target.value))) })} />
                  <button type="button" aria-label="One more" onClick={() => setItem(r.key, { qty: Math.min(99, (Number(r.qty) || 0) + 1) })}>+</button>
                </div>
                <button type="button" className="add-del" aria-label={`Remove item ${i + 1}`} disabled={items.length === 1 && !r.name} onClick={() => setItems((l) => (l.length === 1 ? [newRow()] : l.filter((x) => x.key !== r.key)))}>×</button>
              </div>
            ))}
          </div>
          <button type="button" onClick={() => setItems((l) => [...l, newRow()])}>+ Add another item</button>
          {fieldErr('items')}

          <label htmlFor="add-notes" className="add-gap">Notes for the kitchen / driver</label>
          <textarea id="add-notes" rows={2} value={notes} maxLength={500} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. Ring the top bell, no mayo" />

          {fields.length > 0 && (
            <div className="add-custom add-gap">
              {fields.map((f) => {
                const id = `cf-${f.key}`;
                const val = custom[f.key];
                const set = (v) => setCustom((c) => ({ ...c, [f.key]: v }));
                return (
                  <div key={f.key}>
                    {f.type === 'checkbox'
                      ? <label className="add-check"><input type="checkbox" id={id} checked={val === true} onChange={(e) => set(e.target.checked)} /> {f.label}</label>
                      : <label htmlFor={id}>{f.label}{f.required ? '' : ' (optional)'}</label>}
                    {f.type === 'text' && <input id={id} value={val ?? ''} maxLength={200} onChange={(e) => set(e.target.value)} autoComplete="off" />}
                    {f.type === 'number' && <input id={id} type="number" inputMode="decimal" step="any" value={val ?? ''} onChange={(e) => set(e.target.value)} />}
                    {f.type === 'choice' && <select id={id} value={val ?? ''} onChange={(e) => set(e.target.value)}><option value="">Choose…</option>{f.choices.map((c) => <option key={c} value={c}>{c}</option>)}</select>}
                    {fieldErr(id)}
                  </div>
                );
              })}
            </div>
          )}

          <div className="add-two add-gap">
            <div>
              <label htmlFor="add-total">Order total, £ (optional)</label>
              <input id="add-total" inputMode="decimal" value={total} onChange={(e) => setTotal(e.target.value)} placeholder="18.50" />
              {fieldErr('total')}
            </div>
            <div>
              <label className="add-check"><input type="checkbox" checked={later} onChange={(e) => { setLater(e.target.checked); if (e.target.checked && !when) setWhen(localInput(dayjs().add(1, 'hour'))); }} /> Schedule for later</label>
              {later && <><input type="datetime-local" aria-label="Pre-order date and time" min={localInput(new Date())} value={when} onChange={(e) => setWhen(e.target.value)} />{fieldErr('when')}</>}
            </div>
          </div>
        </section>
      </div>

      <div className="add-bar">
        <button type="submit" className="primary add-submit" disabled={busy}>{busy ? 'Adding…' : later ? 'Add pre-order' : 'Add order'}</button>
        <button type="button" onClick={reset} disabled={busy}>Clear form</button>
      </div>
    </form>
  );
}
