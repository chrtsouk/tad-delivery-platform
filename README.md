# TAD Delivery Platform

The shop/dispatch side of Texas After Dark delivery (AGPL-3.0). It runs **unmodified [Fleetbase](https://github.com/fleetbase/fleetbase)** (dispatch board, live map, drivers, proof of delivery, tracking numbers) and adds small **Node services around it** — never a fork of its core:

| Piece | Where | What it does |
|---|---|---|
| **tad-batcher** | `services/batcher.js` | On *Ready*: clusters orders by postcode district, sequences with **our own VROOM**, caps stops per driver, cuts runs at the owner's max-minutes-between-drops, assigns by strategy (nearest / round-robin / fewest jobs); *send now*, *pre-assign while a driver is out*, *queue when nobody is free*, manual override, *return ETA → "pick up your orders"* push |
| **driver_shifts** | `services/shifts.js` | Clock in/out + zone, "available now" joined to Fleetbase's driver online status |
| **tad-ingest** | `services/ingest.js`, `services/orders.js` | One order schema; adapters for our own site, **HubRise** (OAuth + HMAC-checked callback), Uber Eats / Deliveroo / Just Eat (inert until approved keys are set), manual "Add new order" with address book + postcodes.io + Photon (+ OS Places if a key is set) |
| **SLA order board** | `web/src/pages/Board.jsx` | Live kanban with ageing timers, late alerts, sound, open/closed, failed-delivery flow, pending map + batch preview, drag to another driver |
| **Customer tracking** | `web/src/track`, `services/tracking.js` | Signed link, live driver marker, steps, queue position, OSRM ETA, call/message, web-push + email |
| Labels | `services/labels.js` | Order number as text **and** in the QR (`TAD|<number>`); ESC/POS network printer; the driver app scans the bag |
| Analytics | `services/analytics.js`, `web/src/pages/Analytics.jsx` | Demand heatmap (MapLibre), busy times, driver performance (no money), end-of-day, audit log |
| Hub sync | `services/hubsync.js` | The management hub (`tad-management-app`) stays the source of truth |
| Multi-site | `services/sites.js` | Several shops on one platform; each batches from its own location with its own drivers |

Rules baked in: English only · online payment only (no cash, no driver pay anywhere) · one role (admin).

## Run it locally

Needs Docker and Node 22+.

```bash
scripts/start-all.sh          # Fleetbase + OSRM + VROOM + postcodes.io (+ Photon if prepared) + this server on :4000
scripts/geo-osrm-prepare.sh   # once: builds the OSRM graph (Greater London by default; set PBF_URL for all of GB)
scripts/geo-photon-prepare.sh # once, optional: GB-only Photon index (~3.5 GB download, deleted after extracting)
node scripts/fleetbase-brand.mjs  # puts the TAD logo into Fleetbase and nothing else
```

First time only: create the Fleetbase admin in the console (http://localhost:4200), make an API key (Developers → API keys) and put it in `.env.local` as `FLEETBASE_API_KEY`. `node scripts/init-env.mjs` writes the platform's own random secrets there (the file is gitignored; see `.env.example` for every variable).

No Docker? `node scripts/demo.mjs` boots the real app on :4001 with in-memory fakes and seeded orders (password `demo`).

## Tests

```bash
npm test                     # all unit/API tests, in-memory, no Docker needed (sweeps its own temp data)
node test-live/smoke.mjs     # end-to-end against the real local Fleetbase + OSRM + VROOM + postcodes.io
```

`npm test` uses in-memory SQLite and in-process fakes (fake Fleetbase, VROOM, OSRM, printer, SMTP, hub) — it never contacts a live platform, mail provider or printer.

## More

`DECISIONS.md` (choices made and how to change them) · `ROADMAP.md` · `REPORT.md` · `docs/THIRD_PARTY_NOTICES.md` · `docs/OWN_SITE_API.md` (how the ordering website uses this) · `docs/legacy/` (old code moved from the hub, kept for reference)
