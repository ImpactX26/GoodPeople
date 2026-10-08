import { TRIP_CONFIG as C } from "./trip";

export async function compressPhoto(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file), canvas = document.createElement("canvas");
  const scale = Math.min(1, C.photoMaxPx / Math.max(bitmap.width, bitmap.height));
  canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext("2d"); if (!ctx) throw new Error("Could not prepare the pickup photo.");
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height); bitmap.close();
  const photo = canvas.toDataURL("image/jpeg", C.photoQuality);
  if (photo.length > C.maxPhotoBytes) throw new Error("This photo is too large. Take another pickup photo.");
  return photo;
}
