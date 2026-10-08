---
version: 1
slug: "web-src-components-partner-partnerhome-tsx"
primary_target: "web/src/components/partner/PartnerHome.tsx"
related_targets: ["web/src/app/[role]/RoleHome.tsx"]
---

# Surface: Delivery partner (volunteer) home (`/volunteer`)

Mode: Operate. Audience: student and resident volunteers and riders on a phone, often one-handed on a two-wheeler stop; not tech-confident.
Job: be available, accept a pickup fast, then get through pickup and drop with the two codes.
Scope: `/volunteer` home. Keeps every function: online/offline, "You ride for", pickup requests with countdown and Accept/Can't, the live trip (address, notes, call the restaurant, containers, directions, pickup and drop codes, running late, live location), delivered list, the walkthrough pickups and desktop alerts, track deliveries, food map, profile lines, sample-account link, sign out.

## Direction contract
THESIS: Today's shift card, for the rider. Extends the NGO home's shift card (same world, same composition): the one thing to act on prints at the top, everything else waits below. Refuses a long receipt of equal-weight links with the request buried at the bottom.
OWN-WORLD: Kitchen Ticket, unchanged (DESIGN.md), reusing the NGO home's offer ticket, punch row and ink Accept bar. New piece: the trip slip, a white ticket showing one step at a time ("1 of 2 · Collect from …", then "2 of 2 · Drop at …") with a giant 4-digit code field and the step's ink action bar.
STORY: A rider taps Online, a pickup request prints in with its countdown, they tap Accept, the screen becomes the trip slip: directions, call, enter the restaurant's code, then the NGO's code, done.
FIRST VIEWPORT: Phone: printer bar; a waiting request (countdown, food, from → to, Accept) or the active trip slip at the top; with neither, two big punches "Online / Offline" and the "You ride for" choice. Desktop (≥900px): the work in the left 7 columns, the day card (status, delivered today, links, details) in the right 5.
FORM: Extension of the NGO home's shift card (no new concept round: the request was "same thing … similar form"). Seed key: n/a (extension of 0f6b3441).
SIGNATURE INTERACTION: Accept stamps ACCEPTED on the request and the slip prints in as step 1; a correct code stamps the step DONE and step 2 prints.
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
