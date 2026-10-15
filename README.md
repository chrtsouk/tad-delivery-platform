# TAD Delivery Platform

The shop side of Texas After Dark delivery: take orders from our own ordering, show pick-up vs delivery, group deliveries by
postcode and capacity per driver per route, a live map, message / call the driver.

**Status: PARKED.** This is the code that was built inside the management app (owner note 18) and moved out here on
15 Oct 2026 (owner note 20) so the management app stays a pure hub. Nothing here runs yet. The owner's order is: finish the
management app first, then research and build this project (see `docs/DELIVERY_SYSTEM_PLAN.md`).

## What was moved here, untouched

| File | What it is |
|---|---|
| `src/dispatch.js` | the core: drivers, deliveries, statuses, assign / out / delivered / failed, "suggest runs" by postcode and room, messages, the customer tracking read. 571 lines, was `server/core/dispatch.js` |
| `src/pages/dispatch.js` | the dispatcher screen (board, drivers) in the Tabler look |
| `src/server/trackpage.js` | the customer's tracking link page (`/track/<token>`) |
| `src/server/driver-api.js` | the driver app's API router (`/driver/run`, `/location`, `/deliveries/:id/status`, messages) |
| `src/server/office-routes.txt`, `hub-v1-delivery-routes.txt` | the routes the hub used to serve, for reference |
| `src/schema.sql` | the `drivers`, `deliveries`, `delivery_messages` tables (and `customers`, which the hub still owns) |
| `tests/dispatch.test.js` | the 559-line test file (was the hub's `tests/91-dispatch.test.js`) |
| `docs/` | the old connected-system note and the plan |

The code still imports hub-shaped modules (`db`, `repo`, `sites`, `settings`, `clock`, `kitchen`, `util`). When this project is
started it gets its own database and talks to the hub over its public API instead. See below.

## How it talks to the hub

The hub (`tad-management-app`) keeps only the shared API: `/api/v1` (orders, customers, sales, events) and signed webhooks.
This project reads orders and customers from there, and keeps its own deliveries, drivers and tracking data.

- `GET /api/v1/orders` (scope `orders:read`): kitchen-pass orders, to turn into drops
- `GET /api/v1/customers` (scope `customers:read`): customers who order direct (name, phone, address)
- `GET /api/v1/events` / webhooks: `kitchen_order.update`, `customer.update` (an erase request arrives as a customer update: blank the copy here too)
- `POST /api/v1/orders` (scope `orders:write`): the own-website ordering system puts an order on the pass

## Next, when it is started

1. The verified research in `docs/DELIVERY_SYSTEM_PLAN.md` (Fleetbase, Enatega, VROOM, postcodes.io, Traccar): licences, stacks, what each contains.
2. The owner picks; then build on the chosen projects (AGPL, offline-first, Tabler).
