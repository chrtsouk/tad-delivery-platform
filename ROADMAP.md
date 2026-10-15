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

12. Photon GB index installed and checked live (address autocomplete); browser walkthrough of the board/add/scan/drivers/settings/analytics/calendar/audit pages on the live stack; independent code review done and all 15 findings fixed with regression tests (71 tests).

## Next (owner-only unless marked)
1. Android build of TAD Drivers: needs Android SDK, signing keystore, Firebase `google-services.json`, Google Maps key, Transistorsoft licence (see `tad-drivers/docs/BUILD_ANDROID.md`), then a test on a real phone (the app has never run on a device).
2. Production deploy (VPS): GB-wide OSRM graph (~16 GB RAM to extract), HTTPS in front of the platform, backups of `.data/tad.sqlite`, set `PUBLIC_URL`.
3. Real accounts / hardware: HubRise app registration, approved Uber Eats / Deliveroo / Just Eat API keys (then verify the three mappers against real payloads), SMTP + VAPID keys, the label printer's address, the shop's real postcode/radius/fees in Settings.
4. (Platform, later) swap customer-page polling for a Fleetbase socket subscription if volume ever needs it (DECISIONS 13); tile server of our own instead of OpenStreetMap's public tiles.
