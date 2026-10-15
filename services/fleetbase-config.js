/** Keeps Fleetbase's own configuration in step with the owner's settings (so its console shows the same delivery area). */
export const AREA_NAME = 'TAD delivery radius';

export function createFleetbaseConfig(ctx) {
  const { fleetbase, settings, audit } = ctx;

  /** The owner's delivery radius lives in settings; mirror it as a Fleetbase service area (circle around the shop). Idempotent. */
  async function syncServiceArea() {
    const s = settings.all();
    const body = { name: AREA_NAME, country: 'GB', status: 'active', type: 'service-area', latitude: s.store.lat, longitude: s.store.lng, radius: Math.round(s.radius_km * 1000) };
    const existing = (await fleetbase.serviceAreas()).find((a) => a.name === AREA_NAME);
    const area = existing ? await fleetbase.updateServiceArea(existing.id, body) : await fleetbase.createServiceArea(body);
    audit.log('system', 'fleetbase.service_area_synced', 'service_area', area.id, { radius_km: s.radius_km });
    return area;
  }
  return { syncServiceArea };
}
