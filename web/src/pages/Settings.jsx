import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { get, put } from '../lib/api.js';
import '../components/ui.css';
import '../components/pages.css';

const STRATEGIES = [
  ['nearest', 'Nearest driver', 'The free driver who is closest to the shop gets the next run.'],
  ['round_robin', 'Take turns', 'The driver who has waited longest since their last run goes next.'],
  ['fewest_jobs', 'Fairest share', 'The driver with the fewest deliveries today goes next.'],
];
const OUTCODE = /^[A-Z]{1,2}\d[A-Z\d]?$/;
let bandKey = 0;

const str = (v) => (v === null || v === undefined ? '' : String(v));
const pounds = (pence) => (pence / 100).toFixed(2);

/** Settings -> the strings the inputs edit, one group of fields per section. */
const SECTIONS = {
  shop: (s) => ({ store_name: str(s.store.name), store_postcode: str(s.store.postcode), store_address: str(s.store.address), store_phone: str(s.store.phone), store_lat: str(s.store.lat), store_lng: str(s.store.lng) }),
  area: (s) => ({ radius_km: str(s.radius_km), excluded: [...s.excluded_outcodes], bands: s.fee_bands.map((b) => ({ key: ++bandKey, up_to_km: str(b.up_to_km), fee: pounds(b.fee_pence) })), min_order: pounds(s.min_order_pence) }),
  dispatch: (s) => ({ max_tasks: str(s.max_tasks), strategy: s.strategy, max_gap_minutes: str(s.max_gap_minutes), batch_hold_minutes: str(s.batch_hold_minutes), cluster_merge_km: str(s.cluster_merge_km), return_push_minutes: str(s.return_push_minutes), service_minutes_per_drop: str(s.service_minutes_per_drop) }),
  timing: (s) => ({ warn_after_minutes: str(s.warn_after_minutes), late_after_minutes: str(s.late_after_minutes), prep_minutes: str(s.prep_minutes), default_eta_minutes: str(s.default_eta_minutes) }),
  alerts: (s) => ({ show_driver_phone: Boolean(s.show_driver_phone), sound: Boolean(s.sound) }),
};

function num(v, label, min, max, { int = false } = {}) {
  const n = Number(String(v).trim());
  if (String(v).trim() === '' || !Number.isFinite(n)) throw new Error(`${label} must be a number.`);
  if (int && !Number.isInteger(n)) throw new Error(`${label} must be a whole number.`);
  if (n < min || n > max) throw new Error(`${label} must be between ${min} and ${max}.`);
  return n;
}
const penceOf = (v, label) => Math.round(num(v, label, 0, 1000) * 100);

/** The form -> the API payload for one section (throws an Error with a plain message when a value is not valid). */
function payload(section, f, saved) {
  switch (section) {
    case 'shop': {
      if (!f.store_name.trim()) throw new Error('The shop name is needed.');
      return { store: { ...saved.store, name: f.store_name.trim(), postcode: f.store_postcode.trim().toUpperCase(), address: f.store_address.trim(), phone: f.store_phone.trim(), lat: num(f.store_lat, 'Latitude', -90, 90), lng: num(f.store_lng, 'Longitude', -180, 180) } };
    }
    case 'area': {
      const bands = f.bands.map((b, i) => ({ up_to_km: num(b.up_to_km, `Fee band ${i + 1} distance`, 0.1, 200), fee_pence: penceOf(b.fee, `Fee band ${i + 1} fee`) })).sort((a, b) => a.up_to_km - b.up_to_km);
      if (new Set(bands.map((b) => b.up_to_km)).size !== bands.length) throw new Error('Two fee bands have the same distance. Each band needs its own distance.');
      return { radius_km: num(f.radius_km, 'Delivery radius', 0.5, 200), excluded_outcodes: f.excluded, fee_bands: bands, min_order_pence: penceOf(f.min_order || '0', 'Minimum order') };
    }
    case 'dispatch':
      return {
        max_tasks: num(f.max_tasks, 'Max stops per driver', 1, 20, { int: true }), strategy: f.strategy,
        max_gap_minutes: num(f.max_gap_minutes, 'Max minutes between drops', 0, 600), batch_hold_minutes: num(f.batch_hold_minutes, 'Batch hold time', 0, 600),
        cluster_merge_km: num(f.cluster_merge_km, 'Cluster merge distance', 0, 50), return_push_minutes: num(f.return_push_minutes, 'Return alert time', 0, 600),
        service_minutes_per_drop: num(f.service_minutes_per_drop, 'Minutes at each door', 0, 600),
      };
    case 'timing': {
      const warn = num(f.warn_after_minutes, 'Amber warning time', 0, 600), late = num(f.late_after_minutes, 'Late time', 0, 600);
      if (warn >= late) throw new Error('The amber warning must come before the late time.');
      return { warn_after_minutes: warn, late_after_minutes: late, prep_minutes: num(f.prep_minutes, 'Prep time', 0, 600), default_eta_minutes: num(f.default_eta_minutes, 'Default delivery time', 0, 600) };
    }
    default: return { show_driver_phone: f.show_driver_phone, sound: f.sound };
  }
}

function Num({ id, label, value, onChange, suffix, help, step = 'any', min = 0 }) {
  return (
    <div className="set-field">
      <label htmlFor={id}>{label}</label>
      <div className="set-num"><input id={id} type="number" inputMode="decimal" step={step} min={min} value={value} onChange={(e) => onChange(e.target.value)} />{suffix && <span>{suffix}</span>}</div>
      {help && <small className="muted">{help}</small>}
    </div>
  );
}

function Section({ id, title, intro, dirty, st, onSave, onReset, children }) {
  return (
    <section className="card set-section" aria-labelledby={`set-${id}`}>
      <h3 id={`set-${id}`}>{title}</h3>
      {intro && <p className="muted set-intro">{intro}</p>}
      <form onSubmit={(e) => { e.preventDefault(); onSave(); }} noValidate>
        {children}
        {st?.msg && <div className={st.msg.ok ? 'ok' : 'err'} role={st.msg.ok ? 'status' : 'alert'}>{st.msg.text}</div>}
        <div className="row set-save">
          <button type="submit" className="primary" disabled={!dirty || st?.busy}>{st?.busy ? 'Saving…' : 'Save'}</button>
          <button type="button" disabled={!dirty || st?.busy} onClick={onReset}>Discard changes</button>
          {dirty && <span className="muted">Unsaved changes</span>}
        </div>
      </form>
    </section>
  );
}

function OutcodeInput({ value, onChange }) {
  const [text, setText] = useState('');
  const [err, setErr] = useState('');
  const add = (raw) => {
    const parts = raw.toUpperCase().split(/[\s,;]+/).filter(Boolean);
    if (!parts.length) return;
    const bad = parts.find((p) => !OUTCODE.test(p));
    if (bad) { setErr(`"${bad}" is not a postcode district. Use the first part of a postcode, like SW4 or E1.`); return; }
    setErr(''); setText('');
    onChange([...new Set([...value, ...parts])]);
  };
  return (
    <div className="set-field">
      <label htmlFor="set-outcodes">Postcode districts we never deliver to</label>
      <div className="set-tags" onClick={() => document.getElementById('set-outcodes')?.focus()}>
        {value.map((o) => <span className="set-tag" key={o}>{o}<button type="button" aria-label={`Remove ${o}`} onClick={() => onChange(value.filter((x) => x !== o))}>×</button></span>)}
        <input id="set-outcodes" value={text} placeholder={value.length ? '' : 'Type SW4 and press Enter'} autoCapitalize="characters"
          onChange={(e) => { const v = e.target.value; if (/[,;\s]$/.test(v)) add(v); else setText(v.toUpperCase()); }}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(text); } else if (e.key === 'Backspace' && !text && value.length) onChange(value.slice(0, -1)); }}
          onBlur={() => text && add(text)} />
      </div>
      {err && <div className="err" role="alert">{err}</div>}
      <small className="muted">Orders to these districts are refused, even inside the radius.</small>
    </div>
  );
}

function Badge({ on, yes = 'On', no = 'Off' }) { return <span className={`ui-badge ${on ? 'on' : 'off'}`}>{on ? yes : no}</span>; }

function Integrations() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [hub, setHub] = useState({ busy: false, msg: null, url: '' });
  useEffect(() => { get('/api/integrations').then(setData).catch((e) => setErr(e.message)); }, []);
  const connect = async () => {
    setHub({ busy: true, msg: null, url: '' });
    try {
      const { url } = await get('/api/hubrise/connect');
      const w = window.open(url, '_blank', 'noopener');
      setHub({ busy: false, url: w ? '' : url, msg: { ok: true, text: w ? 'HubRise opened in a new tab. Approve access there, then come back and reload this page.' : 'The browser blocked the new tab. Use the link below.' } });
    } catch (e) { setHub({ busy: false, url: '', msg: { ok: false, text: e.code === 'not_configured' ? 'HubRise is not set up on the server yet (it needs a HubRise client ID and secret).' : e.message } }); }
  };
  const row = (name, status, note, action) => <li key={name}><div><strong>{name}</strong>{note && <div className="muted">{note}</div>}</div><div className="set-int-r">{status}{action}</div></li>;
  return (
    <section className="card set-section" aria-labelledby="set-int">
      <h3 id="set-int">Integrations</h3>
      <p className="muted set-intro">Connections to other systems. Keys and secrets are set on the server, not here.</p>
      {err && <div className="err" role="alert">Could not load integrations: {err}</div>}
      {!data && !err && <p className="muted"><span className="ui-spin" /> Loading…</p>}
      {data && (
        <ul className="set-int">
          {row('HubRise', data.hubrise.connected ? <span className="ui-badge on">Connected</span> : data.hubrise.configured ? <span className="ui-badge warn">Not connected yet</span> : <span className="ui-badge off">Not set up on the server</span>,
            'Brings in orders from your till and delivery apps.',
            <button type="button" className={data.hubrise.connected ? '' : 'primary'} disabled={!data.hubrise.configured || hub.busy} onClick={connect} title={data.hubrise.configured ? '' : 'The server needs a HubRise client ID and secret first'}>{hub.busy ? 'Opening…' : data.hubrise.connected ? 'Reconnect' : 'Connect'}</button>)}
          {row('Management hub', <Badge on={data.hub.enabled} yes="Connected" no="Not connected" />, 'Shares customer-privacy requests and settings with the management hub.')}
          {row('Label printer', <Badge on={data.printer} yes="Set up" no="Not set up" />, 'Prints the QR bag labels. Without it you can still print from the browser.')}
          {row('Email', <Badge on={data.email} yes="Set up" no="Not set up" />, 'Order updates to customers.')}
          {row('Web push', <Badge on={data.push} yes="Set up" no="Not set up" />, 'Notifications to drivers and customers.')}
          {[['uberEats', 'Uber Eats'], ['deliveroo', 'Deliveroo'], ['justEat', 'Just Eat']].map(([k, n]) => row(n, <Badge on={Boolean(data.platforms?.[k])} />, 'Needs approved API keys — set on the server.'))}
        </ul>
      )}
      {hub.msg && <div className={hub.msg.ok ? 'ok' : 'err'} role="status">{hub.msg.text} {hub.url && <a href={hub.url} target="_blank" rel="noreferrer">Open HubRise</a>}</div>}
    </section>
  );
}

export default function Settings() {
  const [saved, setSaved] = useState(null);
  const [form, setForm] = useState(null);
  const [err, setErr] = useState('');
  const [st, setSt] = useState({});

  const load = useCallback(async () => {
    try {
      const s = await get('/api/settings');
      setSaved(s);
      setForm(Object.assign({}, ...Object.values(SECTIONS).map((f) => f(s))));
      setErr('');
    } catch (e) { setErr(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const dirty = useMemo(() => {
    if (!saved || !form) return {};
    const strip = (o) => JSON.stringify(o, (k, v) => (k === 'key' ? undefined : v));
    return Object.fromEntries(Object.entries(SECTIONS).map(([name, fn]) => {
      const fresh = fn(saved);
      const mine = Object.fromEntries(Object.keys(fresh).map((k) => [k, form[k]]));
      return [name, strip(fresh) !== strip(mine)];
    }));
  }, [saved, form]);

  const save = async (section) => {
    setSt((x) => ({ ...x, [section]: { busy: true } }));
    try {
      const body = payload(section, form, saved);
      const s = await put('/api/settings', body);
      setSaved(s);
      set(SECTIONS[section](s));
      setSt((x) => ({ ...x, [section]: { msg: { ok: true, text: 'Saved. The new settings are live.' } } }));
    } catch (e) { setSt((x) => ({ ...x, [section]: { msg: { ok: false, text: e.message } } })); }
  };
  const reset = (section) => { set(SECTIONS[section](saved)); setSt((x) => ({ ...x, [section]: {} })); };
  const sec = (name) => ({ dirty: Boolean(dirty[name]), st: st[name], onSave: () => save(name), onReset: () => reset(name) });

  if (err && !form) return <div className="err" role="alert">Could not load settings: {err} <button type="button" onClick={load}>Try again</button></div>;
  if (!form) return <p className="muted"><span className="ui-spin" /> Loading settings…</p>;

  const strat = STRATEGIES.find((x) => x[0] === form.strategy);
  return (
    <div className="set">
      <h2>Settings</h2>

      <Section id="shop" title="Shop" intro="Where the food leaves from. Drivers' routes and the delivery radius are measured from here." {...sec('shop')}>
        <div className="set-grid">
          <div className="set-field"><label htmlFor="s-name">Shop name</label><input id="s-name" value={form.store_name} onChange={(e) => set({ store_name: e.target.value })} /></div>
          <div className="set-field"><label htmlFor="s-phone">Shop phone</label><input id="s-phone" type="tel" value={form.store_phone} onChange={(e) => set({ store_phone: e.target.value })} /></div>
          <div className="set-field"><label htmlFor="s-addr">Address</label><input id="s-addr" value={form.store_address} onChange={(e) => set({ store_address: e.target.value })} /></div>
          <div className="set-field"><label htmlFor="s-pc">Postcode</label><input id="s-pc" value={form.store_postcode} onChange={(e) => set({ store_postcode: e.target.value.toUpperCase() })} /></div>
          <Num id="s-lat" label="Latitude" value={form.store_lat} onChange={(v) => set({ store_lat: v })} min={-90} step="any" help="Used for distances and the map." />
          <Num id="s-lng" label="Longitude" value={form.store_lng} onChange={(v) => set({ store_lng: v })} min={-180} step="any" />
        </div>
      </Section>

      <Section id="area" title="Delivery area and fees" intro="Orders outside the radius, or in an excluded district, are refused." {...sec('area')}>
        <div className="set-grid">
          <Num id="a-radius" label="Delivery radius" value={form.radius_km} onChange={(v) => set({ radius_km: v })} suffix="km" min={0.5} />
          <Num id="a-min" label="Minimum order" value={form.min_order} onChange={(v) => set({ min_order: v })} suffix="£" step="0.01" help="0 means no minimum." />
        </div>
        <OutcodeInput value={form.excluded} onChange={(excluded) => set({ excluded })} />
        <div className="set-field">
          <span className="set-lbl">Delivery fee bands</span>
          {form.bands.length === 0 && <p className="muted">No fee bands: delivery is free everywhere. Add a band to charge by distance.</p>}
          {form.bands.map((b, i) => (
            <div className="set-band" key={b.key}>
              <span>Up to</span>
              <div className="set-num"><input type="number" inputMode="decimal" min="0.1" step="any" aria-label={`Band ${i + 1} up to km`} value={b.up_to_km} onChange={(e) => set({ bands: form.bands.map((x) => (x.key === b.key ? { ...x, up_to_km: e.target.value } : x)) })} /><span>km</span></div>
              <span>costs</span>
              <div className="set-num"><span>£</span><input type="number" inputMode="decimal" min="0" step="0.01" aria-label={`Band ${i + 1} fee in pounds`} value={b.fee} onChange={(e) => set({ bands: form.bands.map((x) => (x.key === b.key ? { ...x, fee: e.target.value } : x)) })} /></div>
              <button type="button" aria-label={`Remove band ${i + 1}`} onClick={() => set({ bands: form.bands.filter((x) => x.key !== b.key) })}>Remove</button>
            </div>
          ))}
          <button type="button" onClick={() => set({ bands: [...form.bands, { key: ++bandKey, up_to_km: '', fee: '' }] })}>+ Add a fee band</button>
        </div>
      </Section>

      <Section id="dispatch" title="Dispatch" intro="How orders are grouped into runs and handed to drivers." {...sec('dispatch')}>
        <div className="set-grid">
          <Num id="d-tasks" label="Max stops per driver" value={form.max_tasks} onChange={(v) => set({ max_tasks: v })} min={1} step="1" help="The most drops one driver takes on a run." />
          <Num id="d-gap" label="Max minutes between drops" value={form.max_gap_minutes} onChange={(v) => set({ max_gap_minutes: v })} suffix="min" help="A run is split if two drops are further apart than this." />
          <Num id="d-hold" label="Batch hold time" value={form.batch_hold_minutes} onChange={(v) => set({ batch_hold_minutes: v })} suffix="min" help="How long to wait for a run to fill before sending it part-full." />
          <Num id="d-merge" label="Group nearby districts within" value={form.cluster_merge_km} onChange={(v) => set({ cluster_merge_km: v })} suffix="km" help="Districts closer than this are batched together." />
          <Num id="d-return" label="Tell a returning driver" value={form.return_push_minutes} onChange={(v) => set({ return_push_minutes: v })} suffix="min before they are back" help="Sends “pick up your next orders” this long before they return." />
          <Num id="d-svc" label="Time at each door" value={form.service_minutes_per_drop} onChange={(v) => set({ service_minutes_per_drop: v })} suffix="min" />
        </div>
        <div className="set-field">
          <label htmlFor="d-strat">Who gets the next run</label>
          <select id="d-strat" value={form.strategy} onChange={(e) => set({ strategy: e.target.value })}>{STRATEGIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          {strat && <small className="muted">{strat[2]}</small>}
        </div>
      </Section>

      <Section id="timing" title="Timing" intro="When an order turns amber and red on the board, and what customers are told." {...sec('timing')}>
        <div className="set-grid">
          <Num id="t-warn" label="Turns amber after" value={form.warn_after_minutes} onChange={(v) => set({ warn_after_minutes: v })} suffix="min" />
          <Num id="t-late" label="Counts as late after" value={form.late_after_minutes} onChange={(v) => set({ late_after_minutes: v })} suffix="min" help="Measured from when the order was accepted." />
          <Num id="t-prep" label="Prep time" value={form.prep_minutes} onChange={(v) => set({ prep_minutes: v })} suffix="min" help="Pre-orders appear on the board this long before they are due." />
          <Num id="t-eta" label="Default delivery time" value={form.default_eta_minutes} onChange={(v) => set({ default_eta_minutes: v })} suffix="min" help="The estimate shown to customers." />
        </div>
      </Section>

      <Section id="alerts" title="Customers and alerts" {...sec('alerts')}>
        <label className="set-check"><input type="checkbox" checked={form.show_driver_phone} onChange={(e) => set({ show_driver_phone: e.target.checked })} /> Show the driver’s phone number to customers on the tracking page</label>
        <label className="set-check"><input type="checkbox" checked={form.sound} onChange={(e) => set({ sound: e.target.checked })} /> Play sounds on the board for new and late orders</label>
      </Section>

      <Integrations />
    </div>
  );
}
