---
version: 1
slug: "web-src-components-listing-listingscreen-tsx"
primary_target: "web/src/components/listing/ListingScreen.tsx"
related_targets: ["web/src/app/[role]/RoleHome.tsx"]
---

# Surface: Donor app (home, List food, donation status, donation list)

Mode: Operate. Audience: restaurant staff, caterers and households on ordinary phones, often one-handed at closing time; restaurant managers on laptops.
Job: list surplus food in under 30 seconds, then watch it get checked, matched, collected and delivered.
Scope: `/donor` home, `/listings/new`, `/listings/[id]`, `/listings`. Keeps every existing function: the same fields, validation, first-listing review, NGO countdown, tracking hand-off and receipts. Adds a food category and an optional thermometer reading for the Food Agent.
Food check: every submission runs the Food Agent (Gemini 3.5 Flash, then 3.5 Flash-Lite and 3.1 Flash-Lite, the same on the backup key, then Groq Llama 4 Scout if a key is set, then rules only; one AI call per listing). The status ticket names the model that judged the photo.

## Direction contract

THESIS: The photo is the listing. It refuses the category default of a long web form with dropdowns, a browser file picker and the submit button at the bottom of the page.

OWN-WORLD: Kitchen Ticket, unchanged (DESIGN.md). Paper on steel, near-black ink, red only for urgency and failure, Martian Mono for printed data and actions, Hanken Grotesk for notes. New pieces in that language:
- the photo canvas: a black frame with registration corners;
- printed tap-chips with square corners and an ink-reversal state;
- a − / + stepper;
- the sticky ink action bar;
- the coupon ticket: perforated stages that stamp as they complete.

STORY: The donor photographs the food, taps four chip rows, sends it, and watches one ticket stamp itself stage by stage: food check → NGO → pickup → delivered.

FIRST VIEWPORT:
- Phone home: lockup bar; a tall photo frame (about 55% of the screen) reading "Photograph the food" that opens the camera; the live donations strip below it; the account sheet behind an icon.
- Phone List food: photo across the top 40%, chip rows below, a sticky bottom bar "= 10 servings · Review" inside the thumb zone.
- Desktop: the photo canvas on the left (7 of 12 columns) and the details on the right; the home shows the donations rail beside the camera frame.

FORM: Snap first. Surface structure, index 6 of the ordered list (dealt hand 6, 5, 2). Seed key 54bca264. Raised by the Airline ticket wallet challenger: the status screen is one ticket with a coupon per stage.

SIGNATURE INTERACTION: After "Send to Luna", the food-check coupon shows the model looking at the photo, then prints its grade and safe-until line by line. Each later stage tears its perforation and stamps as it completes.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
