export type { ListingInput, ListingView } from "../../../../api/src/listings/types";
export const ALLERGENS = ["dairy", "nuts", "peanuts", "gluten", "egg", "soy", "sesame", "seafood", "onion_garlic"];
export const inputTime = (at: number) => {
  const date = new Date(at);
  return new Date(at - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};
