# How Luna counts a restaurant's impact

The impact certificate, the Luna Partner badge, the area leaderboard and the CSR/ESG report all come from one calculation (`api/src/impact/impact.ts`). This note says what is counted, what is estimated, and where each estimate comes from.

## Counted, not estimated

- **Meals donated**: servings that reached an NGO, confirmed by the drop code at handover. Listed servings never count. A listing that nobody took counts as a donation but adds no meals.
- **Deliveries** and **NGOs reached**: deliveries closed with a drop code, and the distinct NGOs they went to.
- **Sent to biogas**: servings a biogas plant collected (the restaurant marked them collected). These count as food kept out of landfill, not as meals.
- **Luna Partner since**: the date of the restaurant's first delivered donation.

## Estimated

| Number | How | Source |
|---|---|---|
| kg of food saved | The restaurant's own amount when it listed in kg; otherwise 350 g per served meal | Luna's assumption for a cooked meal portion. Replace with weighed amounts when restaurants weigh. |
| CO₂e avoided | 2.5 kg CO₂e per kg of food not wasted | FAO, *Food Wastage Footprint: Impacts on Natural Resources* (2013): about 3.3 Gt CO₂e a year from about 1.3 Gt of food wasted |

Every screen that shows kg or CO₂e says it is an estimate.

## What Luna does not claim

- **Tax**: donating food gives no deduction under Section 80G, which covers money only. The SRS says this plainly, and so does the report.
- **CSR filings**: whether a company can use these numbers in a CSR filing is for its chartered accountant to confirm. The report says so on its face.
- **The leaderboard** ranks by delivered meals in the month, per area. It shows restaurant names and numbers only, never phones or addresses.

## The donation label

The label (`api/src/impact/label.ts`) carries the fields FSSAI's surplus-food guidance expects: food name, source, preparation time, consume-by (the Food Agent's safe-until), a veg / non-veg mark, and the allergens declared. The restaurant's FSSAI licence number is printed when it is on their profile. The exact required set should be confirmed with a food-safety adviser (spec §9.6).
