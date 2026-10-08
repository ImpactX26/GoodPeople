---
version: 1
slug: "web-src-app-map-page-tsx"
primary_target: "web/src/app/map/page.tsx"
related_targets: ["web/src/app/[role]/page.tsx"]
---

# Surface: Food Heat Map (admin dashboard + public/donor/NGO map views)

Mode: Operate. Audiences: Admin on desktop (full map with a stub slot for the agent feed); donors and NGOs on phones (their area, filtered for them); public / CSR partners (read-only city view).
Job: see where surplus is created and where hunger goes unmet, spot the gaps, and inspect an area.
Scope: a hex heat map over Bengaluru with Surplus / Need layers and red gap spots; a time control (day × 3-hour slot) with detents; area details (top donors, NGOs, 4-week trend); this week's top 10 underserved areas; a "Printed" base with a toggle to "Streets" (OSM tiles). All data is mock and labelled sample; the agent feed and flags are stubs.
Decided on the user's behalf (they chose "go ahead"):
- Areas: ~1 km hexes over Bengaluru, each rolling up into one of 18 named localities. Hexes more than ~3.5 km from any locality are dropped.
- Data: a mock feed in `src/lib/luna/map/` with async functions shaped like the backend, seeded from the SRS scenarios (Koramangala evening surplus, Jayanagar short on Wednesday nights, Rajajinagar Sunday caterers, HSR Layout's big NGO taking 70%, Electronic City and Yelahanka with no NGO).
- Gap: for an area and time window, gap = (need − received) ÷ need. It is a gap spot when that is ≥ 0.5 and need ≥ 40 meals. The weekly list ranks areas by unmet meals over the 7-day week.
Unresolved: the real backend contract for per-area numbers; real BBMP ward boundaries.

## Direction contract

THESIS: The map is the kitchen pass, and this week's underserved areas hang above it as order tickets on a steel rail. It refuses the category default of a dashboard of stat cards around a coloured choropleth.

OWN-WORLD: Inherits Kitchen Ticket (DESIGN.md): thermal paper, black ink, red ink only for gaps and urgency, brushed-steel counter, Martian Mono for printed data, Hanken Grotesk for notes. The map itself is "printed": hexes in ink density on paper. Gaps are red ink. Areas with no NGO get a dashed outline. The Streets base is desaturated to sit under the ink.

STORY: The admin sees the ten hungriest areas this week at a glance, pulls a ticket, and the map flies to that area while its detail slip prints. They scrub the time tape and watch Jayanagar turn red on Wednesday night.

FIRST VIEWPORT: Desktop, top to bottom:
- Printer bar: lockup, "Food map · Bengaluru", a SAMPLE DATA stamp, layer switch, base toggle.
- Steel rail across the full width with up to 10 hanging tickets (rank, area, unmet meals, worst slot), most urgent on the left.
- Map (9 cols) with the detail slip (3 cols) on the right: a city summary until an area is picked, then that area. The agent-feed stub sits below the slip on the admin view.
- Receipt-tape time control across the bottom, with day and slot detents, a single readout, and play.
Phone: the rail scrolls sideways, the map is full width, the slip opens as a bottom sheet, and the time tape stays pinned at the bottom.

FORM: Order Rail. Surface structure, index 1 of the ordered list (dealt hand 4, 6, 1). Seed key 0b74a34f.

SIGNATURE INTERACTION: Pulling a rail ticket (click or Enter) lifts it off the rail, the map flies to the area, and the slip prints in line by line. The time tape snaps between detents and the hexes reprint in ink.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
