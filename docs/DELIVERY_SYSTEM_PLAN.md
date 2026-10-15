# TAD Delivery System — plan + open-source projects to build on (saved 14 Oct 2026)

SEPARATE from the management app. Two apps, both connect to the management app (the hub) via its API:
- **TAD Delivery Platform** (shop/dispatch side): orders from our own ordering → pick-up vs delivery → assign & auto-group deliveries by postcode and quantity per driver per route → live map → message/call driver.
- **TAD Drivers** (driver app, Android/web): assigned drops, navigation, one-tap picked-up/delivered, live GPS, proof of delivery, cash/earnings, message/call customer or dispatch.
Plus: customer live order tracking (status, queue position, live driver on map, ETA, message/call).
Rules: open-source (AGPL), take ready code and adapt into our stack (Node + web/mobile), connect to the management hub API. Owner opens/sets the delivery radius/miles himself.

## Open-source projects to mine (from Claude's knowledge — VERIFY licences/stars in the full research run)

### All-in-one (dispatch + driver app + tracking)
- **Fleetbase** — github.com/fleetbase/fleetbase — open-source last-mile/logistics. Dispatch console, driver app ("Navigator"), storefront, order routing, live tracking. Licence ~AGPL-3.0 (fits our AGPL). CLOSEST to Andromeda. Best base.
- **Enatega** — github.com/Ninjas-Code-official/Enatega-Multivendor-Solution — full food delivery: customer app, rider app, restaurant app, admin dashboard, live tracking. React Native + Node. Open-source. Good for UI + rider-app ideas/code.

### Route assignment by postcode + capacity per driver (the "brain")
- **VROOM** — github.com/VROOM-Project/vroom — vehicle routing solver: X deliveries per driver per route, capacity, time windows. BSD (permissive). BEST for the batching/assign logic.
- **jsprit** — github.com/graphhopper/jsprit — VRP toolkit, Apache-2.0 (Java).
- **OSRM / Valhalla / GraphHopper** — routing/distance engines over OpenStreetMap (free maps).
- **postcodes.io** — free UK postcode → coordinates (MIT), for postcode zones.

### Live GPS / driver tracking
- **Traccar** — github.com/traccar/traccar — mature GPS tracking platform, Apache-2.0. For live driver position on the map.

### Customer order tracking
- Fleetbase and Enatega already include it; otherwise build on Traccar + websockets.

## Recommended starting stack (provisional)
- Base: **Fleetbase** (dispatch + driver app ready).
- Assignment brain: **VROOM** + **postcodes.io** + **OSRM**.
- Live location: **Traccar**.
- UI/rider ideas and code: **Enatega**.

## Next step (when owner returns, after usage resets)
Run the full verified research (GitHub projects for dispatch, postcode routing, driver app, customer tracking) with tables: licence, stack, stars/maintenance, web/mobile, and exactly what tools each contains. Then owner picks, and we build TAD Delivery Platform + TAD Drivers on top of the chosen ones. Do this AFTER the management app is finished.
