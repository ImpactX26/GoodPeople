"use client";

import Image from "next/image";
import { Camera, ImageUp, RotateCcw } from "lucide-react";
import { useId, useState } from "react";
import { compressPhoto } from "@/lib/luna/photo";
import s from "./donor.module.css";

const DRAFT_KEY = "luna.draftPhoto";
/** The photo taken on the home screen, carried into List food. Cleared once the listing is sent. */
export function peekDraftPhoto() {
  try { return sessionStorage.getItem(DRAFT_KEY) ?? ""; } catch { return ""; }
}
export function clearDraftPhoto() {
  try { sessionStorage.removeItem(DRAFT_KEY); } catch { /* nothing to clear */ }
}
export function keepDraftPhoto(dataUrl: string) {
  try { sessionStorage.setItem(DRAFT_KEY, dataUrl); } catch { /* private mode: the form asks again */ }
}

async function read(file: File | undefined) {
  if (!file) return null;
  if (file.size > 8 * 1024 * 1024) throw new Error("Use a food photo under 8 MB.");
  return compressPhoto(file);
}

/**
 * The photo frame: empty, it is the camera button ("Photograph the food");
 * filled, it shows the shot with registration corners and a retake control.
 */
export default function PhotoCanvas({ photo, onPhoto, onError, scanning = false, tall = false, alt, readOnly = false }: {
  photo: string; onPhoto: (dataUrl: string) => void; onError: (msg: string) => void; scanning?: boolean; tall?: boolean; alt?: string; readOnly?: boolean;
}) {
  const id = useId(), [busy, setBusy] = useState(false);
  const pick = async (file: File | undefined) => {
    setBusy(true);
    try { const v = await read(file); if (v) { onPhoto(v); onError(""); } } catch (e) { onError((e as Error).message); } finally { setBusy(false); }
  };
  const cam = <input id={`${id}-cam`} className={s.fileInput} type="file" accept="image/jpeg,image/png,image/webp" capture="environment" onChange={e => void pick(e.target.files?.[0])} />;
  const lib = <input id={`${id}-lib`} className={s.fileInput} type="file" accept="image/jpeg,image/png,image/webp" onChange={e => void pick(e.target.files?.[0])} />;
  if (photo) {
    return (
      <figure className={s.canvas} data-tall={tall} data-scanning={scanning}>
        <Image src={photo} alt={alt ?? "Your food photo"} fill sizes="(min-width: 900px) 58vw, 100vw" unoptimized className={s.canvasImg} />
        <span className={s.corners} aria-hidden />
        {scanning && <span className={s.scan} aria-hidden />}
        {!readOnly && <>{cam}<label htmlFor={`${id}-cam`} className={s.retake}><RotateCcw size={16} aria-hidden /> Retake</label></>}
      </figure>
    );
  }
  return (
    <div className={s.canvas} data-empty data-tall={tall}>
      <span className={s.corners} aria-hidden />
      {cam}
      <label htmlFor={`${id}-cam`} className={s.shoot}>
        <Camera size={40} strokeWidth={1.5} aria-hidden />
        <strong>{busy ? "Reading photo…" : "Photograph the food"}</strong>
        <span>One clear photo of what you’re giving</span>
      </label>
      {lib}
      <label htmlFor={`${id}-lib`} className={s.upload}><ImageUp size={16} aria-hidden /> Choose from gallery</label>
    </div>
  );
}
