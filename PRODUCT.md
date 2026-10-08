# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

delegated: Next.js (App Router) + TypeScript. Chosen because one codebase can serve four role-based logins, with a mobile-first PWA for donor, NGO and volunteer screens and a desktop admin dashboard. A typed mock-data/API layer lets the frontend be built now and swapped onto the AI and agent services the teammates are building, without rewriting screens.

## Users

Luna has four roles, each with its own login and screens:

- **Donor**: restaurants, caterers, hotels, event organisers and households. They want to list leftover food in seconds and know it reached someone. Often busy (for example, a restaurant manager at 10 pm closing), on an ordinary phone.
- **Recipient (NGO)**: NGOs, shelters, orphanages, old-age homes and community fridges. They want the right food, on time, without chasing donors. They respond to time-boxed offers.
- **Volunteer**: students, delivery riders and local residents. They want simple pickup-and-drop tasks near them, with recognition. They are on the move and use one hand.
- **Admin**: the Luna team and city partners. They want to see the whole city, watch the AI's decisions and step in when needed. They work on desktop.

## Product Purpose

Luna connects surplus food with people who need it before the food goes bad. India wastes about ₹92,000 crore of food a year. Food is not short; coordination is. Luna links donors, volunteers and NGOs in one app. It uses AI to check food safety (the AI Food Checker) and to decide where each donation goes and arrange the pickup (the Smart Matching Agent).

Success for this build is a convincing hackathon demo (OSC AI Build 1.0, Team GoodPeople). All four role logins should be working frontends that clearly show the flow from listing to check to match to pickup to delivery.

## Positioning

Luna sees both sides of the city at once: where surplus is created and where hunger goes unmet. That lets it spot and actively close gaps, such as an NGO in Jayanagar that gets nothing every Wednesday. A listing board or a single-sided donation app cannot do this. Fair Share makes sure no NGO keeps missing out just because its requirements are hard to meet.

## Operating Context

- Pilot area: Bengaluru (Koramangala, Jayanagar, Rajajinagar, HSR Layout, Indiranagar appear in the spec's scenarios).
- Runs on ordinary smartphones and over WhatsApp; donors can list by sending a WhatsApp photo and message. No cold chain.
- Donor flow: take a photo, the AI fills in details, confirm. Status then moves "Checked → Matched → Picked up → Delivered", and an impact receipt follows ("Delivered to Hope Shelter, fed 30 people").
- NGO flow: incoming offers with a countdown and one-tap accept/decline; posting needs ("60 veg lunches for kids tomorrow"); a profile covering capacity, serving times, fridge and dietary rules; delivery history and food-quality feedback.
- Volunteer flow: nearby task cards (pickup distance, drop distance, time), turn-by-turn route, pickup checklist (plus a smell-and-look check when the AI is unsure), handover confirmed by code or QR scan plus photo, and points, streaks and badges.
- Admin flow: live feed of every agent decision with a plain-language reason; flagged listings, struggling NGOs and escalations needing a human; the heat map with gap spots.
- Source of truth: `Luna — Software Requirements Specification.pdf` in the project root.

## Capabilities and Constraints

- **Quality grades**: A Premium (6+ h, anyone including vulnerable groups), B Good (3–6 h, general NGOs), C Serve now (<3 h, only places that serve within an hour), D Not for people (animal shelters or compost only), Unsure (sent, but the volunteer checks at pickup).
- **Checker output**: food type, freshness score /100, warning signs, "safe until" time, veg/non-veg/egg, people it feeds, a one-line plain reason, and confidence. Rules always override the AI.
- **Never relaxed**: safe until served; Grade D never goes to people; vulnerable groups get Grade A only; fridge-only food goes only where there is a fridge; dietary rules (veg, Jain, halal, no-egg, allergies).
- **Fair Share hunger levels**: Normal → Boost → Relax → Reserve → Hunt → Escalate (human alerted after 48 h).
- **General requirements**: listing takes under 30 seconds; every key action is one tap; the check result shows within seconds; a match comes within a minute; pending tasks survive a dropped connection; personal details are shared only with the people in that delivery; a new donor's first listing is checked by a human.
- **Main-build extras**: handover verification (QR/code + photo), quality feedback from NGOs.
- **Planned add-ons, not in this build unless asked**: reliability scores, Kannada/Hindi voice listing, big event mode, CSR impact reports, gamification leaderboards, donor incentives (FSSAI labels, certificates, Luna Partner badge, leaderboard, surprise bags).
- **Current scope split**: this workstream builds the **frontends for the four role logins**. Teammates own the AI checker and matching agent, so the frontend consumes their outputs through a mock layer for now.
- **Deferred**: the Food Heat Map (admin and gap layers). The user has open questions to settle before it is designed, so don't design it until they bring it back.
- **Terminology**: Luna, Food Heat Map, AI Food Checker, Smart Matching Agent, Fair Share, hunger level, gap spot, "safe until", Grade A–D / Unsure.

## Brand Commitments

- The name is **Luna**.
- Voice, taken from the SRS: plain, warm and direct, in everyday words ("Cooked 1 hour ago, looks fresh, safe for 6 more hours"). Every AI decision is explained in plain language.

## Evidence on Hand

- The SRS PDF, including its worked examples (hotel biryani Grade A, caterer dal-rice Grade C, mouldy bread Grade D, Jain ashram, HSR Layout share cap, and others). Use these as demo scenarios and label them as sample data.
- **No real partners, NGOs, donors, users, impact numbers or testimonials exist.** All names in the SRS ("Hope Shelter", "Cafe Mocha") are illustrative. Don't present mock data as real traction, and don't invent pilot results.
- The CSR/ESG tax angle is unconfirmed (the SRS says to check it with a chartered accountant). Never present it as a guaranteed benefit.

## Product Principles

1. **Safety is not negotiable.** Grades, "safe until" times and dietary rules are the most prominent truth on any food surface. The AI and preferences never override them, and the UI never lets anyone pretend otherwise.
2. **One job per screen, one tap per action.** Each role sees only what it needs right now. Listing takes under 30 seconds, even on a cheap phone with a weak signal.
3. **Show the reason.** Every automated decision is visible with its plain-language why, so people trust the agent and can step in.
4. **Time is the enemy.** Countdowns, expiry and urgency are first-class. Shorter-life food gets faster, clearer treatment.
5. **Goodwill must be visible and verifiable.** Donors get proof of where food went and who it fed; handovers leave a clear record.

## Accessibility & Inclusion

- Works on basic, low-end smartphones and patchy connections (offline-tolerant pending tasks).
- Users range from busy restaurant staff to students and shelter workers. Plain language, large one-tap targets, and one-handed use for volunteers.
- Multilingual (Kannada, Hindi, with voice) is a planned add-on; keep copy easy to translate.
