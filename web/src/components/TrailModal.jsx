import React, { useEffect, useMemo, useRef, useState } from 'react';
import dayjs from 'dayjs';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import Modal from './Modal.jsx';
import { get } from '../lib/api.js';
import { baseStyle } from '../lib/map.js';

maplibregl.setWorkerUrl(workerUrl);
const STYLE = { ...baseStyle, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#e9e9e4' } }, ...baseStyle.layers] };
const LABEL = { assigned: 'collecting', out: 'out', done: 'finished', planned: 'planned' };

/** Replay a driver's saved GPS trail: pick a past run (or "all of today"), scrub or play it on the map. */
export default function TrailModal({ driver, onClose }) {
  const [runs, setRuns] = useState(null);
  const [sel, setSel] = useState('');                       // '' = last 24 hours, otherwise a run id
  const [trail, setTrail] = useState(null);
  const [err, setErr] = useState('');
  const [pos, setPos] = useState(0);
  const [playing, setPlaying] = useState(false);
  const box = useRef(null);
  const mapRef = useRef(null);
  const marker = useRef(null);
  const [ready, setReady] = useState(false);

  useEffect(() => { get(`/api/drivers/${encodeURIComponent(driver.id)}/runs`).then(setRuns).catch((e) => setErr(e.message)); }, [driver.id]);
  useEffect(() => {
    let live = true;
    setTrail(null); setPos(0); setPlaying(false);
    const qs = sel ? `batch_id=${sel}` : `from=${encodeURIComponent(new Date(Date.now() - 86400000).toISOString())}`;
    get(`/api/drivers/${encodeURIComponent(driver.id)}/trail?${qs}`).then((t) => { if (live) { setTrail(t); setPos(Math.max(0, t.points.length - 1)); setErr(''); } }).catch((e) => live && setErr(e.message));
    return () => { live = false; };
  }, [driver.id, sel]);

  useEffect(() => {
    let map;
    try { map = new maplibregl.Map({ container: box.current, style: STYLE, center: [-0.17, 51.46], zoom: 11, attributionControl: { compact: true } }); } catch (e) { setErr(e.message || 'Maps are not available in this browser'); return undefined; }
    mapRef.current = map;
    map.on('error', () => {});
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    map.on('load', () => {
      map.addSource('trail', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({ id: 'trail-line', type: 'line', source: 'trail', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#1a6dff', 'line-width': 4, 'line-opacity': 0.85 } });
      setReady(true);
    });
    return () => { map.remove(); mapRef.current = null; setReady(false); };
  }, []);

  const points = trail?.points || [];
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    map.getSource('trail').setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: points.map((p) => [p.lng, p.lat]) } });
    const stopEls = [];
    (trail?.stops || []).forEach((s) => {
      const el = document.createElement('div'); el.className = 'brd-pin order'; el.style.background = s.delivered_at ? '#1a7f37' : '#7a3cff'; el.textContent = String(s.stop_seq ?? '•'); el.title = `${s.number} ${s.postcode || ''}`;
      stopEls.push(new maplibregl.Marker({ element: el }).setLngLat([s.lng, s.lat]).addTo(map));
    });
    if (points.length) {
      const b = new maplibregl.LngLatBounds([points[0].lng, points[0].lat], [points[0].lng, points[0].lat]);
      points.forEach((p) => b.extend([p.lng, p.lat])); (trail.stops || []).forEach((s) => b.extend([s.lng, s.lat]));
      map.fitBounds(b, { padding: 50, maxZoom: 16, duration: 0 });
    }
    return () => stopEls.forEach((m) => m.remove());
  }, [trail, ready]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const p = points[pos];
    if (!p) { marker.current?.remove(); marker.current = null; return; }
    if (!marker.current) { const el = document.createElement('div'); el.className = 'brd-pin shop'; el.textContent = 'DRV'; marker.current = new maplibregl.Marker({ element: el }).setLngLat([p.lng, p.lat]).addTo(map); } else marker.current.setLngLat([p.lng, p.lat]);
  }, [pos, trail, ready]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!playing) return undefined;
    const t = setInterval(() => setPos((i) => { if (i >= points.length - 1) { setPlaying(false); return i; } return i + 1; }), 120);
    return () => clearInterval(t);
  }, [playing, points.length]);

  const now = points[pos];
  const options = useMemo(() => (runs?.runs || []).map((r) => ({ id: r.id, text: `Run #${r.id} · ${dayjs(r.out_at || r.created_at).format('D MMM HH:mm')} · ${r.orders} stop${r.orders === 1 ? '' : 's'} · ${LABEL[r.status] || r.status} · ${r.points} point${r.points === 1 ? '' : 's'}` })), [runs]);
  return (
    <Modal title={`Route history — ${driver.name || driver.id}`} onClose={onClose} wide footer={<button type="button" onClick={onClose}>Close</button>}>
      {err && <div className="err" role="alert">{err}</div>}
      <label htmlFor="trl-run">Show</label>
      <select id="trl-run" value={sel} onChange={(e) => setSel(e.target.value)}>
        <option value="">The last 24 hours</option>
        {options.map((o) => <option key={o.id} value={o.id}>{o.text}</option>)}
      </select>
      <div ref={box} className="trl-map" role="region" aria-label="Saved route on the map" />
      {!trail && !err && <p className="muted"><span className="ui-spin" /> Loading route…</p>}
      {trail && points.length === 0 && <p className="ui-empty">No GPS points were saved for this selection. Points are saved while the driver is clocked in and the app is sending its position.</p>}
      {points.length > 0 && (
        <div className="trl-bar">
          <button type="button" className="dark" onClick={() => { if (pos >= points.length - 1) setPos(0); setPlaying((p) => !p); }}>{playing ? 'Pause' : 'Play'}</button>
          <input type="range" min={0} max={points.length - 1} value={pos} aria-label="Position along the route" onChange={(e) => { setPlaying(false); setPos(Number(e.target.value)); }} />
          <span className="muted">{now ? dayjs(now.at).format('D MMM HH:mm:ss') : ''}</span>
        </div>
      )}
      {trail && points.length > 0 && <p className="muted">{points.length} points · {trail.distance_km} km{runs && ` · history is kept ${runs.retention_days ? `${runs.retention_days} days` : 'for ever'} (Settings)`}{trail.truncated ? ' · showing the first 20,000 points' : ''}</p>}
    </Modal>
  );
}
