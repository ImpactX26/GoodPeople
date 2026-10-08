---
version: 1
slug: "web-src-app-login-page-tsx"
primary_target: "web/src/app/login/page.tsx"
related_targets: ["web/src/app/page.tsx"]
---

# Surface: Sign-in (splash → role → phone → OTP → first-time details → role home stub)

Mode: Operate. Audience: all four roles (donor, NGO, volunteer, admin), phone-first; admin also on desktop.
Job: get into the right role's app in seconds with a dev phone OTP. First-time numbers give a few details once.
Scope: splash slot with a PLACEHOLDER animation (the user will supply the real animation), role choice, phone (+91), 6-digit dev OTP (code shown on screen in dev), resend timer, wrong-code/lockout states, first-time details per role, stub home per role with sign-out. Heat map and real auth are out of scope; the mock API layer is swappable.
Unresolved: the final splash animation asset; real SMS/OTP provider; whether admins are pre-provisioned rather than self-registering.

## Direction contract

THESIS: Signing in is a kitchen order ticket printing. It refuses the category default of a white card with a logo, a segmented role control and a green Continue button.

OWN-WORLD: Thermal paper (#FBFAF6) on a brushed-steel counter, with near-black thermal ink and a second red ink kept for urgency, errors and the DEV stamp. Printed lines use dotted leaders ("ROLE ........ DONOR"), zigzag tear edges, double-width bold headers, and Martian Mono for printed data. Short plain-language helper text is set in Hanken Grotesk. Controls are printed boxes; the primary action is a solid ink bar.

STORY: The visitor sees the ticket print their choices line by line, understands it is Luna (food rescue, Bengaluru pilot), and is in within 30 seconds.

FIRST VIEWPORT: A printer slot runs across the top. One ticket hangs from it at up to 440px wide and centred, filling the width on phones. Its header reads "LUNA", with the KOT number and a live timestamp. Four role lines are the ticket's items, each a full-width tap row. The role rows are the action: one tap prints the choice and advances, which serves the in-seconds job, so the first viewport has no Continue bar. The ink bar is the primary action on every later step (Send code, Finish sign-up).

FORM: Kitchen Ticket (KOT/thermal receipt). Safer-register re-roll, round 1, chosen from the familiar hand. Seed key 828fed25.

SIGNATURE INTERACTION: Each completed step collapses into a printed line on the same ticket, and the next section prints in with a stepped, line-feed reveal. Verification ends with the ticket tearing off along its zigzag edge into the role's home, which is itself a ticket.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
