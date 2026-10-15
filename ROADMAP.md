# Roadmap (priority order; kept current at the end of every pass)

## Done
1. Repos public + AGPL LICENSE (both); TAD logo placed (own web app, Fleetbase Branding, driver app).
2. Fleetbase (unmodified official images) running in Docker, admin + API key created, branding set, delivery-radius service area synced.
3. OSRM (Greater London graph), our own VROOM, postcodes.io (full ONS data) running and called directly over HTTP.
4. `tad-batcher`: Ready → cluster → VROOM → assign by strategy; send-now, pre-assign, queue, manual override, return-ETA push; local fallback when VROOM is down.
5. `driver_shifts`: clock in/out + availability joined to Fleetbase online status.
6. `tad-ingest`: own site, HubRise (OAuth + HMAC callback), Uber Eats / Deliveroo / Just Eat (inert behind flags), manual add with address book + postcodes.io + Photon + OS Places adapter.
7. Labels (number as text + in QR), pickup bag scan check (server side), ESC/POS print.
8. Tracking API (steps, queue position, OSRM ETA, rating), free notifications (email, web push, inbox, wa.me links).
9. Analytics API (demand heatmap data, driver performance, end of day, audit log), hub sync, multi-site, Fleetbase→platform reconcile + webhook, GDPR erase.
10. Web UI: board, add order, drivers, settings, analytics, calendar, audit, tracking page (see REPORT.md for what was verified in a browser).
11. TAD Drivers fork (see tad-drivers repo): clock in/out, bag scan, delivered/failed, notifications; cash/earnings removed.

## In progress / next
1. Photon GB index: download + live address-autocomplete check (script: `scripts/geo-photon-prepare.sh`).
2. Full browser walkthrough of every screen on the live stack (not only the demo server).
3. Android build of TAD Drivers (needs Android SDK + signing key — owner).
4. Production deploy (VPS): GB-wide OSRM graph (needs ~16 GB RAM to extract), HTTPS, backups of `.data/tad.sqlite`.
5. Real-account items only the owner can do: HubRise app registration, approved Uber Eats / Deliveroo / Just Eat keys, SMTP + VAPID keys, label printer address.
