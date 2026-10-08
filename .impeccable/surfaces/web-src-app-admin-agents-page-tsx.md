---
version: 1
slug: "web-src-app-admin-agents-page-tsx"
primary_target: "web/src/app/admin/agents/page.tsx"
related_targets: ["web/src/components/agents-board"]
---

# Surface: Agents at work (admin, projector first)

Mode: Operate, presented. Audience: hackathon judges watching a projector while a teammate lists food from a donor phone; the Luna team afterwards.
Job: show, for each listing, what each of the four agents (Food, Decision, NGO, Logistics) is doing, what they say to each other, and how one listing travels end to end. A second listing prints a second row of four boxes below the first.
Scope: live only, from GET /agents/reasoning/stream (snapshot, events, status); listing names from GET /agents/admin/listings. Admin only. Reached from a "Show agents" bar button on the admin map. No recorded or sample runs (user's answer).
Decided with the user: colour die-cut sticker mascots (pizza = Food, chef's hat = Decision, tiffin = NGO, scooter = Logistics) as the one colour exception on this page; code-led.
Unresolved: none.

## Direction contract

THESIS: Four little ticket printers on one counter, one row per listing; each agent prints its own part of the order, and a hand-off is a paper chit sliding along the rail from one printer to the next. It refuses the glowing node graph and the chat transcript.

OWN-WORLD: Kitchen Ticket: steel counter, dark printer housings with LEDs, thermal paper with tear edges, two inks, Martian Mono data, Hanken notes. Colour lives only on the four die-cut stickers stuck on the housings.

STORY: Judges meet the cast, a phone lists food, a row prints in, Pizza wakes and grades, a chit slides to Chef, Tiffin finds NGOs, Scooter runs the trip, stamps land Checked, Matched, Picked up, Delivered; a second listing prints below.

FIRST VIEWPORT: Printer bar (Agents at work, live chip, Clear the board, Call sheet, Food map); the cast strip of four large stickers with name and job; the first listing row: order slip, four printer boxes, the hand-off rail.

FORM: four stations per order with a hand-off rail, pinned by the user's brief (no roll).

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
