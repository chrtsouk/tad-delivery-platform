/** MapLibre base style: OpenStreetMap raster tiles (fine for a shop's traffic; swap for a self-hosted tile server later via VITE_TILE_URL). */
export const TILE_URL = import.meta.env?.VITE_TILE_URL || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
export const baseStyle = {
  version: 8,
  sources: { osm: { type: 'raster', tiles: [TILE_URL], tileSize: 256, attribution: '© OpenStreetMap contributors' } },
  layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
};
