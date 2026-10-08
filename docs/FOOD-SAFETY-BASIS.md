# Where Luna's food-safety rules come from

Luna decides how long donated food stays safe with **time-and-temperature rules**, not with the photo model. This page maps each rule in `config/ngo_agent.json` (`food_safety`) and `luna_ngo/food/policies.py` to the public guidance it follows. Where a number is Luna's own choice, it says so.

These are starting defaults. The spec (Appendix B) requires a food-safety adviser to review them before a public launch.

## Why the photo can't extend safe time

Harmful bacteria usually don't change how food looks, smells or tastes. The USDA's Food Safety and Inspection Service says pathogenic bacteria "do not generally affect the taste, smell, or appearance of food" (FSIS *Kitchen Companion* [1]; the same wording appears in the Saudi FDA's guidance [2]).

So a photo, whether a person or a model looks at it, can show that food is **bad** (mould, sliminess, contamination). It can't show that food is **safe**. Luna's design follows that one-way logic:

| What the photo model can do | What it can never do |
|---|---|
| Lower the grade (a "questionable" photo caps it at C) | Raise a grade |
| Force Grade D on visible spoilage, contamination or "not food" | Add any time to the safe-until clock |
| Mark the food **Unsure** when its confidence is under 0.6 or there is no usable photo, so the rider does a smell-and-look check at pickup | Override a failed time or temperature rule |

Research on computer vision for food quality reports the same limit: these systems judge surface appearance, and they depend on lighting, image quality and large labelled datasets [3][4]. That's why the model is a second line of defence here, never the first.

## The time-and-temperature rules

| Luna rule (cooked meals) | Source | What the source says |
|---|---|---|
| **Room temperature: 2 h** after cooking | WHO *Five Keys to Safer Food* [5]; USDA FSIS [1] | "Do not leave cooked food at room temperature for more than 2 hours." |
| **Room temperature above 32 °C: halved, to 1 h** | USDA FSIS [1] | Above 90 °F (32 °C), refrigerate perishable food within 1 hour. |
| **Kept hot: food counts as hot only at 57 °C or more**; below that, the room-temperature limit applies | US FDA Food Code hot-holding temperature, 135 °F (57 °C) [6] | Hot food must be held at 135 °F (57 °C) or above. |
| **Kept hot: target 60 °C** (a warning below it) | FSSAI Schedule 4 [7]; WHO [5] | Hold cooked food hot at 60 °C or more ("piping hot"). |
| **Kept hot: at most 4 h** | FDA Food Code §3-501.19, *Time as a Public Health Control* [6] | Food taken out of temperature control must be used or thrown away within 4 hours. Luna can't verify that a restaurant kept food above 57 °C the whole time, so it treats hot-held food as time-controlled. This is stricter than the Code allows for verified hot holding. |
| **Fridge: 5 °C target, 8 °C fails** | WHO [5]; FSSAI Schedule 4 [7]; FSSAI surplus food regulations (fridge below 7 °C) [8] | Refrigerate cooked food, preferably below 5 °C. |
| **Fridge: at most 24 h** | Food Standards Scotland (UK), cooked rice [9] | Cooked rice: cool quickly, keep in the fridge and eat within 24 hours (*Bacillus cereus* spores survive cooking). Luna applies the rice limit to every cooked meal. |
| **Surplus food is given before it spoils, and never after its shelf life** | FSSAI *Recovery and Distribution of Surplus Food* Regulations, 2019 [8] | Hand over surplus "at a reasonable time before it gets spoiled", and don't distribute it after its shelf life. Luna enforces "safe until served": the food must still be safe at the NGO's serving time, travel included. |

## Luna's own choices (no regulator sets these numbers)

| Rule | Why |
|---|---|
| Cooked meat, egg and fish get **25% less time** (factor 0.75) | An extra margin for the highest-risk foods (the FDA classes them as time/temperature-control foods). The factor itself is Luna's own choice. |
| Grade bands: **A** at 6 h or more, **B** 3–6 h, **C** under 3 h | From the project's SRS. They decide who may receive the food: vulnerable groups get A only, and C goes only where it's served within an hour. |
| At least **30 min** of safe time left to start a delivery | Practical: a delivery has to be able to arrive in time. |

## The restaurant's own estimate is a ceiling

The restaurant knows things no rule or photo can: how the food was handled, and whether a dish turns quickly. So for each food it can say how long it stays good from now (*Not sure*, or 1 h to 8 h+). That estimate is a ceiling:

- Luna uses whichever is **sooner**, its rules or the restaurant's estimate. An estimate later than the rules is noted and changes nothing.
- The grade can only **go down** to match the shorter time (`capByDonor` in `api/src/listings/foodCheck.ts`).
- An estimate that leaves under 30 minutes means Grade D: there isn't time to deliver it.
- The donor's food check reasoning shows a "Your estimate" step saying which time Luna used.

This follows the FSSAI surplus food regulations [8], which make the donor responsible for handing food over "at a reasonable time before it gets spoiled".

## One rulebook everywhere

When the Python food check can't be reached, the API grades food with its own fallback rules (`api/src/listings/foodCheck.ts`). These now use **the same table as the Food Agent**: 2 h at room temperature (1 h above 32 °C), 4 h kept hot (only at 57 °C or more), 24 h in the fridge, and a quarter less for cooked meat, egg and fish. Before 2026-10-08 the fallback allowed 8 h kept hot and 4 h at room temperature, from the more lenient draft in spec Appendix B.

## Sources

1. USDA Food Safety and Inspection Service, *Kitchen Companion: Your Safe Food Handbook*. https://www.fsis.usda.gov/sites/default/files/media_file/2020-12/Kitchen-Companion.pdf
2. Saudi Food and Drug Authority, "Do spoilage bacteria make people sick?" https://sfda.gov.sa/en/faq/do-spoilage-bacteria-make-people-sick
3. *Computer Vision for Food Quality Assessment: Advances and Challenges*. https://www.researchgate.net/publication/389281944_Computer_Vision_for_Food_Quality_Assessment_Advances_and_Challenges
4. *Deep Learning and Machine Vision for Food Processing: A Survey*. https://arxiv.org/pdf/2103.16106
5. World Health Organization, *Five Keys to Safer Food*. https://www.afro.who.int/sites/default/files/2017-06/fan_5keys_en%20%282%29.pdf
6. US FDA Food Code §3-501.19, Time as a Public Health Control (summary by Lexington-Fayette County Health Department). https://www.lfchd.org/wp-content/uploads/2022/11/Time-as-a-Public-Health-Control-11.14.2022.pdf
7. FSSAI, Schedule 4 of the Food Safety and Standards (Licensing and Registration) Regulations, 2011: hygiene checklist. https://hygiene.fssai.gov.in/resources/sample_checklist.pdf
8. FSSAI, Food Safety and Standards (Recovery and Distribution of Surplus Food) Regulations, 2019 (draft text on FSSAI's Save Food Share Food site). https://sharefood.eatrightindia.gov.in/pdf/Surplus-food-draft-regulation.pdf
9. Food Standards Scotland, *Rice* (storing cooked rice). https://foodstandards.gov.scot/consumers/food-safety/at-home/rice
