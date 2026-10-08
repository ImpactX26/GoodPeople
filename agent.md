# Luna's agents

How surplus food gets from a restaurant to the people who need it. Four agents each do one job, talk to each other through typed events, and log every decision with a plain-language reason.
Code: `api/src/matching/` (agents) and `web/src/components/agents/` (screens) · Tests: `api/test/matching/` (`cd api && npm test`).

## 1. Why

Food in Bengaluru isn't short; coordination is. A restaurant with 50 spare meals at 10 pm doesn't know which NGO can use them, and nobody arranges the pickup. Luna's agents:
- check the food;
- pick the NGOs;
- find a delivery partner;
- run the trip;
- change the plan when something goes wrong.

Safety rules always win, and every decision is explained so an admin can trust it and step in.

## 2. The agents

```
restaurant ─▶ Food Agent ──Food Passport──▶ Decision Agent ──▶ NGO Agent ──shares──┐
                                              ▲  (opens, runs, closes the case)     │
                                              └──── events ◀── Logistics Agent ◀────┘
                                                               (offer, partner, codes, trip)
```

| Agent | Job | Status |
|---|---|---|
| **Food Agent** | Reads photo, cooked time, storage and ingredients. Gives a score, a "safe until" time and a grade A–D (the stricter of model and rules wins; Grade D never goes to people). Converts items to servings, checks tags, and outputs the **Food Passport** | Feature 2, another team. Stand-in: `food-agent.ts` |
| **NGO Agent** | Filters out NGOs that can't safely take the food, ranks the rest, and splits the servings into **shares**, each with a ranked NGO list | Being built separately. Stand-in: `ngo-agent.ts` |
| **Logistics Agent** | Runs each share from the offer to the drop | **Built:** `logistics-agent.ts` |
| **Decision Agent** | Opens the case, connects the agents, keeps the restaurant, NGO and partner updated, re-plans, redirects on delays, escalates, logs, closes the case | **Built:** `decision-agent.ts` |

The stand-ins use our rules engine so the whole flow runs today. A real Food or NGO Agent replaces its stand-in by producing the same Food Passport (`Listing` + `Item`) or `SharePlan`.

## 3. The flow

1. **The restaurant lists food:** photos; per item the name, tags, packing and how much (`6 kg`, `4 L`); when it was cooked and how it's been stored; the containers the partner must bring.
2. **Food Agent:** Food Passport. The **Decision Agent** opens the case. A new restaurant's first listing waits for an admin.
3. **NGO Agent:** filters, ranks and splits into shares. The hard rules (never relaxed):

   | Rule | Meaning |
   |---|---|
   | Safe until served | Still safe when the NGO *serves* it, not just when it arrives |
   | Grade D | Animal shelters or compost only |
   | Vulnerable groups | Grade A only |
   | Grade C ("serve now") | Only where it's served within 60 min of arriving |
   | Fridge | Fridge food only where there's a fridge |
   | Diet | Veg, Jain, egg, non-veg, halal and allergens must match |

   Ranking: urgency, travel, how much they can take, vulnerable groups, strict-diet priority, hunger level (Fair Share), priority owed after a redirect.

4. **Logistics Agent, for each share:**
   - **Offer** to the top NGO with a countdown (remaining safe time ÷ 6, 2–10 min). An NGO is **only offered food if a partner is online who could collect it in time**. Reject or no answer means the next NGO on the share's list.
   - **Find a partner** once the NGO accepts: the NGO's own riders online first, then independents, nearest first, one at a time. Each gets **3 minutes** to accept (**90 s** for serve-now food). If nobody can collect, the share goes to the next NGO.
   - **Manual assignment:** an NGO coordinator can instead assign someone by hand, e.g. staff not on the app. The coordinator then enters that person's codes.
   - **Partner accepts:** the Decision Agent tells the restaurant who's coming, when, and what to keep ready ("Ravi, 9:55 pm, keep 6 kg biryani + 4 L payasam ready", plus the pickup code). The NGO gets the drop code. The partner sees the container list before accepting.
   - **Pickup code:** the restaurant shows it and the partner enters it. The trip then runs in the app on the map (location updates, ETA).
   - **Drop code:** the NGO shows it and the partner enters it. 3 wrong codes hold the trip and call an admin.
   - **Delays:** checkpoints, "Running late" taps (+15 min) and location pins re-check the trip. Still safe means the NGO gets a new ETA. Not safe means the **Decision Agent redirects** to the best NGO reachable from the partner (2-minute offer); the first NGO gets priority on its next listing.
   - **Every NGO on the list passed:** the share goes back to the Decision Agent, which asks the NGO Agent to re-plan those servings.
5. **The Decision Agent closes the case:**
   - the restaurant gets a receipt ("Delivered to Hope Shelter, fed 10");
   - the NGO taps how it went: **fed fewer / about right / more**. This is recorded for the portion table, NGO reliability and hunger levels, which the Food and NGO Agents own.

**Proactive mode:** every hour the Decision Agent finds heat-map gaps 3–6 h ahead and asks up to 3 nearby restaurants for surplus, at most 1 request a day and 3 a week each. A Yes gives that restaurant's next listing a boost for the gap area, and a nearby partner gets a heads-up.

**Escalations** (`/admin/escalations`): food nobody can safely take, every NGO passed, no partner, redirect impossible, wrong codes 3 times.

## 4. How it's built

- **Rules, not an LLM, decide.** Deterministic, explainable and tested against the SRS examples.
- **One writer at a time.** Every entry point runs through one queue (`luna.ts`), and every status change is a compare-and-set in the store. An Accept tap racing a timeout can't both win.
- **Agents talk through events.** Logistics reports `ngo_accepted`, `partner_assigned`, `picked_up`, `delivered`, `unplaced`, `behind_schedule`, `unsafe_delay`, `redirected` and `stuck`; the Decision Agent acts on each one.
- **Who messages whom.** Logistics messages the people it's negotiating with: NGOs being offered food, partners being asked, the partner on a trip. The Decision Agent sends all status updates.
- **Polling, not timers.** Deadlines are stored and a 5-second tick handles what's due, so restarts lose nothing.
- **Outbox for messages.** WhatsApp sends retry up to 5 times; a failed send never undoes a decision.
- **Bengaluru time** (UTC+5:30) for serving times, gap windows and every message, whatever zone the server runs in.
- **Storage:** one Postgres table (`matching_docs`) on Railway, in memory locally.

| File | Role |
|---|---|
| `luna.ts` | Wires the agents together; the API everything else calls |
| `decision-agent.ts`, `logistics-agent.ts` | The two built agents |
| `food-agent.ts`, `ngo-agent.ts` | Stand-ins for the Food and NGO Agents |
| `engine/` | Rules, ranking, splitting, distances (straight line × 1.4), plain-English reasons |
| `runtime.ts` | Shared queue, decision log (each entry records which agent decided), outbox, helpers |
| `routes.ts` | REST API, and `parseListing()`: the only place the Food Passport is read |
| `whatsapp/` | Cloud API client, webhook, message texts, outbox |
| `seed.ts`, `gaps.ts`, `hooks.ts`, `config.ts` | Sample NGOs and partners, gap closing, the Fair Share hook, every tunable number |

### Food Passport fields (`POST /listings`)

| Level | Field | From | Required |
|---|---|---|---|
| Item | `servings`, `grade` (A–D), `confidence` (0–100), `safeTime` (min) | Food Agent | Yes |
| Item | `name`, `tags`, `packing`, `quantity` (`{amount, unit}`), `diet`, `halal`, `allergens` | Restaurant / Food Agent | No |
| Listing | `containers`, `cookedAt`, `storage`, `area` or `lat/lng`, `pickupAddress`, `pickupNotes`, `pickupContactPhone`, `readyFrom`, `collectBy` | Restaurant | No (safe defaults) |

The field names are placeholders until the Food Agent lands. Renaming them only touches `parseListing()` and `types.ts`.

### API

| Who | Endpoints |
|---|---|
| Restaurant | `POST /listings`, `GET /listings`, `GET /listings/:id` (shares with **pickup codes**, timeline), `POST /pledges/:id/yes\|no` |
| NGO | `GET /shares` (with **drop codes**), `POST /shares/:id/accept\|decline`, `POST /shares/:id/redirect/accept\|decline`, `POST /shares/:id/assign {name, phone?}`, `POST /shares/:id/feedback {result: fewer\|right\|more}` |
| Partner (`volunteer` sign-in) | `POST /partner/online {online, lat?, lng?}`, `GET /trips`, `POST /trips/:id/accept\|decline\|late`, `POST /trips/:id/location {lat, lng}`, `POST /trips/:id/pickup\|drop {code}` |
| Anyone on the share | `GET /shares/:id/track`: partner position, ETA, containers, what to keep ready |
| Admin | `GET /admin/decisions`, `GET /admin/escalations`, `POST /admin/listings/:id/approve`, `GET /admin/recipients\|partners`, `POST /admin/recipients\|partners/:id/claim {phone}`, `POST /admin/gaps/run` |
| Meta | `GET/POST /webhooks/whatsapp` |

WhatsApp buttons:
- `share:` NGO offer
- `redirect:` mid-trip offer
- `ask:` partner request
- `trip:<id>:late`
- `fb:` feedback
- `gap:` restaurant pledge

A partner texts a 4-digit code: it's taken as the pickup code before pickup and the drop code after. Location pins update the trip.

### Frontend (`web/`)

Each role's home in the web app talks to the agents. Screens refresh every few seconds, so offers, countdowns and trips stay live.

| Screen | What it does |
|---|---|
| Restaurant (`/donor`) | List food: dish, servings, how much (kg/L/pieces/trays), diet, storage, containers, pickup note. Grade, safe time and confidence are entered by hand until the AI Food Checker is connected. Then each donation shows where every share went, its status, the **pickup code** to show the partner, and the agents' reasons |
| NGO (`/ngo`) | Offers with a countdown and Accept/Decline; urgent redirect offers; assign someone by hand while a partner is being found; the **drop code**; code entry for a hand-assigned person; "fed fewer / about right / more" |
| Partner (`/volunteer`) | Online/offline; pickup requests with a countdown and the container list; the trip (address, contact, directions, pickup code, then drop code, Running late). Shares the phone's location while on a trip |
| Admin (`/admin`, desktop) | In the map's side panel: the agent decision feed, escalations, first-listing review, and linking team phones to sample NGOs and partners |

The API client is `web/src/lib/luna/agents.ts`. Linking: an NGO or partner account only sees offers once an admin links its phone (Admin → Link people), until real onboarding exists.

### Tests

42 tests cover:
- every rule and the Bengaluru clock;
- all five SRS examples;
- the whole flow (offer → partner → pickup code → drop code → receipt → feedback);
- the three decisions: partner-online check, manual assignment, 3 min / 90 s windows;
- next NGO on decline, timeout, or no partner;
- re-planning when a share's list runs out;
- own riders before independents;
- wrong codes, codes and pins over WhatsApp, duplicate webhooks;
- the trip map, restarts, first-listing review, a fully simulated run, the redirect.

The deploy workflow runs them before every backend deploy.

## 5. What it needs to run

### Demo

| Need | How |
|---|---|
| NGOs and partners | Seeded: 18 sample NGOs from the heat map plus an animal shelter and a compost unit; one independent partner per area and one rider for each NGO and shelter |
| A run without phones | `MATCHING_SIMULATE=1` (default): sample NGOs and partners answer on their own and travel 10× faster; their messages are logged |
| Real people | `POST /admin/recipients\|partners/:id/claim {phone}`. Up to 5 phones on the WhatsApp test number |
| Real WhatsApp | On Railway: `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_TOKEN`, `WHATSAPP_VERIFY_TOKEN`. Webhook in Meta's dashboard: `https://api-production-a32be.up.railway.app/webhooks/whatsapp` (subscribe to `messages`). Each demo phone sends "hi" to the test number first |
| First listing | Approve it (`/admin/listings/:id/approve`) or set `MATCHING_REVIEW_FIRST=0` |

### Production

| Need | Why |
|---|---|
| Real Food Agent and NGO Agent | Replace the stand-ins (same Food Passport / `SharePlan`) |
| Partner and NGO app polish | The screens work; a live map view of the trip and push notifications are still to do |
| Real NGO and partner onboarding | Locations, serving times, diet rules, capacity, riders, phones, replacing sample data and claims |
| Verified WhatsApp number + approved templates (`luna_food_offer`, `luna_partner_task`, `luna_donation_update`, `luna_delivery_update`, `luna_gap_request`), then `WHATSAPP_TEMPLATES=1` | The test number reaches only 5 phones, and Luna starts conversations |
| `WHATSAPP_APP_SECRET`, long-lived token | Webhook signature check; the setup-page token expires in 24 h |
| `MATCHING_SIMULATE=0` | Only real people |
| Real admin authentication | Today anyone can sign in as admin with the dev code |
| Feedback used by the Food and NGO Agents | It's recorded; updating portions, reliability and hunger levels is their job |

### Settings (`api/.env.example`)

| Variable | Default | Purpose |
|---|---|---|
| `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_TOKEN` | — | Send messages |
| `WHATSAPP_VERIFY_TOKEN` | — | Webhook registration |
| `WHATSAPP_APP_SECRET` | — | Webhook signature check (optional) |
| `WHATSAPP_TEMPLATES` | `0` | `1` once templates are approved |
| `MATCHING_SIMULATE` | `1` | Sample NGOs and partners act on their own |
| `MATCHING_REVIEW_FIRST` | `1` | Admin checks a new restaurant's first listing |

Countdowns, accept windows, weights and contact caps live in `config.ts`.

## 6. Decisions and limits

- **Three flow decisions:**
  - offer only when a partner is online nearby;
  - NGO coordinators may assign someone by hand;
  - 3 min for partners to accept, 90 s for serve-now food.
- **Codes, not photos:** pickup code from the restaurant, drop code from the NGO, 4 digits each.
- **Privacy:**
  - the restaurant sees only pickup codes, the NGO only drop codes, the partner neither;
  - phone numbers are shared only between people in an active delivery.
- **Distances are estimates;** partners get free Google Maps links for directions.
- **Sample data:** all NGO, partner and restaurant names in the seed are made up.
