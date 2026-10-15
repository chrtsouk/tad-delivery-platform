import React, { useEffect, useState } from 'react';
import Modal from './Modal.jsx';
import { get, post } from '../lib/api.js';

const readPhoto = (file) => new Promise((resolve, reject) => {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) return reject(new Error('The photo must be a PNG, JPEG or WebP image.'));
  const img = new Image();
  const url = URL.createObjectURL(file);
  img.onload = () => {                                   // shrink phone photos so they stay well under the 3 MB limit
    const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    URL.revokeObjectURL(url);
    resolve(c.toDataURL('image/jpeg', 0.82));
  };
  img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That photo could not be read.')); };
  img.src = url;
});

/** Log an incident against an order and/or a driver. */
export default function IncidentModal({ orderId = '', orderNumber: lockedNumber = '', driverId = '', drivers = [], onClose, onDone }) {
  const [types, setTypes] = useState({});
  const [type, setType] = useState('');
  const [note, setNote] = useState('');
  const [order, setOrder] = useState('');
  const [driver, setDriver] = useState(driverId || '');
  const [photo, setPhoto] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { get('/api/incidents?limit=1').then((r) => { setTypes(r.types); setType((t) => t || Object.keys(r.types)[0]); }).catch((e) => setErr(e.message)); }, []);

  const pick = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return setPhoto(null);
    try { setPhoto(await readPhoto(f)); setErr(''); } catch (x) { setPhoto(null); setErr(x.message); e.target.value = ''; }
  };
  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    if (!note.trim()) return setErr('Write what happened.');
    if (!orderId && !order.trim() && !driver) return setErr('Choose the order or the driver this is about.');
    setBusy(true); setErr('');
    try {
      await post('/api/incidents', { type, note: note.trim(), ...(orderId ? { order_id: orderId } : order.trim() ? { order_number: order.trim() } : {}), ...(driver ? { driver_id: driver } : {}), ...(photo ? { photo } : {}) });
      onDone?.(); onClose();
    } catch (x) { setErr(x.message); setBusy(false); }
  };
  const lockedOrder = Boolean(orderId);
  return (
    <Modal title={lockedNumber ? `Report an incident — ${lockedNumber}` : 'Report an incident'} onClose={onClose} dismissable={!busy}
      footer={<><button type="button" onClick={onClose} disabled={busy}>Cancel</button><button type="submit" form="inc-form" className="dark" disabled={busy || !type}>{busy ? 'Saving…' : 'Save incident'}</button></>}>
      <form id="inc-form" onSubmit={submit} noValidate>
        <label htmlFor="inc-type">What kind of incident?</label>
        <select id="inc-type" value={type} onChange={(e) => setType(e.target.value)} data-autofocus>{Object.entries(types).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        <label htmlFor="inc-note">What happened?</label>
        <textarea id="inc-note" rows={4} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />
        <div className="add-two">
          {!lockedOrder && <div><label htmlFor="inc-order">Order number (optional)</label><input id="inc-order" value={order} onChange={(e) => setOrder(e.target.value.toUpperCase())} placeholder="TAD-20261015-003" autoComplete="off" /></div>}
          <div><label htmlFor="inc-driver">Driver (optional)</label>
            <select id="inc-driver" value={driver} onChange={(e) => setDriver(e.target.value)}><option value="">No driver</option>{drivers.map((d) => <option key={d.id} value={d.id}>{d.name || d.id}</option>)}</select>
          </div>
        </div>
        <label htmlFor="inc-photo">Photo (optional)</label>
        <input id="inc-photo" type="file" accept="image/png,image/jpeg,image/webp" onChange={pick} />
        {photo && <img src={photo} alt="Preview of the photo to attach" style={{ maxWidth: 200, maxHeight: 150, marginTop: 6, borderRadius: 8 }} />}
        {err && <div className="err" role="alert">{err}</div>}
      </form>
    </Modal>
  );
}
