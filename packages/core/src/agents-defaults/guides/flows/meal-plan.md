# Meal plan

The owner wants meals for the week, with recipes and one grocery list, from their saved food preferences.

Read first:
1. MemorySearch for food: diet, allergies and intolerances, dislikes, favourite dishes, cooking skill and time, budget, kitchen gear, how many people eat, and the shop they use. Allergies and intolerances are hard limits.
2. CalendarList from today with days 7: busy evenings get quick meals or leftovers, free evenings can take longer recipes. A health goal (GoalList area health) shapes portions and protein, never a diet plan.
3. Nothing about food in memory: ask one question with options ("Vegetarian, anything, or no pork?") and stop there.

Plan:
- One dinner per day by default; lunches only when asked. Reuse ingredients across days so little goes to waste, and cook once for two days where it fits.
- Each meal: name, time to cook, and a short recipe (ingredients with amounts for the people eating, then numbered steps, at most 8).
- Keep it in the owner's budget and skill; no exotic gear they do not have.

Grocery list:
- One list for the week, merged across recipes, amounts added up, grouped by shop section (produce, dairy, meat or protein, dry goods, frozen, other).
- Leave out staples memory says they always have (salt, oil, spices) and say so in one line.

Reply: the week as a short table (day, meal, minutes), then the recipes, then the grocery list. Offer to propose a shopping trip with CalendarEvent that carries the list in its description, so it is on the phone in the shop. Propose cooking blocks only if they ask.

When they say what they liked or not, save it as one food preference with MemorySave, not the whole plan.
