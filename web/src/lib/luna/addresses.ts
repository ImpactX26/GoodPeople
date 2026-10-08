import { api } from "./api";
import type { SavedAddress } from "../../../../api/src/addresses";
export type { SavedAddress };

export const BENGALURU = { lat: 12.9716, lng: 77.5946 };
export const inPilot = (lat: number, lng: number) => lat >= 12.6 && lat <= 13.35 && lng >= 77.25 && lng <= 77.95;
export const newAddressId = () => `adr_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;

export const getAddresses = (token: string) => api<{ addresses: SavedAddress[]; max: number }>("/me/addresses", { token });
export const saveAddresses = (token: string, addresses: SavedAddress[]) =>
  api<{ addresses: SavedAddress[]; max: number }>("/me/addresses", { method: "PUT", token, body: JSON.stringify({ addresses }) });
export const reverseGeocode = (token: string, lat: number, lng: number) =>
  api<{ address: string; area: string | null }>(`/geo/reverse?lat=${lat}&lng=${lng}`, { token });
export const searchPlaces = (token: string, q: string) =>
  api<{ results: { address: string; lat: number; lng: number }[] }>(`/geo/search?q=${encodeURIComponent(q)}`, { token });

/** Upsert one address; making it default clears the others. The first address is always default. */
export function withAddress(list: SavedAddress[], a: SavedAddress): SavedAddress[] {
  const others = list.filter(x => x.id !== a.id);
  const isDefault = a.isDefault || others.length === 0 || !others.some(x => x.isDefault);
  return [...others.map(x => (isDefault ? { ...x, isDefault: false } : x)), { ...a, isDefault }]
    .sort((x, y) => Number(y.isDefault) - Number(x.isDefault));
}
export function withoutAddress(list: SavedAddress[], id: string): SavedAddress[] {
  const rest = list.filter(x => x.id !== id);
  if (rest.length && !rest.some(x => x.isDefault)) rest[0] = { ...rest[0], isDefault: true };
  return rest;
}
