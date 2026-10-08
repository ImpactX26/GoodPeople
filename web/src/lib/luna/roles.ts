export type Role = "donor" | "ngo" | "volunteer" | "admin";

export const ROLES: Role[] = ["donor", "ngo", "volunteer", "admin"];

export function isRole(value: string): value is Role {
  return (ROLES as string[]).includes(value);
}

export type DetailField =
  | { key: string; label: string; kind: "text"; placeholder: string; optional?: boolean }
  | { key: string; label: string; kind: "choice"; options: string[] }
  /** The NGOs listed on Luna, plus "none"; `helpsKey` holds the "also deliver for other NGOs" opt-in. */
  | { key: string; label: string; kind: "ngo"; helpsKey: string };

export interface RoleMeta {
  id: Role;
  label: string;
  /** One line printed under the role name on the ticket. */
  who: string;
  /** What this person came to do; printed on their home ticket. */
  job: string;
  details: DetailField[];
  /** Features from the SRS this role's app will carry, shown on the stub home. */
  upcoming: { title: string; line: string }[];
}

export const AREAS = [
  "Koramangala",
  "Jayanagar",
  "Indiranagar",
  "HSR Layout",
  "Rajajinagar",
  "Malleshwaram",
  "BTM Layout",
  "JP Nagar",
  "Basavanagudi",
  "Whitefield",
  "Marathahalli",
  "Hebbal",
  "Yelahanka",
  "Electronic City",
  "Nagarabhavi",
  "Rajarajeshwari Nagar",
  "Somewhere else in Bengaluru",
];

const nameField: DetailField = {
  key: "name",
  label: "Your name",
  kind: "text",
  placeholder: "As people should call you",
};

const areaField: DetailField = {
  key: "area",
  label: "Area",
  kind: "choice",
  options: AREAS,
};

export const ROLE_META: Record<Role, RoleMeta> = {
  donor: {
    id: "donor",
    label: "Donor",
    who: "Restaurants, caterers, hotels, events, homes",
    job: "List leftover food in seconds and see where it went.",
    details: [
      nameField,
      {
        key: "org",
        label: "Business or household name",
        kind: "text",
        placeholder: "e.g. Meghana Mess, or Rao household",
      },
      {
        key: "kind",
        label: "You are a",
        kind: "choice",
        options: ["Restaurant", "Caterer", "Hotel", "Event organiser", "Household"],
      },
      areaField,
    ],
    upcoming: [
      { title: "Live status", line: "Picked up and delivered, as it happens." },
      { title: "Impact receipts", line: "Where it went and how many it fed." },
    ],
  },
  ngo: {
    id: "ngo",
    label: "NGO",
    who: "Shelters, orphanages, old-age homes, fridges",
    job: "Get the right food on time, without chasing donors.",
    details: [
      { ...nameField, label: "Contact person" },
      {
        key: "org",
        label: "Organisation name",
        kind: "text",
        placeholder: "Registered name",
      },
      {
        key: "kind",
        label: "Type",
        kind: "choice",
        options: ["NGO", "Shelter", "Orphanage", "Old-age home", "Community fridge"],
      },
      areaField,
    ],
    upcoming: [
      { title: "Post a need", line: "“60 veg lunches for kids tomorrow.”" },
      { title: "Deliveries", line: "History and feedback on food quality." },
    ],
  },
  volunteer: {
    id: "volunteer",
    label: "Volunteer",
    who: "Pick up food nearby and drop it where it’s needed",
    job: "Short pickup-and-drop runs near you.",
    details: [
      nameField,
      areaField,
      {
        key: "travel",
        label: "You usually get around by",
        kind: "choice",
        options: ["Two-wheeler", "Bicycle", "Car", "On foot", "Bus or metro"],
      },
      { key: "affiliatedNgo", label: "Which NGO do you ride for?", kind: "ngo", helpsKey: "helpsOthers" },
    ],
    upcoming: [
      { title: "Nearby tasks", line: "Pickup, drop and time needed on one card." },
      { title: "Route", line: "Turn-by-turn to the donor, then the NGO." },
      { title: "Points", line: "Streaks and badges for every run." },
    ],
  },
  admin: {
    id: "admin",
    label: "Admin",
    who: "Luna’s admin only",
    job: "Watch the whole city and step in when needed.",
    details: [
      nameField,
      {
        key: "org",
        label: "Team or partner organisation",
        kind: "text",
        placeholder: "e.g. Luna ops",
      },
    ],
    upcoming: [
      { title: "Agent feed", line: "Every matching decision, with its reason." },
      { title: "Flags", line: "Unsure listings, struggling NGOs, escalations." },
      { title: "Heat map", line: "Surplus, need and gap spots across the city." },
    ],
  },
};
