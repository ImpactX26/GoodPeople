/**
 * Client for the Food Agent (Python, `luna_ngo/food`, same server as the NGO agent).
 * A donor's listing goes to the Luna Orchestrator: Food Agent → (if eligible) NGO Matching Agent.
 */
import { ApiError } from "./api";
import { NGO_API_URL } from "./ngoAgent";

export type StepState = "pending" | "active" | "done" | "failed";

/** Grade per LUNA-SPEC §8.6: A Premium, B Good, C Serve now, D Not for people; plus the Unsure flag. */
export interface Freshness {
  score: number;
  grade: "A" | "B" | "C" | "D";
  label: string;
  meaning: string;
  unsure: boolean;
  source: "model" | "rules_only";
  components: { time: number; appearance?: number };
  photo_checked: boolean;
  condition?: "fresh" | "acceptable" | "questionable" | "spoiled" | null;
  safe_until?: string | null;
}

export type Tone = "working" | "good" | "bad";

/** The Decision Agent's live view of the case (status bar, NOW / NEXT, timeline). */
export interface CaseStatus {
  now: string;
  next: string | null;
  tone: Tone;
  by: string;
}

export interface Submission {
  submission_id: string;
  stage: string;
  done: boolean;
  headline: string;
  message: string;
  steps: { key: string; label: string; state: StepState }[];
  food: { name: string; quantity: number; unit: string; category?: string; prepared_at?: string };
  created_at?: string;
  freshness: Freshness | null;
  status: CaseStatus | null;
  progress: { key: string; label: string; state: StepState }[];
  timeline: { at: string; text: string; tone: "done" | "good" | "bad" }[];
  /** Still moving (accepted, waiting for pickup/delivery): keep following it. */
  open: boolean;
  /** DEMO = sample NGOs and simulated NGO replies; LIVE = real listed NGOs. */
  mode?: "DEMO" | "LIVE";
  /** Shown to the donor only: the code the delivery partner enters at pickup. */
  pickup: { code: string; partner_name: string; ngo_name?: string | null }[];
  /** The listed NGOs as the NGO Agent ranked them for this food. */
  ranking: {
    rank: number | null;
    name: string;
    priority: number;
    state: string;
    distance_km?: number | null;
    meals_needed?: number | null;
    urgency?: string | null;
    why_not?: string | null;
  }[];
  reasons: string[];
  rescue_score: number | null;
  ngos: { name: string; portions: number; eta_minutes: number }[];
}

export interface Donor {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
}

export interface FoodListing {
  food_name: string;
  food_category: string;
  quantity: number;
  prepared_at: string;
  storage_method: string;
  storage_temperature: number;
  ingredients: string;
  allergens: string;
  image: string;
  donor: Donor;
}

/** Thrown when the Food Agent rejects the form; `fields` maps field → plain-language message. */
export class ListingError extends Error {
  constructor(public fields: Record<string, string>) {
    super(Object.values(fields)[0] ?? "Please check the form.");
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${NGO_API_URL}${path}`, {
      ...init,
      headers: { ...(init.body ? { "Content-Type": "application/json" } : {}), ...init.headers },
    });
  } catch {
    throw new ApiError(0, "Can’t reach the food checker. Is it running? (python run.py)");
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 422 && (data as { errors?: Record<string, string> }).errors) {
    throw new ListingError((data as { errors: Record<string, string> }).errors);
  }
  if (!res.ok) {
    const detail = (data as { detail?: unknown }).detail;
    throw new ApiError(res.status, typeof detail === "string" ? detail : "The food checker refused that request.");
  }
  return data as T;
}

export const donorIdFor = (phone: string) => `DONOR-${phone}`;

export const submitListing = (listing: FoodListing) =>
  call<{ submission_id: string }>("/api/luna/submissions", { method: "POST", body: JSON.stringify(listing) });

/** Fill in what an older food checker (started before freshness grading) leaves out. */
function normalise(v: Partial<Submission> & { submission_id: string; food: Submission["food"] }): Submission {
  return {
    stage: "",
    done: false,
    headline: "",
    message: "",
    ...v,
    steps: v.steps ?? [],
    freshness: v.freshness ?? null,
    status: v.status ?? null,
    progress: v.progress ?? [],
    timeline: v.timeline ?? [],
    open: v.open ?? false,
    pickup: v.pickup ?? [],
    ranking: v.ranking ?? [],
    reasons: v.reasons ?? [],
    rescue_score: v.rescue_score ?? null,
    ngos: v.ngos ?? [],
  };
}

export const getSubmission = (id: string) =>
  call<Submission>(`/api/luna/submissions/${encodeURIComponent(id)}`).then(normalise);

export const listMySubmissions = (donorId: string) =>
  call<Submission[]>(`/api/luna/submissions?donor_id=${encodeURIComponent(donorId)}&limit=15`).then(
    // a food checker started before donor listings existed returns raw rows for everyone: show none of them
    (rows) => (Array.isArray(rows) ? rows.filter((r) => r && r.food && Array.isArray(r.steps)).map(normalise) : []),
  );

/** Downscale a photo to a JPEG data URL (≤ maxSide px) so phone photos fit the 6 MB limit. */
export function compressPhoto(file: File, maxSide = 1600, quality = 0.85): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      const ctx = canvas.getContext("2d");
      URL.revokeObjectURL(url);
      if (!ctx) return reject(new Error("This browser can’t process photos."));
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/jpeg", quality));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("That file isn’t a photo this browser can read. Try a JPEG or PNG."));
    };
    img.src = url;
  });
}

export const STORAGE: { id: string; label: string; defaultTemp: number }[] = [
  { id: "refrigerated", label: "Fridge", defaultTemp: 4 },
  { id: "hot_held", label: "Kept hot", defaultTemp: 65 },
  { id: "room_temp", label: "Room temp", defaultTemp: 28 },
  { id: "frozen", label: "Frozen", defaultTemp: -18 },
];

/** "YYYY-MM-DDTHH:mm" in local time, for <input type="datetime-local">. */
export function localInputValue(d: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
