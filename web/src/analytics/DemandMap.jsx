import { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import Supercluster from 'supercluster';
import { baseStyle } from '../lib/map.js';

const LONDON = [-0.12, 51.5];
// a plain background layer under the OSM tiles, so the data is still readable when tiles cannot load (offline)
const style = { ...baseStyle, layers: [{ id: 'ana-bg', type: 'background', paint: { 'background-color': '#e9e9e4' } }, ...baseStyle.layers] };

const HEAT_PAINT = {
  'heatmap-weight': ['coalesce', ['get', 'weight'], 1],
  'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 8, 0.6, 15, 2],
  'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 8, 8, 12, 24, 16, 48],
  'heatmap-opacity': 0.85,
  'heatmap-color': ['interpolate', ['linear'], ['heatmap-density'], 0, 'rgba(255,237,160,0)', 0.2, 'rgba(254,217,118,0.7)', 0.4, 'rgba(253,141,60,0.8)', 0.7, 'rgba(227,23,28,0.9)', 1, 'rgba(120,10,14,1)'],
};

/** Demand map: a MapLibre heatmap layer, or supercluster circles with counts (HTML markers, so no glyph/font server is needed). */
export default function DemandMap({ points, mode }) {
  const box = useRef(null);
  const mapRef = useRef(null);
  const markers = useRef([]);
  const index = useRef(null);
  const modeRef = useRef(mode);
  const [ready, setReady] = useState(false);
  const [tilesFailed, setTilesFailed] = useState(false);
  const [mapError, setMapError] = useState(null);
  modeRef.current = mode;

  const clearMarkers = () => { markers.current.forEach((m) => m.remove()); markers.current = []; };
  const drawClusters = () => {
    const map = mapRef.current;
    clearMarkers();
    if (!map || !index.current || modeRef.current !== 'clusters') return;
    const b = map.getBounds();
    const found = index.current.getClusters([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()], Math.round(map.getZoom()));
    for (const f of found) {
      const [lng, lat] = f.geometry.coordinates;
      const n = f.properties.cluster ? f.properties.point_count : 1;
      const el = document.createElement('button');
      el.type = 'button';
      const size = Math.min(64, 22 + Math.sqrt(n) * 6);
      el.className = 'ana-cluster';
      el.style.width = el.style.height = `${size}px`;
      el.textContent = String(n);
      el.setAttribute('aria-label', `${n} order${n === 1 ? '' : 's'} in this area`);
      el.addEventListener('click', () => {
        if (!f.properties.cluster) return;
        map.easeTo({ center: [lng, lat], zoom: Math.min(index.current.getClusterExpansionZoom(f.properties.cluster_id), 17) });
      });
      markers.current.push(new maplibregl.Marker({ element: el }).setLngLat([lng, lat]).addTo(map));
    }
  };

  // create the map once
  useEffect(() => {
    let map;
    try {
      map = new maplibregl.Map({ container: box.current, style, center: LONDON, zoom: 10, attributionControl: { compact: true } });
    } catch (e) { setMapError(e); return undefined; }
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    // tile requests failing (no network) must not spam the console or break the data layers
    map.on('error', (e) => { if (e?.sourceId === 'osm' || /tile|fetch|network|Failed/i.test(String(e?.error?.message))) setTilesFailed(true); });
    map.on('load', () => {
      map.addSource('orders', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({ id: 'orders-heat', type: 'heatmap', source: 'orders', paint: HEAT_PAINT });
      setReady(true);
    });
    map.on('moveend', drawClusters);
    return () => { clearMarkers(); map.remove(); mapRef.current = null; setReady(false); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // data changes: refresh the heatmap source, rebuild the cluster index, fit the view
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const features = points?.features ?? [];
    map.getSource('orders').setData({ type: 'FeatureCollection', features });
    index.current = new Supercluster({ radius: 55, maxZoom: 16 }).load(features);
    if (features.length) {
      const bounds = new maplibregl.LngLatBounds();
      features.forEach((f) => bounds.extend(f.geometry.coordinates));
      map.fitBounds(bounds, { padding: 48, maxZoom: 14, duration: 0 });
    }
    drawClusters();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points, ready]);

  // heatmap <-> clusters toggle
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    map.setLayoutProperty('orders-heat', 'visibility', mode === 'heatmap' ? 'visible' : 'none');
    drawClusters();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, ready]);

  if (mapError) return <div className="err">The map could not start in this browser ({mapError.message}). The tables below still work.</div>;
  return (
    <div className="ana-mapwrap">
      <div ref={box} className="ana-map" role="img" aria-label={mode === 'heatmap' ? 'Heatmap of delivery orders' : 'Delivery orders grouped by area'} />
      {tilesFailed && <div className="ana-maphint">Street tiles are unavailable (offline?) — showing order data only.</div>}
    </div>
  );
}
