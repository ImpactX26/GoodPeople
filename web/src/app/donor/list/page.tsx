import { redirect } from "next/navigation";

/** Food is listed through the Food Agent (photo check, tags) on the donor app; this older page talked to the retired Python matcher. */
export default function Page() {
  redirect("/listings/new");
}
