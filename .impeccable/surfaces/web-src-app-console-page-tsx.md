---
version: 1
slug: "web-src-app-console-page-tsx"
primary_target: "web/src/app/console/page.tsx"
related_targets: []
---

# Surface: Agent console (admin, desktop/projector first)

Mode: Operate. Audience: the Luna team and, on demo day, judges watching a projector while donor, NGO and rider phones run the ordinary app.
Job: watch the four agents (Food, Decision, NGO, Logistics) hand work to each other live, see each agent's rules decide instantly and its LLM reasoning arrive a second later, see what reached the people, and step in on flags.
Scope: live trace from GET /agents/reasoning/stream (snapshot, events, status, pulse); cases from GET /agents/admin/listings. Admin only.
Decided on the user's behalf (standing preference: proceed with recommended defaults, no design questions): structure dealt by the roll and kept; code-led (no comp round).
Unresolved: replay of a recorded run (phase 3).

## Direction contract

THESIS: The console is the expediter's call sheet on the pass: every hand-off is called from one station and answered HEARD by the next, and each station's reasoning is clipped under its own column. It refuses the glowing node-graph dashboard and the chat-log feed.

OWN-WORLD: Kitchen Ticket, unchanged: steel counter, printer bar, rail tickets, paper sheet, torn slips, two inks, Martian Mono data, Hanken notes. Agent stations are small printer housings with their own LED (green idle, amber blinking while reasoning); people are dashed boxes.

STORY: A donor lists food on a phone; the Food station calls Decision, arrows print across the lanes, HEARD stamps land, a reasoning slip prints under NGO a second later with its verdict, and the NGO phone buzzes as its lane lights.

FIRST VIEWPORT: Printer bar (Agents live, Show segmented); case rail; call sheet with seven lanes (Restaurant, Food, Decision, NGO, Logistics, NGO, Rider) and the newest calls at the foot; reasoning slip and model card at right; watcher tape at the foot.

FORM: call sheet (sequence diagram as printed calls), position 5 of 6 on the ranked list, seed key 80ef1b07.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
