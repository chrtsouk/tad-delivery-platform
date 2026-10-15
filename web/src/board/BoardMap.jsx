import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { baseStyle } from '../lib/map.js';
import { useSecond } from './clock.js';
import { clock, itemsSummary, shortNo } from './format.js';

export const BATCH_COLOURS = ['#e3171c', '#1a6dff', '#1a7f37', '#b7791f', '#7a3cff', '#0e8f8f'];
const STATE_COLOUR = { ready: '#d99a00', assigned: '#1a6dff', out: '#7a3cff' };
const STATE_NAME = { ready: 'Ready, in the queue', assigned: 'With a driver, at the shop', out: 'Out for delivery' };

const MAP_STYLE = { ...baseStyle, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#e9e9e4' } }, ...baseStyle.layers] };

function PopupBody({ order, drivers, onMove, busy }) {
  const [to, setTo] = useState(order.driver_id || '');
  useEffect(() => { setTo(order.driver_id || ''); }, [order.id, order.driver_id]);
  const movable = order.state === 'ready' || order.state === 'assigned';
  return (
    <div className="brd-pop">
      <strong>{order.number}</strong>
      <div>{order.customer_name || 'No name'} · {order.postcode}</div>
      <div className="brd-pop-sub">{itemsSummary(order.items)}</div>
      <div className="brd-pop-state" style={{ color: STATE_COLOUR[order.state] }}>{STATE_NAME[order.state] || order.state}</div>
      {movable ? (
        <>
          <label htmlFor={`pop-drv-${order.id}`}>Move to</label>
          <select id={`pop-drv-${order.id}`} value={to} onChange={(e) => setTo(e.target.value)}>
            <option value="">{order.state === 'ready' ? 'Queue (no driver yet)' : 'Back to the queue'}</option>
            {drivers.map((d) => <option key={d.driver_id} value={d.driver_id}>{d.name || d.driver_id}</option>)}
          </select>
          <button type="button" className="dark" disabled={busy || (to || null) === (order.driver_id || null)} onClick={() => onMove(order.id, to || null)}>{busy ? 'Moving…' : 'Move'}</button>
        </>
      ) : <div className="brd-pop-sub">On the road, it cannot be moved.</div>}
    </div>
  );
}

function Legend({ groups, snapAt }) {
  useSecond();
  if (!groups.length) return null;
  return (
    <ul className="brd-legend" aria-label="Batch preview">
      {groups.map((g) => {
        const left = g.waits_seconds - (Date.now() - snapAt) / 1000;
        const state = g.full ? 'full' : g.ripe || left <= 0 ? 'ready to send' : `waits ${clock(left)}`;
        return <li key={g.index}><i style={{ background: BATCH_COLOURS[g.index % BATCH_COLOURS.length] }} />Batch {g.index + 1} ({g.order_ids.length} stop{g.order_ids.length === 1 ? '' : 's'}, {state})</li>;
      })}
    </ul>
  );
}

/**
 * Live map of every pending delivery: coloured pins by state, the shop, the batcher's preview groups as lines from the
 * shop, and a click-to-move popup. Never throws when tiles/WebGL are missing.
 */
export default function BoardMap({ store, pins, groups, drivers, selectedId, onSelect, onMove, movingId, snapAt, visible }) {
  const box = useRef(null);
  const mapRef = useRef(null);
  const markers = useRef([]);
  const storeMarker = useRef(null);
  const popup = useRef(null);
  const fitted = useRef('');
  const programmatic = useRef(false);
  const cb = useRef({});
  cb.current = { onSelect };
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState('');
  const [popEl] = useState(() => document.createElement('div'));

  /* create the map once */
  useEffect(() => {
    let map;
    try {
      map = new maplibregl.Map({ container: box.current, style: MAP_STYLE, center: [store.lng, store.lat], zoom: 12, attributionControl: { compact: true } });
    } catch (e) { setFailed(e.message || 'Maps are not available in this browser'); return undefined; }
    mapRef.current = map;
    map.on('error', () => { /* tiles not loading (offline) must never break the board */ });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    map.on('load', () => {
      map.addSource('preview', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({ id: 'preview-line', type: 'line', source: 'preview', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': ['get', 'color'], 'line-width': 4, 'line-opacity': 0.85 } });
      setReady(true);
    });
    popup.current = new maplibregl.Popup({ closeButton: true, closeOnClick: false, offset: 20, maxWidth: '270px' });
    popup.current.on('close', () => { if (!programmatic.current) cb.current.onSelect(null); });
    return () => { map.remove(); mapRef.current = null; setReady(false); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { if (visible) mapRef.current?.resize(); }, [visible]);

  /* shop marker */
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!storeMarker.current) {
      const el = document.createElement('div');
      el.className = 'brd-pin shop'; el.textContent = 'SHOP'; el.setAttribute('aria-label', 'The shop');
      storeMarker.current = new maplibregl.Marker({ element: el }).setLngLat([store.lng, store.lat]).addTo(map);
    } else storeMarker.current.setLngLat([store.lng, store.lat]);
  }, [store.lat, store.lng, ready]);

  /* order pins */
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    markers.current.forEach((m) => m.remove());
    markers.current = pins.map((o) => {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = `brd-pin order st-${o.state}${o.id === selectedId ? ' sel' : ''}`;
      el.style.background = STATE_COLOUR[o.state] || '#555';
      el.textContent = shortNo(o.number);
      el.setAttribute('aria-label', `Order ${o.number}, ${STATE_NAME[o.state] || o.state}`);
      el.addEventListener('click', (e) => { e.stopPropagation(); cb.current.onSelect(o.id); });
      return new maplibregl.Marker({ element: el }).setLngLat([o.lng, o.lat]).addTo(map);
    });
  }, [pins, selectedId, ready]);

  /* fit once whenever the set of pins changes */
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const sig = pins.map((p) => p.id).sort().join(',');
    if (sig === fitted.current) return;
    fitted.current = sig;
    if (!pins.length) { map.jumpTo({ center: [store.lng, store.lat], zoom: 12 }); return; }
    const b = new maplibregl.LngLatBounds([store.lng, store.lat], [store.lng, store.lat]);
    pins.forEach((p) => b.extend([p.lng, p.lat]));
    map.fitBounds(b, { padding: 60, maxZoom: 15, duration: 0 });
  }, [pins, store.lat, store.lng, ready]);

  /* batch preview lines from the shop */
  useEffect(() => {
    const src = mapRef.current?.getSource?.('preview');
    if (!src) return;
    const byId = new Map(pins.map((p) => [p.id, p]));
    src.setData({
      type: 'FeatureCollection',
      features: groups.map((g) => ({
        type: 'Feature', properties: { color: BATCH_COLOURS[g.index % BATCH_COLOURS.length] },
        geometry: { type: 'LineString', coordinates: [[store.lng, store.lat], ...g.order_ids.map((id) => byId.get(id)).filter(Boolean).map((o) => [o.lng, o.lat])] },
      })).filter((f) => f.geometry.coordinates.length > 1),
    });
  }, [groups, pins, store.lat, store.lng, ready]);

  /* popup follows the selected pin */
  const sel = pins.find((p) => p.id === selectedId) || null;
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !popup.current) return;
    programmatic.current = true;
    if (sel) popup.current.setLngLat([sel.lng, sel.lat]).setDOMContent(popEl).addTo(map);
    else popup.current.remove();
    programmatic.current = false;
  }, [sel?.id, sel?.lng, sel?.lat, ready, popEl]); // eslint-disable-line react-hooks/exhaustive-deps

  const legend = useMemo(() => groups, [groups]);
  return (
    <div className="brd-map-wrap">
      <div ref={box} className="brd-map" role="region" aria-label="Map of pending deliveries" />
      {failed && <div className="brd-map-fail">Map unavailable: {failed}</div>}
      <Legend groups={legend} snapAt={snapAt} />
      <ul className="brd-key" aria-hidden="true">
        {Object.entries(STATE_COLOUR).map(([k, c]) => <li key={k}><i style={{ background: c }} />{k === 'ready' ? 'Ready' : k === 'assigned' ? 'Assigned' : 'Out'}</li>)}
      </ul>
      {sel && createPortal(<PopupBody order={sel} drivers={drivers} onMove={onMove} busy={movingId === sel.id} />, popEl)}
    </div>
  );
}
