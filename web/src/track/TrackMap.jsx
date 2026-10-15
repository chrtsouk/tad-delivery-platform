import { useEffect, useRef, useState, useCallback } from 'react';
import { baseStyle } from '../lib/map.js';
import { bearing } from './format.js';

const ok = (p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lng);
const reduceMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const MOVE_MS = 4000;
const PAD = { top: 70, bottom: 70, left: 50, right: 60 };

function pinEl(kind, label) {
  const el = document.createElement('div');
  el.className = `pin pin-${kind}`;
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', label);
  el.innerHTML = kind === 'home'
    ? '<svg viewBox="0 0 32 40" width="34" height="42" aria-hidden="true"><path d="M16 39C16 39 2 24 2 14a14 14 0 0 1 28 0c0 10-14 25-14 25z" fill="#e3171c" stroke="#fff" stroke-width="2.5"/><path d="M9.5 15 16 9.5 22.5 15v7h-4.5v-4.5h-4V22H9.5z" fill="#fff"/></svg>'
    : '<svg viewBox="0 0 32 32" width="34" height="34" aria-hidden="true"><circle cx="16" cy="16" r="14" fill="#141414" stroke="#fff" stroke-width="2.5"/><path d="M9 13h14l-1.2 9H10.2zM12 13l1-3h6l1 3" fill="none" stroke="#fff" stroke-width="2" stroke-linejoin="round"/></svg>';
  return el;
}

function driverEl(name) {
  const el = document.createElement('div');
  el.className = 'pin pin-driver';
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', name ? `${name}, your driver` : 'Your driver');
  el.innerHTML = '<span class="pulse"></span><span class="arrow"><svg viewBox="0 0 40 40" width="40" height="40" aria-hidden="true"><circle cx="20" cy="20" r="18" fill="#e3171c" stroke="#fff" stroke-width="3"/><path d="M20 8 29 29 20 24 11 29z" fill="#fff"/></svg></span>';
  return el;
}

/** Destination pin + shop marker + live driver marker (rotated by heading, glides between updates). Degrades without tiles or WebGL. */
export default function TrackMap({ order }) {
  const box = useRef(null);
  const st = useRef({ map: null, lib: null, home: null, shop: null, drv: null, shown: null, raf: 0, userMoved: false, lastTarget: null, heading: null });
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [tilesDown, setTilesDown] = useState(false);

  const dest = ok(order.destination) ? order.destination : null;
  const shop = ok(order.store) ? order.store : null;
  const driver = order.state === 'out' && ok(order.driver) ? order.driver : null;

  // create the map once
  useEffect(() => {
    let dead = false;
    const s = st.current;
    (async () => {
      try {
        const [mod, worker] = await Promise.all([import('maplibre-gl'), import('maplibre-gl/dist/maplibre-gl-worker.mjs?url'), import('maplibre-gl/dist/maplibre-gl.css')]);
        if (dead || !box.current) return;
        const lib = mod.default || mod;
        lib.setWorkerUrl(worker.default); // maplibre 6 ships its worker as a separate file; Vite must serve it explicitly
        const c = dest || shop;
        const map = new lib.Map({ container: box.current, style: baseStyle, center: c ? [c.lng, c.lat] : [-0.12, 51.5], zoom: 13, attributionControl: { compact: true }, cooperativeGestures: false });
        map.addControl(new lib.NavigationControl({ showCompass: false }), 'top-right');
        map.on('error', (e) => { if (e?.sourceId === 'osm' || /tile|fetch|Failed/i.test(e?.error?.message || '')) setTilesDown(true); });
        map.on('data', (e) => { if (e.sourceId === 'osm' && e.tile) setTilesDown(false); });
        map.on('dragstart', (e) => { if (e.originalEvent) s.userMoved = true; });
        map.on('zoomstart', (e) => { if (e.originalEvent) s.userMoved = true; });
        s.map = map; s.lib = lib;
        setReady(true);
      } catch {
        if (!dead) setFailed(true);
      }
    })();
    return () => { dead = true; cancelAnimationFrame(s.raf); s.map?.remove(); Object.assign(s, { map: null, lib: null, home: null, shop: null, drv: null, shown: null, userMoved: false, lastTarget: null }); setReady(false); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fit = useCallback((animate = true) => {
    const s = st.current; if (!s.map) return;
    const pts = s.shown ? [s.shown, dest].filter(Boolean) : [dest, shop].filter(Boolean);
    if (!pts.length) return;
    if (pts.length === 1) { s.map.easeTo({ center: [pts[0].lng, pts[0].lat], zoom: 14, duration: animate ? 600 : 0 }); return; }
    const b = new s.lib.LngLatBounds();
    pts.forEach((p) => b.extend([p.lng, p.lat]));
    s.map.fitBounds(b, { padding: PAD, maxZoom: 16, duration: animate ? 800 : 0 });
  }, [dest, shop]);

  // static markers
  useEffect(() => {
    const s = st.current; if (!ready) return;
    const put = (key, p, kind, label) => {
      if (!p) { s[key]?.remove(); s[key] = null; return; }
      if (!s[key]) s[key] = new s.lib.Marker({ element: pinEl(kind, label), anchor: kind === 'home' ? 'bottom' : 'center' }).setLngLat([p.lng, p.lat]).addTo(s.map);
      else s[key].setLngLat([p.lng, p.lat]);
    };
    put('home', dest, 'home', 'Your delivery address');
    put('shop', shop, 'shop', shop ? `${order.store?.name || 'The shop'}` : 'The shop');
    if (!s.userMoved) fit(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, dest?.lat, dest?.lng, shop?.lat, shop?.lng]);

  // live driver
  useEffect(() => {
    const s = st.current; if (!ready) return;
    if (!driver) {
      cancelAnimationFrame(s.raf);
      if (s.drv) { s.drv.remove(); s.drv = null; s.shown = null; s.lastTarget = null; s.userMoved = false; fit(true); }
      return;
    }
    const target = { lat: driver.lat, lng: driver.lng };
    // heading: from the server, else the direction of travel
    let h = Number.isFinite(driver.heading) ? driver.heading : null;
    if (h == null && s.lastTarget && (Math.abs(s.lastTarget.lat - target.lat) + Math.abs(s.lastTarget.lng - target.lng)) > 1e-5) h = bearing(s.lastTarget, target);
    if (h != null) s.heading = h;
    s.lastTarget = target;

    const first = !s.drv;
    if (first) {
      s.drv = new s.lib.Marker({ element: driverEl(driver.first_name), anchor: 'center' }).setLngLat([target.lng, target.lat]).addTo(s.map);
      s.shown = target;
      s.userMoved = false;
    }
    const arrow = s.drv.getElement().querySelector('.arrow');
    if (arrow && s.heading != null) arrow.style.transform = `rotate(${s.heading}deg)`;

    if (!first) {
      cancelAnimationFrame(s.raf);
      const from = { ...s.shown };
      if (reduceMotion()) { s.shown = target; s.drv.setLngLat([target.lng, target.lat]); }
      else {
        const t0 = performance.now();
        const tick = (now) => {
          const k = Math.min(1, (now - t0) / MOVE_MS), e = k < 0.5 ? 2 * k * k : 1 - ((-2 * k + 2) ** 2) / 2;
          s.shown = { lat: from.lat + (target.lat - from.lat) * e, lng: from.lng + (target.lng - from.lng) * e };
          s.drv?.setLngLat([s.shown.lng, s.shown.lat]);
          if (k < 1) s.raf = requestAnimationFrame(tick);
        };
        s.raf = requestAnimationFrame(tick);
      }
    }
    if (first || !s.userMoved) {
      // fit around where the driver is heading, so the view is stable while the marker glides
      const b = new s.lib.LngLatBounds();
      [target, dest].filter(Boolean).forEach((p) => b.extend([p.lng, p.lat]));
      if (dest) s.map.fitBounds(b, { padding: PAD, maxZoom: 16, duration: first ? 0 : 1200 });
      else s.map.easeTo({ center: [target.lng, target.lat], duration: 1200 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, driver?.lat, driver?.lng, driver?.heading, !!driver]);

  const recenter = () => { st.current.userMoved = false; if (driver && dest) { const s = st.current; const b = new s.lib.LngLatBounds(); [s.shown || driver, dest].forEach((p) => b.extend([p.lng, p.lat])); s.map.fitBounds(b, { padding: PAD, maxZoom: 16, duration: 600 }); } else fit(true); };

  if (!dest && !shop) return null;

  return (
    <section className="map-card" aria-label="Delivery map">
      <div className="map-box" ref={box} />
      {!ready && !failed && <div className="map-overlay" aria-hidden="true"><span className="spinner" /> Loading map…</div>}
      {failed && (
        <div className="map-overlay map-fallback" role="note">
          <strong>Map unavailable on this device.</strong>
          <span>{dest?.postcode ? `Delivering to ${dest.postcode}.` : 'Your driver’s progress shows in the status above.'}</span>
        </div>
      )}
      {ready && tilesDown && <div className="map-note" role="note">Map background couldn’t load — the pins are still live.</div>}
      {ready && <button type="button" className="map-recenter" onClick={recenter} aria-label="Re-centre the map">Re-centre</button>}
      <ul className="map-legend" aria-hidden="true">
        {dest && <li><i className="dot dot-home" />You</li>}
        {shop && <li><i className="dot dot-shop" />Shop</li>}
        {driver && <li><i className="dot dot-driver" />Driver</li>}
      </ul>
    </section>
  );
}
