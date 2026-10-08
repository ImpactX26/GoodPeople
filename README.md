# Luna

Surplus food to people who need it, before it goes bad. Bengaluru pilot (OSC AI Build 1.0, Team GoodPeople).

| Part | Folder | Hosted on | URL |
|---|---|---|---|
| Frontend (Next.js) | `web/` | Netlify | https://luna-food-blr.netlify.app |
| Backend (Hono + Postgres) | `api/` | Railway | https://api-production-a32be.up.railway.app |
| Food Agent + NGO Matching Agent (Python, FastAPI) | `luna_ngo/` | Local for now | http://127.0.0.1:8000 |

## Team setup (run the frontend on your laptop)

You need Node 22+ and git. You don't need a Railway or Netlify account.

```sh
git clone https://github.com/Artificialhuman74/luna.git
cd luna/web
npm install
npm run dev          # https://localhost:3000
```

- Your local frontend talks to the **live backend on Railway**. The URL is in `web/.env.development`, so it works straight after cloning.
- The first `npm run dev` makes a localhost HTTPS certificate and asks for your computer password once, to trust it. Then the browser shows no warning. If you'd rather skip HTTPS, run `npm run dev:http` (http://localhost:3000).
- Sign in with any 10-digit number starting with 6–9. The code is always `123456` (no SMS is sent).
- Everyone shares the same backend and database, so sign-ups and data you create are visible to the whole team.

### Changing things

| You change | What happens when it's pushed to `main` |
|---|---|
| `web/` (frontend) | Nothing is deployed. The public Netlify site only changes when Chiranth deploys it by hand. Push freely. |
| `api/` (backend) | **Deploys to Railway automatically** and goes live for everyone within a few minutes. Test locally first (below). |

For bigger changes, work on a branch and open a pull request: `git switch -c my-change`, push, then open the PR on GitHub.

### Running the backend locally (optional)

```sh
cd api
npm install
npm run dev          # http://localhost:8787, data kept in memory
```

To point your frontend at it, create `web/.env.development.local` containing `NEXT_PUBLIC_API_URL=http://localhost:8787` and restart `npm run dev`. Delete that file to go back to Railway.

## How deploys work

- **Backend:** every push to `main` that touches `api/` redeploys it to Railway (GitHub Action `deploy-api.yml`). Check it at `/health`.
- **Frontend:** never deployed automatically. Netlify isn't connected to GitHub; Chiranth deploys from `web/` with `netlify deploy --prod --build`, only on purpose.

## Donor: list food → freshness grade (in the Next.js app)

Sign in as a **Donor** → **List food** (`/donor/list`). Take or choose a photo, add what it is, portions, when it was cooked, how it's stored and the temperature. The listing goes to the Food Agent (`POST /api/luna/submissions` with the donor's name and area as the pickup point), which returns:

- **Grade A / B / C / D + Unsure flag** (`docs/LUNA-SPEC.md` §8.6): A *Premium* (safe ≥ 6 h), B *Good* (3–6 h), C *Serve now* (< 3 h), D *Not for people* (a safety rule failed, or the photo shows spoilage or contamination). The photo can only lower the grade. *Unsure* means the photo wasn't judged confidently. Safe hours come from your agent's category × storage limits. There's also a **freshness score 0–100** (safe time left, blended with the photo when judged). Tunable in `config/ngo_agent.json` → `food_safety.freshness`.
- **Safe until**: when the safe window closes (none for grade D).
- **Live case status from the Decision Agent** (the orchestrator, spec §13/§14.4): a status bar *Listed → Checked → Offered → NGO accepted → Picked up → Delivered*, a **NOW / NEXT** line, and a timeline ("Offered to …", "… couldn't take it", "Accepted by …"). If no NGO can take it, it says **No NGO available** and until when the food is safe. Delivered turns on when the NGO's OTP is verified.

Listings made before grading existed are graded on read, as of when they were listed. Without an LLM key the photo isn't judged, so the grade is *Unsure* and uses time, storage and temperature only (the page says so). Past listings: `GET /api/luna/submissions?donor_id=DONOR-<phone>`.

## The rescue flow: donor → listed NGOs → delivery partner

1. **Donor** (`/donor/list`) lists food with a photo. The Food Agent grades it (Gemini).
2. If it's safe, the **NGO Agent ranks the NGOs listed in the NGO portal by priority** (need and urgency, capacity fit, distance, food fit, open hours, reliability, load) and offers the food to the top one. The donor sees the ranking. A decline or no reply in `confirmation.live_timeout_seconds` (120 s) passes it to the next NGO.
3. The **NGO** that accepts (`/ngo/offers`) **sends a delivery partner**: name + mobile number of a Luna volunteer.
4. The **delivery partner** (sign in as **Volunteer** → `/volunteer/tasks`) goes to the restaurant and enters the **pickup code** shown on the donor's screen, then takes the food to the NGO and enters the **drop code** shown on the NGO's screen. A drop can't be confirmed before the pickup.
5. **Status bars on every side**, kept live by the Decision Agent. Donor: *Listed → Checked → Offered → NGO accepted → Partner coming → Picked up → Delivered*. NGO: *Accepted → Partner sent → Picked up → Delivered*. Partner: *Assigned → Picked up → Delivered*.

Codes are shown only to their holder (spec §13.5): the pickup code to the donor, the drop code to the NGO; the partner and ops views never include them. The flow runs in `LIVE` mode (`flow.mode` in `config/ngo_agent.json`); `DEMO` uses sample NGOs and simulated replies.

| Page | Who | What it does |
|---|---|---|
| `/donor/list` | Donor | List food, see the grade, the NGO ranking, the live status and the pickup code |
| `/ngo/list` | NGO | List yourself (need, capacity today, hours, food you accept, food rules, location) and see every listed NGO; mark yourself open / full / closed |
| `/ngo/offers` | NGO | Offers with a countdown; accept or decline; send a delivery partner; drop code; live status |
| `/volunteer/tasks` | Delivery partner | Runs assigned to your number: where to collect and drop, directions, what to bring, pickup and drop codes |

Run both together (or just run `start-luna.ps1`):

```powershell
# terminal 1, repo root: the NGO agent
.\.venv\Scripts\Activate.ps1
python run.py                 # http://127.0.0.1:8000

# terminal 2: the frontend
cd web
npm run dev                   # https://localhost:3000 → sign in as NGO
```

The frontend finds the agent at `NEXT_PUBLIC_NGO_API_URL` (default `http://localhost:8000`, set in `web/.env.development`). The agent allows any `localhost` origin; add others with `LUNA_CORS_ORIGINS=https://a.example,https://b.example`.

To try it end to end: sign in with two or three numbers (code `123456`) and list an NGO from each. Sign in as a Donor and list food; decline it in `/ngo/offers` as the top NGO, accept as the next, send a partner using another number, then sign in as a Volunteer with that number and enter the two codes.

API for the delivery steps: `POST /api/ngo-agent/{match_id}/partner` `{ngo_id, partner_name, partner_phone}`, `POST /api/ngo-agent/{match_id}/pickup` `{partner_phone, otp}`, `POST /api/ngo-agent/{match_id}/verify-otp` `{ngo_id, otp}` (drop), `GET /api/partner/tasks?phone=`.

---

# Food Agent → NGO Matching Agent (Python)

**End-to-end flow, zero clicks after submit.** A restaurant uploads a photo + details at `/` →
the **Food Agent** (VLM + deterministic food-safety rules + LLM reasoning) decides eligibility and a Luna Rescue Score and issues a **Food Passport** →
the **Luna Orchestrator** hands it automatically to the **NGO Matching Agent** (find → filter → rank → select → confirm → replan) → a **Match** that is ready for the future Logistics Agent.

| URL (Python server) | Who | Shows |
|---|---|---|
| `/` | Restaurant | The simple upload form and plain-language progress only (no reasoning, tool calls, JSON or logs) |
| `/ops?match=<id>` | Judges / ops | Full agent view: activity feed, scoring, replans. Also `/ops` for the 7 NGO scenarios |
| `/portal` | NGO | Accept / decline requests (LIVE mode). Superseded by `/ngo/offers` in the Next.js app |

Flow settings live in `config/ngo_agent.json` (`flow`, `food_safety`). `LUNA_MODE=LIVE|DEMO` and `LUNA_DEMO_SCRIPT=accept_all|first_rejects` override them.
DEMO = synthetic NGOs + simulated NGO confirmations (labelled). LIVE = real NGO database + portal confirmations; with no vision model configured, LIVE sends food to manual review rather than approving it unseen.
Photo analysis needs an LLM key with vision (Claude or an OpenAI-compatible vision model); without one the app says "basic image check" and DEMO still runs.
Contract: `POST /api/luna/submissions` → `GET /api/luna/submissions/{id}` (public) / `/{id}/ops` (full, includes the Food Passport and `ready_for_logistics`).

## NGO Matching Agent

Autonomous agent that takes an **eligible Food Passport** from the Food Agent, finds the NGO(s) most likely to successfully receive and distribute the food before the rescue window closes, gets their confirmation, and **re-plans on its own** when an NGO rejects, times out or goes offline.

* LLM = decision-maker (tool selection, interpretation, choice, explanations)
* Deterministic engine = every number (distance, ETA, capacity, hours, compatibility, scores, feasibility)
* SQLite = persistent state, memory and audit trail
* Dashboard = human-readable live view for judges / coordinators, plus an NGO portal

Full design: [`docs/ngo-agent-architecture.md`](docs/ngo-agent-architecture.md)

## Quick start (Windows PowerShell)

```powershell
cd F:\NGOagent
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt

copy .env.example .env      # then put your keys in .env:  ANTHROPIC_API_KEY=sk-ant-...  (food check: GEMINI_API_KEY=...)
python run.py               # http://127.0.0.1:8000   (restaurant page: /, ops: /ops, NGO portal: /portal)
```

macOS / Linux: same, with `source .venv/bin/activate` and `cp`.

No API key? The app still runs: it uses the **rule-based fallback**, and says so everywhere (badge, feed, result `reasoning_source`). Set a key to see the real LLM agent.

### LLM options

| Provider | `.env` |
|---|---|
| Claude (default) | `ANTHROPIC_API_KEY=...` (optional `LUNA_LLM_MODEL=`) |
| OpenAI / Groq / OpenRouter / Gemini (OpenAI-compatible) / Ollama | `LUNA_LLM_PROVIDER=openai`, `LUNA_LLM_API_KEY=...`, `LUNA_LLM_MODEL=...`, `LUNA_LLM_BASE_URL=...` |

**Food safety check** (photo check + Food Agent) uses its own provider, Google Gemini `gemini-3.5-flash` (falling back to 3.5 Flash-Lite, 3.1 Flash-Lite, then Groq if `GROQ_API_KEY` is set): `GEMINI_API_KEY=...` (key from https://aistudio.google.com/apikey). Change it with `LUNA_FOOD_LLM_PROVIDER` / `LUNA_FOOD_LLM_MODEL`. Everything else uses the provider above.

## Run the tests

```powershell
python -m pytest -q
```

83 tests (58 NGO agent + 25 Food Agent / freshness grade / orchestrator / API flow): passport validation, filtering, capacity/demand matching, distance, ETA feasibility, receiving hours (incl. overnight), compatibility, ranking, configurable weights, rejection, timeout, unavailability, splitting, no-feasible match, re-planning, LLM failure (fallback and no-fallback), database failure, invalid NGO data, guardrails against a misbehaving LLM, Anthropic/OpenAI wire formats, REST API, live-mode portal confirmation, reject → next NGO → accept with OTP/ETA/delivery notes → OTP verification.

## Demo for judges

1. `python run.py`, open http://127.0.0.1:8000 (Demo mode is selected; the amber banner says everything is simulated).
2. Choose **"2 · Best NGO rejects → autonomous replan"**, press **Send Food Passport** and don't click anything else.
3. Watch: 10 NGOs found → filter funnel (status, compatibility, capacity, receiving hours) → ranking → Hope Foundation selected → confirmation requested → **Hope rejects** → the agent observes it, re-plans with the time that's left, picks the next NGO, requests confirmation → **accepted → MATCH COMPLETE** with a Logistics hand-off.
4. Show "Why?" on a candidate card: per-factor bars and weights.
5. Other scenarios: perfect match, NGO goes offline mid-confirmation, split donation (200 meals), food too urgent (28 min), no feasible NGO (explained), NGO never responds (timeout).
6. Live chaos: in any demo run, press **⚡ Simulate going offline** on the NGO that's awaiting confirmation — the agent detects it and re-plans.
7. Be the NGO: open `/portal` → "Demo requests" and Accept/Decline before the simulator does.

## API

### Railway backend (`api/`)

| Method | Path | |
|---|---|---|
| POST | `/auth/otp` | `{role, phone}`. Dev code `123456`, no SMS. Returned as `devCode` while `SHOW_DEV_OTP=1`. |
| POST | `/auth/verify` | `{role, phone, code}` → `{ok, isNew, token, profile}` |
| GET / PUT | `/me`, `/me/profile` | `Authorization: Bearer <token>` |
| POST | `/auth/logout` | |
| GET | `/map/week` | All map data for the week (sample data) |
| GET | `/map/areas/:id` | One area's details |

Backend variables (Railway): `DATABASE_URL` (from the Postgres service), `DEV_OTP`, `SHOW_DEV_OTP`, `CORS_ORIGINS` (the Netlify URL; localhost is always allowed).

### NGO agent (`luna_ngo/`)

| Method | Path | |
|---|---|---|
| POST | `/api/ngo-agent/match` | Start matching. Body: Food Passport, or `{food_passport, mode, brain}`. `?wait=true` for synchronous. |
| GET | `/api/ngo-agent/match/{match_id}` | Full live view (state, events, attempts). `?view=result` → Match Result only. Never includes the OTP. |
| GET | `/api/ngo-agent/matches?mode=` | Recent matches |
| POST | `/api/ngo-agent/{match_id}/confirmation` | NGO answer `{ngo_id, response: ACCEPTED/REJECTED, reason, delivery_notes}`. On ACCEPTED returns `{otp, eta_at, delivery_notes}` |
| POST | `/api/ngo-agent/{match_id}/verify-otp` | Delivery partner hand-over `{ngo_id, otp}` → `{verified}` |
| POST | `/api/ngo-agent/{match_id}/replan` | Operator re-plan `{exclude_ngo_ids, note}` (running or finished) |
| POST | `/api/ngo-agent/{match_id}/split` | Deterministic split analysis `{quantity?}` |
| GET | `/api/ngos?mode=` · `/api/ngos/{id}?mode=` | NGO data (+ observed history) |
| POST | `/api/ngos?mode=LIVE` | Create/update an NGO (validated; synthetic data refused in LIVE) |
| PATCH | `/api/ngos/{id}/status` · `/api/ngos/{id}/demand` | Live operational updates |
| GET/POST | `/api/demo/scenarios` · `/api/demo/scenarios/{id}/run` | Demo |
| GET | `/api/portal/pending?mode=&ngo_id=` | Pending confirmation requests for the NGO portal |
| GET | `/api/portal/offers?mode=&ngo_id=` | One NGO's inbox: pending offers (respond-by, rescue score, distance) and accepted ones (OTP, ETA, delivery notes) |

Interactive docs: http://127.0.0.1:8000/docs

## Live mode

1. Load real NGOs: they list themselves at `/ngo/list` in the Next.js app, or edit `data/ngos_live_template.json` and run `python scripts/load_live_ngos.py data/ngos_live_template.json` (or `POST /api/ngos?mode=LIVE`).
2. The Food Agent posts passports to `POST /api/ngo-agent/match` (or use `/ngo/agent`).
3. NGOs confirm in `/ngo/offers` (or `/portal`, or via their webhook + the confirmation API). No simulated responses exist in LIVE mode.

## Layout

```
web/                   Next.js frontend (sign-in, role homes, food map, NGO portal under src/app/ngo/)
api/                   Hono backend on Railway (auth, profiles, map data)
luna_ngo/
  models.py            data contracts (FoodPassport, NGO, MatchResult, states)
  db.py                SQLite tables + repository (incl. delivery OTP / ETA hand-off)
  config.py            config/ngo_agent.json loader (+ .env)
  engine/              deterministic: geo, passport validation, checks, scoring/ranking/split
  agent/
    tools.py           the 19 agent tools (+ guardrails)
    policies.py        LLMPolicy (system prompt) and labelled RuleBasedPolicy fallback
    llm.py             Anthropic + OpenAI-compatible tool-calling clients
    runner.py          the agent loop + limits + safe failure
    confirmation.py    live portal channel + demo simulator
    result.py          deterministic Match Result builder
  food/                Food Agent (vision, safety policies)
  demo/scenarios.py    7 demo scenarios (synthetic, labelled)
  service.py, api.py   application service + FastAPI
frontend/              Python-served dashboard (index.html), restaurant page (luna.html), NGO portal (portal.html)
config/ngo_agent.json  weights, limits, timeouts, ETA model
docs/                  architecture
tests/                 pytest suite
```

### Luna's agents (Food, NGO, Logistics, Decision)

All need `Authorization: Bearer <token>` for the role shown (admin can call everything). Delivery partners sign in with the `volunteer` role. NGOs and partners can also do all of this on WhatsApp. How the agents work: see `agent.md`.

Mounted under `/agents` on the Luna API (so `/agents/shares`, `/agents/trips`, …); listings come in through `POST /listings` (food check first) and are handed to the Decision Agent.

| Role | Method | Path | |
|---|---|---|---|
| Restaurant | POST | `/listings` | The Food Passport: `{items:[{servings, grade, confidence, safeTime, name?, quantity?:{amount, unit}, packing?, tags?, diet?, halal?, allergens?}], containers?, cookedAt?, storage?, area?, lat?, lng?, pickupAddress?, pickupNotes?, pickupContactPhone?, readyFrom?, collectBy?}` |
| Restaurant | GET | `/listings`, `/listings/:id` | Your listings; one listing's shares (with pickup codes) and decision timeline |
| Restaurant | POST | `/pledges/:id/yes\|no` | Answer a gap request |
| NGO | GET / POST | `/shares`, `/shares/:id/accept\|decline`, `/shares/:id/redirect/accept\|decline` | Food offers (with drop codes once a partner is coming) |
| NGO | POST | `/shares/:id/assign`, `/shares/:id/feedback` | `{name, phone?}` assigns someone by hand; `{result: fewer\|right\|more}` after delivery |
| Partner | POST | `/partner/online` | `{online, lat?, lng?}` |
| Partner | GET / POST | `/trips`, `/trips/:id/accept\|decline\|late` | Pickup requests and trips |
| Partner | POST | `/trips/:id/location`, `/trips/:id/pickup\|drop` | `{lat, lng}`; `{code}` (the NGO coordinator enters codes for someone assigned by hand) |
| Any party | GET | `/shares/:id/track` | Partner position and ETA for the map |
| Admin | GET | `/admin/decisions?listingId=&since=`, `/admin/escalations` | Every agent decision with its reason; things needing a person |
| Admin | POST | `/admin/listings/:id/approve` | Approve a new restaurant's first listing |
| Admin | GET / POST | `/admin/recipients`, `/admin/partners`, `/admin/recipients\|partners/:id/claim` | Sample NGOs and partners; `{phone}` binds a real phone to one |
| Admin | POST | `/admin/gaps/run` | Run gap outreach now |
| Meta | GET / POST | `/webhooks/whatsapp` | WhatsApp webhook |

Sample NGOs and partners that no real phone has claimed answer automatically, so a listing runs end to end in the demo. Claim some with team phones to take part for real.

Backend variables (Railway): `DATABASE_URL` (from the Postgres service), `DEV_OTP`, `SHOW_DEV_OTP`, `CORS_ORIGINS` (the Netlify URL; localhost is always allowed). Matching and WhatsApp variables are listed in `api/.env.example`.
