# Report (updated every pass)

_Last updated: 15 Oct 2026, end of pass 1. An independent review found 15 defects (stale Fleetbase status, unsettled runs, lost HubRise orders, phone parsing, …); all are fixed and have regression tests in `test/review.test.js`._

## What exists and what was actually run

| Area | Status | Evidence |
|---|---|---|
| Fleetbase (unmodified official images) | **Running** in Docker (`docker/fleetbase`), admin + API key created, TAD logo in its Branding, delivery radius mirrored as a service area | `test-live/smoke.mjs` |
| OSRM + VROOM + postcodes.io (+ Photon GB) | **Running** in Docker (`docker/geo`). OSRM graph = Greater London only (laptop RAM); all-GB needs ~16 GB RAM — set `PBF_URL`. postcodes.io has the full ONS data. Photon has the GB-only extract | live smoke + address search checked against all three |
| Platform backend (batcher, shifts, ingest, orders, tracking, labels, analytics, hub sync, multi-site, Fleetbase reconcile) | **Built, 71 automated tests green** (in-memory, fakes) | `node --test 'test/**/*.test.js'` |
| Backend against the REAL stack | **Run end to end**: order in → Fleetbase order → VROOM/OSRM batch → Fleetbase dispatch → driver scan/start/deliver → tracking page → end-of-day | `test-live/smoke.mjs`, manual curl run, `test-live/ui-walk.mjs` |
| Web UI (board, add order, scan, drivers, settings, analytics, calendar, audit, tracking page) | **Built; driven in real headless Chrome** on the live stack (login, clock a real Fleetbase driver in, Photon address search, create order, accept, ready, lands on the driver lane, scan check, every page renders, no console errors) | `test-live/ui-walk.mjs` + screenshots (deleted after) |
| TAD Drivers (fork of Navigator) | **Code written, 70 jest tests + typecheck of the new code green** (re-run by the lead). **Never built into an APK and never run on a device** (no Android SDK here) | `tad-drivers` repo, `docs/BUILD_ANDROID.md` |

## NOT verified (be honest)

* Sound on the board (the oscillators are created; nobody heard it), touch dragging, real web-push delivery (needs VAPID keys + a phone), iOS/Safari.
* Real printer: printing was verified against a fake TCP printer (bytes contain the number as text and inside `TAD|<number>`); a real ESC/POS printer and its QR rendering are untested.
* HubRise OAuth + callback were tested with a signed fake callback and the documented field names; no real HubRise account was contacted. Uber Eats / Deliveroo / Just Eat mappers are written from public docs and are **unverified against real payloads** (inert until enabled).
* The driver app has never talked to the real platform (only mocked fetch); the platform side of its API was exercised with curl exactly as the app calls it.
* Scheduler/pre-orders release job is unit-tested with a fake clock, not watched across a real clock.

## Environment variables (all read from the environment only; see `.env.example`)

`PORT, PUBLIC_URL, TAD_DB_PATH, ADMIN_PASSWORD, ADMIN_API_TOKEN, SESSION_SECRET, TRACK_SECRET, OWN_SITE_API_KEY, FLEETBASE_URL, FLEETBASE_API_KEY, FLEETBASE_WEBHOOK_SECRET, VROOM_URL, OSRM_URL, POSTCODES_URL, PHOTON_URL, HUB_URL, HUB_TOKEN, HUB_WEBHOOK_SECRET, HUBRISE_CLIENT_ID, HUBRISE_CLIENT_SECRET, UBEREATS_*, DELIVEROO_*, JUSTEAT_*, SMTP_*, VAPID_*, PRINTER_*, OS_PLACES_API_KEY`. Secrets for the local stack are generated into gitignored files (`.env.local`, `docker/fleetbase/.env`, `docker/fleetbase/.admin-password`) — never committed.

## Disk

Docker volumes that this project owns: `tadfb_*` (Fleetbase DB + uploads, <1 GB), `tadgeo_osrmdata` (~0.3 GB), `tadgeo_photondata` (~6 GB, GB index; download archive already deleted), postcodes.io DB image (~1.3 GB + data). `scripts/stop-all.sh` stops them, `--wipe` deletes only those. The spec's global `docker volume prune` was deliberately NOT used (it would delete the owner's unrelated volumes). `npm test` sweeps its own temp dirs at start and end; tests create no temp files at all.
