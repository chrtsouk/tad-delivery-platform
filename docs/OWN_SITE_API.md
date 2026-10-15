# Own ordering site / app → platform

All calls are JSON over HTTPS. The site key is `OWN_SITE_API_KEY` (server env) sent as `X-TAD-Key`.

| Call | Auth | Use |
|---|---|---|
| `GET /api/public/status` | none | `{ open, eta_minutes, radius_km, min_order_pence }` — show open/closed and the usual wait |
| `GET /api/public/quote?postcode=SW11 1AB[&site=main]` | none | `{ deliverable, fee_pence, eta_minutes, open, distance_km }` or `{ deliverable:false, reason }` — before the customer pays |
| `POST /api/ingest/own` | `X-TAD-Key` | Place a paid order (see below). Idempotent on `external_id`. Returns `{ number, tracking_url, duplicate }` |
| `GET /api/track/:token` | none | Same data as the tracking page (status steps, queue position, `eta_minutes`, driver position) for your own UI |
| `POST /api/track/:token/rate` | none | `{ rating: 1..5 }` once delivered |

```json
POST /api/ingest/own
{ "external_id": "web-10492", "fulfilment": "delivery",
  "customer": { "name": "Sam", "phone": "07700 900222", "email": "sam@example.com" },
  "address": { "line1": "9 High St", "postcode": "SW11 5XX" },
  "items": [{ "name": "Wings", "qty": 2, "price_pence": 899 }],
  "total_pence": 1998, "notes": "Ring twice", "scheduled_for": "2026-10-16T19:30:00Z" }
```

Orders are **paid online before they are posted** (the platform has no cash handling). `422 outside_area` / `422 unknown_postcode` are customer-readable messages.

## Custom fields and blocked customers

* If the shop has added custom order fields (Settings → Custom order fields), send their answers as `"custom": { "<key>": value }` in the body. Keys are in `GET /api/settings → custom_fields` (admin) — a text, number, one of the listed choices, or `true`/`false` for a tick box. Unknown keys are ignored; required fields are **not** enforced for website orders.
* A phone number or address the shop has **blocked** is refused with `409 { "code": "customer_blocked", "error": "This customer is blocked: <reason>" }`. Show your own polite message; do not show the reason to the customer. The website cannot override a block.
