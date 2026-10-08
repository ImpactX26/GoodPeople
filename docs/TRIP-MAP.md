# In-app delivery map

The map opens **when an NGO accepts a restaurant listing**, before a delivery partner exists. The donor and NGO see pickup/drop pins and a road-route preview while the Logistics Agent finds a partner. Partner acceptance starts the delivery leg; fresh GPS changes the map into live navigation. All views stay inside LUNA.

Implementation: [API contract](../api/src/trips/types.ts), [delivery state machine](../api/src/trips/engine.ts), [map screens](../web/src/components/trip/DeliveryHub.tsx). This follows `LUNA-SPEC.md` §12.7 and §15.6, including the donor tracking cutoff ten minutes after pickup.

## Run the app walkthrough

No Google keys or database are needed for the local walkthrough. In two terminals:

```sh
cd api
PORT=8791 ENABLE_TRIP_DEMO=1 npm run dev
```

```sh
cd web
NEXT_PUBLIC_API_URL=http://localhost:8791 npm run dev:http
```

Open `/demo` on the frontend. The older `/deliveries/demo` URL redirects there. For a separate production-build preview:

```sh
cd web
NEXT_PUBLIC_API_URL=http://localhost:8791 npm run build
npm start -- --port 3011
```

Then open `http://localhost:3011/demo`.

1. **Create walkthrough accounts** provisions a fictional restaurant (Annapurna Kitchen / Ravi), adult-serving NGO (Udaya Community Kitchen / Meera), reviewer (Asha), a second NGO (Seva Neighborhood Kitchen / Ananya), and three affiliated online volunteers (Arjun, Kavya, Nikhil). They are normal API profiles and sessions. Each tab signs into its own account without replacing the regular login. No listing or trip is created.
2. Open the restaurant, reviewer, NGO and all three volunteer apps in separate tabs. In the restaurant app choose **List food**, upload a photo, enter **Vegetable biryani**, 10 meal boxes, ingredients, timing, storage, containers and the declaration. Review and submit.
3. The first listing waits for approval in **Listing reviews** in the reviewer app. Approve with a reason. An isolated, rules-only agent fixture checks this specific vegetarian rice meal against the spec's high-risk shelf life and sends an offer to this adult NGO. It marks the food Unsure, requiring the pickup check. Other dishes, unsafe timing and excess quantities are not offered by the fixture. The production agents remain your friends' work.
4. Every NGO offer starts a **2–10 minute server countdown**, using remaining safe time ÷ 6. The displayed clock uses server time and does not restart on reload. A halfway reminder is recorded. On timeout, the first NGO loses its reservation and gets an expiry message; the next ranked NGO receives a fresh offer and deadline. In this walkthrough that is Seva Neighborhood Kitchen, available through **Open the next NGO app**. A late acceptance fails even if its old screen is still open. Accepted offers cannot expire.
5. The NGO chooses **Accept food offer**. Its map opens immediately; the donor's listing also opens tracking. The same acceptance operation automatically sends the pickup to every eligible volunteer in the fixture's three-person wave. Each volunteer gets a live in-app notification, on any app page. There is no NGO send or assignment control.
6. The first volunteer to **Accept pickup** wins. Other requests disappear with **Taken by someone else, thanks!** Exact addresses and offline code verifiers become available only to the assigned partner. Offline, busy, undersized and non-opted-in night volunteers are excluded by the fixture.
7. **Play demo ride · 8× speed** follows calculated road geometry. Keep the volunteer page open while watching the donor and NGO trackers. At pickup, enter the donor's code, upload the handover photo and confirm quantity and the food checklist. The ride then continues to the NGO.
8. At drop, enter the NGO's separate code. The NGO confirms servings received and can report a problem. The donor opens **View donation receipt**. Short or problematic deliveries create a review event.

`/demo` restores the most recently provisioned cohort so the same listing can be inspected. Records are in memory and disappear when the local API restarts. **Create a fresh set of accounts** starts a new independent cohort.

Demo streets use OpenStreetMap and road geometry/instructions use the public OSRM driving router. They are labelled samples with **no live traffic**. If the public router times out, the two known sample road corridors use recorded OSRM geometry, visibly labelled as recorded. Unknown routes show an error; no invented road is drawn. These providers are used only for sample trips. [OSRM API reference](https://project-osrm.org/docs/v5.24.0/api/).

Account provisioning and current-cohort disclosure require `ENABLE_TRIP_DEMO=1` and an **in-memory API**; they are disabled whenever `DATABASE_URL` is configured. Sample GPS mutations require the assigned partner's session and never affect real trips.

## Production map configuration

Enable Google Cloud billing, **Maps JavaScript API** and **Routes API**. Set:

| Environment | Variable | Purpose |
| --- | --- | --- |
| Frontend | `NEXT_PUBLIC_GOOGLE_MAPS_KEY` | Embedded Google street map |
| API | `GOOGLE_MAPS_ROUTES_KEY` | Traffic-aware routes and directions |
| API | `TRIP_CODE_SECRET` | Stable encryption secret for persisted handover codes |
| API | `LOGISTICS_HANDOFF_KEY` | Service authentication for agent handoffs |
| API | `ENABLE_TRIP_DEMO=0` | Disable sample mutations |

Use separate restricted browser and server keys. Keep server keys out of frontend variables. Google directions are displayed only on the Google basemap, never the demo OpenStreetMap map. Missing keys display the configuration issue while delivery status and handover actions remain available.

Google supplies road routing, traffic estimates, vehicle modes and instructions. LUNA does not reproduce Google's proprietary algorithm. The triangle uses frame-based position/heading interpolation and predicts at most three seconds ahead without coasting through an unconfirmed turn. Geofences always use raw GPS. Poor or stale GPS freezes prediction and is marked as delayed. Route recalculation handles movement away from the route and periodic traffic refreshes.

References: [Routes API](https://developers.google.com/maps/documentation/routes/compute_route_directions), [vehicle types](https://developers.google.com/maps/documentation/routes/vehicles), [display policies](https://developers.google.com/maps/documentation/routes/policies).

## Connect your friends' agents

The friends' matching/decision/logistics implementation is assumed to provide accepted, safety-checked shares. It is not reimplemented here. Connect it at the **NGO acceptance event**, rather than waiting for a rider to be assigned.

### Food passport and ranked NGOs → timed offers

For the listing form supplied here, call `POST /internal/delivery-legs/offers` with service authentication and a stable `Idempotency-Key`. Supply the same checked `TripInput` as below, with `partnerPhone: null`, plus:

```json
{
  "partnerPhones": ["9000000003", "9000000004", "9000000005"],
  "remainingNgos": [
    {
      "phone": "9000000006",
      "drop": { "name": "Next NGO", "address": "…", "area": "…", "notes": "…", "lat": 12.97, "lng": 77.64 },
      "partnerPhones": ["9000000007", "9000000008"]
    }
  ]
}
```

The agent owns the food assessment, NGO verification, ranking, capacity, dietary and route/serve-time eligibility, and supplies eligible volunteer waves for each ranked NGO. The donor's first listing must already be approved. The handoff creates a pending offer, stores the absolute deadline, exposes the food passport and starts the countdown. NGO acceptance through `/offers/:listingId/accept` opens the map and sends its first volunteer wave automatically. The API rechecks online/night availability and active deliveries. Broader subsequent volunteer waves remain agent callbacks.

The timer worker scans persisted trip records every second and resumes them at startup. Halfway reminders and `TIMEOUT` reservation releases are CAS-protected events. At expiry it advances only to the next supplied candidate if pickup and food-safety deadlines still fit; otherwise it records exhaustion for the Decision Agent. It never computes its own NGO ranking or extends food safety. `GET /offers` also checks due deadlines so a reconnect cannot revive an old offer. The response includes server time, offer deadlines and expired-offer messages. Persisted deadlines survive a database-backed restart; local in-memory demo records do not.

### NGO acceptance → map

Call `POST /internal/delivery-legs` with `Authorization: Bearer <LOGISTICS_HANDOFF_KEY>` and a stable `Idempotency-Key`. Send [TripInput](../api/src/trips/types.ts): listing/share IDs, donor/NGO phones, pickup/drop stops (`lat`, `lng`, `name`, `address`, `area`, `notes`), food and serving information, safety deadlines, transit limits and container requirements. Set `partnerPhone: null` and `partnerName: "Finding a delivery partner"` until a candidate exists. Set the intended `vehicle` and an initial future `requestDeadline`; assignment replaces that request deadline.

The response is:

```json
{
  "id": "dlv_…",
  "listingId": "lst_…",
  "trackingUrl": "/deliveries?id=dlv_…"
}
```

Navigate the NGO's acceptance screen to `trackingUrl` **as part of the successful acceptance response**. The donor can open the same URL or its `/deliveries` list. This navigation is the integration point for the incoming listing/agent UI. The actual app walkthrough exercises this acceptance-to-map navigation. The stream sends the accepted stops immediately and adds directions when the routing service responds.

All timestamps are UTC epoch milliseconds; UI times use Asia/Kolkata. Donor and NGO must already have profiles. The upstream Decision Agent owns verification, eligibility, capacity, diet/allergen filtering, offer reservation and serve-before-safe-until checks.

### NGO acceptance → automatic volunteer wave

The Logistics Agent immediately calls `POST /internal/delivery-legs/:id/assign` with service authentication, an `Idempotency-Key` and its eligible wave:

```json
{
  "partnerPhones": ["9000000003", "9000000004", "9000000005"],
  "vehicle": "two_wheeler"
}
```

Every wave member must have a profile; up to three distinct volunteers are supported, per spec §12.5.1. Names come from the profiles. The request appears simultaneously in each volunteer's `/partner/requests` and live `GET /partner/requests/stream`. The app subscribes globally and reconnects with the current requests. That same stream carries the volunteer’s current trip and directions, so navigation does not need another long-lived connection. Native desktop alerts are optional when the browser supports them; live in-app alerts are always active while the app is open. This is an agent callback, never an NGO button.

The first `POST /partner/requests/:id/accept` wins under CAS. Others lose trip access and receive a withdrawal in their request stream. One decline removes only that volunteer. After all decline or a wave expires, the agent supplies the next wave; the API rejects replacing an unexpired wave. The broader tier selection, ETA/reliability ranking, volunteer-wave timeout scheduling, retries, exhaustion/replanning and outbound push/WhatsApp are the friends' Logistics/Decision Agent integration. A singleton `partnerPhone` remains supported for existing service callers.

The accepting partner sends their bearer session, an `Idempotency-Key` and `{"hasContainers":true}` when required. Acceptance starts `to_pickup`; fresh GPS produces the route to the restaurant. Pickup verification and the food check switch directions to the NGO. A unique database index prevents two active deliveries for one partner. CAS and action receipts prevent duplicate transitions and repeated code attempts.

### Accepted redirect → new destination

Call `POST /internal/delivery-legs/:id/redirect` after the new NGO accepts and eligibility is rechecked. Send `shareId`, `ngoPhone`, the complete `drop`, `etaDrop`, `serveAt`, `eligibilityCheckedAt` and a short `reason`. Only a leg in `to_drop` can redirect. Safety, transit limits and Grade C serving limits cannot be extended. Eligibility must have been checked within the configured freshness window.

Redirect increments `routeRevision`, rotates the drop code, removes the previous NGO's access and recalculates the route. The old NGO's stream emits `access_revoked`; its cached view is cleared. Buffered handovers carry a route revision and cannot complete against an obsolete destination. The client discards dependent handovers when a newer destination arrives.

An admin can call `POST /trips/:id/resume` with `{"reason":"…"}` after a held code lock expires. It preserves safety limits and records the review reason. It cannot release the ten-minute lock early.

## Tracking, handovers and reconnects

`GET /trips/:id/stream` emits bearer-authenticated `snapshot`, `heartbeat` and `access_revoked` SSE frames. `fetch` keeps tokens out of URLs. Session and participant membership are rechecked every two seconds; reconnecting receives server truth. `GET /cases/:listingId/stream` supplies the authorised case's delivery-leg summaries. Trip events include NGO acceptance, partner request/acceptance, near/arrived, ETA, off-route, stationary, handover, food rejection, safety risk and SOS.

The active partner watches high-accuracy GPS and posts ten-second batches. IndexedDB retains pending raw fixes and handover actions with stable retry keys. Salted code verifiers support handovers on an already loaded offline page. Reconnection rechecks sequence, code, raw geofence and observation time; offline handovers receive a review event. A rejected transition stops dependent queued handovers and restores the server state. Queued completion is visibly marked as awaiting sync.

Only the restaurant sees its pickup code, and only the receiving NGO sees its drop code, at the relevant handover. Accurate fresh raw GPS must be within 300 metres; explicitly continuing without GPS flags a review. Three incorrect codes hold the trip. Pickup needs a photo and food checks; a failed check stops the run.

Restaurant live location sharing ends ten minutes after pickup; status continues. NGO/admin tracking lasts through the active leg. Completion stops tracking; exact addresses disappear after two hours. Closed-trip traces are deleted after thirty days and pickup photos after 180 days. Provider geometry/instructions stay in transient memory and are excluded from Postgres and IndexedDB.

## Validation and remaining launch work

```sh
cd api
npm test
npm run build
```

```sh
cd web
npm run lint
npm run build
```

The 49 backend tests cover listing submission/review, isolated demo provisioning, automatic three-volunteer notification eligibility, countdown bounds and reloads, halfway reminders, concurrent timer workers, next-NGO expiry and late-accept rejection, real agent offer handoffs, concurrent claims, declines, a shared volunteer notification/navigation stream, completed receipt and short-delivery reporting, plus delivery codes, privacy deadlines, geofences, holds, rejected food, GPS validation, prediction, routing isolation, idempotency, redirects and retention. The browser walkthrough starts from the real listing form in separate account tabs and checks the decreasing countdown across a reload, automatic notifications, road navigation, both handovers, photo/checklist, NGO receiving confirmation and donor receipt. The rider camera follows the triangle by default, and dragging pauses following. Revoking a volunteer session clears the private trip view and cached handover access. Earlier checks covered offline pickup/check reconnects and a 390 px layout.

Production still needs Google keys and real-device route/GPS checks, a Postgres persistence smoke test, and the friends' agent callbacks and outbound notification workers. Real listings stay in checking until those agents provide their food passport and ranked-offer handoff; the walkthrough fixture cannot substitute for them. Mobile web cannot guarantee GPS when backgrounded or locked; reliable background navigation needs a native client. In-app/desktop alerts here do not implement closed-app PWA push. Pickup photos currently live in private documents; production media storage remains to be connected.

## Real deliveries on the live map

Real deliveries (the agents' shares, not the walkthrough) use the same maps through [LiveDelivery](../web/src/components/trip/LiveDelivery.tsx):

- **Rider** (trip slip): their own position followed on the map, the road route to the restaurant and then the NGO, the next turn ("In 180 m · Turn right onto 16th C Main Road"), and the time and distance left. Nothing opens Google Maps outside the app.
- **Restaurant** (donation page): the rider coming to collect, with an ETA, until ten minutes after pickup.
- **NGO** (coming-to-you ticket): the rider all the way to the drop.

The rider's phone sends a GPS fix every 4 s with accuracy, speed and heading (`POST /agents/trips/:id/location`). When the phone gives no speed, the API works it out from the previous fix, so the marker can glide between fixes (the same 3-second prediction and road snapping as the walkthrough). Each app subscribes to `GET /agents/shares/:id/live` (Server-Sent Events), which sends a fresh view on every fix and handover ([live-track.ts](../api/src/matching/live-track.ts)).

With `NEXT_PUBLIC_GOOGLE_MAPS_KEY` and `GOOGLE_MAPS_ROUTES_KEY` set, these are Google Maps with Google car routes and live traffic for every rider (Compute Routes Pro: 35,000 free a month in India; two-wheeler routes would be the Enterprise tier, 7,000). Without them, the apps show OpenStreetMap with the public OSRM router, labelled "Approximate road route · no live traffic" (`LUNA_MAP_FALLBACK=off` turns the fallback off).
