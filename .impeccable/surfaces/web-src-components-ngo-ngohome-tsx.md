---
version: 1
slug: "web-src-components-ngo-ngohome-tsx"
primary_target: "web/src/components/ngo/NgoHome.tsx"
related_targets: ["web/src/app/[role]/RoleHome.tsx"]
---

# Surface: NGO home (`/ngo`)

Mode: Operate. Audience: shelter, orphanage and old-age-home staff, often not confident with apps; on a phone at the gate or on the office computer, equally.
Job: answer waiting food fast, get delivery partners moving, hand over the drop code, and tell Luna whether they can take food today.
Scope: `/ngo` home only. Keeps every existing function: the profile lines, both offer inboxes (`/offers` from the Luna API, `/ngo/offers` from the matching agent), listing at `/ngo/list`, deliveries `/deliveries`, food map `/map`, the sample-account link, the coming-soon list and sign out. Waiting offers from both inboxes merge into one "Food waiting for you" list and can be accepted from the home.

## Direction contract
THESIS: Today's shift card. The home is today's card for the kitchen wall: waiting food first, then where the day stands. It refuses the category default of a column of equal-weight menu links with the urgent offer buried among them.
OWN-WORLD: Kitchen Ticket, unchanged (DESIGN.md). Paper on steel, near-black ink, red only for the last minute of a countdown and for failure, Martian Mono for printed data and actions, Hanken Grotesk for sentences. New pieces: the offer ticket (white active paper, a countdown in large tabular figures, a full-width ink Accept bar); the punch row (Open / Full / Closed as three big radio punches); the hour strip (6 am to 10 pm, the receiving hours shaded, a square stamp for each delivery, a NOW line).
STORY: A worker opens Luna, sees "20 × Veg biryani · 4:12 left", taps Accept, and the ticket moves down to "Coming to you" with the drop code and the next step ("Send a delivery partner").
FIRST VIEWPORT: Phone: printer bar; a waiting offer ticket fills the top with its countdown, food, distance and the Accept bar inside the thumb zone; when nothing waits, a plain printed line plus the one action that matters (list your NGO, or reopen if marked Full). Desktop (≥900px): waiting and coming tickets in the left 7 columns; the day card (punch row, hour strip, links, details) on the right 5.
FORM: Today's shift card, index 7 of the ordered list (dealt 7, 3, 5). Seed key 0f6b3441.
SIGNATURE INTERACTION: A new offer prints in from the top with the stepped paper feed, the tab title reads "(1) Food waiting", the phone buzzes once where allowed. When the user accepts, the ticket stamps ACCEPTED and reprints under "Coming to you" with its drop code.
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
