# One connected system (owner note 18)

The management app is the **hub and the source of truth**. The other Texas After Dark programs are separate projects, built later, and plug into this app over `/api/v1`
(see `API.md`) — none of them keeps a second copy of the data.

```
 customer website / app ──orders, deliveries──▶ ┐
 delivery platforms (CSV today, connectors later) ─orders─▶ │   MANAGEMENT APP (this repo)
 kitchen display (KDS) ◀──kitchen pass, events──┤   orders · items · customers · drivers · deliveries · statuses
 dispatcher screen (Dispatch) ◀───────────┤   one SQLite/Postgres database, offline-first, syncs online
 driver app ◀──own run, GPS, status, messages───┤
 customer tracking page ◀──status, driver, place┘
```

## What is already in the hub

| Thing | Where | Notes |
|---|---|---|
| Orders and their items | `kitchen_orders`, `kitchen_order_lines`; `POST /api/v1/orders`; Kitchen pass screen | statuses `new → cooking → ready → bumped` (or `cancelled`); allergens shown from the allergen matrix; the same `source` + `external_ref` never makes two |
| Customers | `customers`; Dispatch → Customers | only people who order direct; erase on request; kept out of the analytics copy |
| Drivers | `drivers`; Dispatch → Drivers | the most items per run is the owner's number; a driver-app key (`drv_…`) per driver |
| Deliveries | `deliveries`; Dispatch → Board; `POST /api/v1/deliveries` | statuses `waiting → assigned → out → delivered`, or `failed` / `cancelled` (a reason is required) |
| Dispatch by postcode and quantity | `dispatch.suggest()`; "Suggest runs" | oldest drop first, nearest postcode area next, within each driver's room; never changes anything by itself |
| Live position | `POST /api/v1/driver/location` | last place only |
| Messages | `delivery_messages`; office, driver and customer in one thread | team-only unless sent to `all` |
| Customer tracking | `/track/<token>`, `/track-api/<token>` | off until the owner switches it on; first name of the driver, status, last place while out |
| Events for everything | `GET /api/v1/events`, signed webhooks | `delivery.update`, `kitchen_order.update`, … (tracking tokens and keys are never in them) |
| Platforms | Settings → Sales channels and platforms; `server/connectors/` | unlimited; connectors read keys from the environment |

## Honest limits

* **No map, no geocoding.** The app is free and local and calls no outside service, so "near" means the postcode's outward code (SW11 with SW11, then SW12, SW10…). A real route order or drive-time needs a geocoder or routing service: see `GAPS_FOR_CLAUDE.md`.
* **No driver app, KDS or customer ordering site is built here.** They are separate projects; this app gives them the API above. The tracking page is the one customer-facing piece, because it needs no login and no data beyond what is shown.
* **The driver's position is the last point the app sent.** If the phone stops sending, the customer's page says how many minutes ago it was last seen.
* **Platform orders carry totals, not items**, so they cannot feed the kitchen pass or dispatch unless a connector supplies items (see the connector notes in `DECISIONS.md`).
* **Online:** the tracking link and the public API are the only parts that answer without a PIN session. Everything else needs the owner login (online mode) or a PIN (LAN mode).
