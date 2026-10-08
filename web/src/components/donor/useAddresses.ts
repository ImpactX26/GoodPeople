"use client";

import { useCallback, useEffect, useState } from "react";
import { getAddresses, saveAddresses, withAddress, withoutAddress, type SavedAddress } from "@/lib/luna/addresses";

/** The donor's saved pickup addresses, with save/remove that persist to the API. */
export function useAddresses(token: string) {
  const [list, setList] = useState<SavedAddress[] | null>(null), [max, setMax] = useState(10), [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    getAddresses(token).then(r => { if (live) { setList(r.addresses); setMax(r.max); } }).catch(e => live && setError((e as Error).message));
    return () => { live = false; };
  }, [token]);
  const persist = useCallback(async (next: SavedAddress[]) => {
    const r = await saveAddresses(token, next); setList(r.addresses); return r.addresses;
  }, [token]);
  return {
    list, max, error,
    save: (a: SavedAddress) => persist(withAddress(list ?? [], a)),
    remove: (id: string) => persist(withoutAddress(list ?? [], id)),
  };
}
