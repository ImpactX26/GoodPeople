import { redirect } from "next/navigation";

/** Pickups from the Logistics Agent are on the partner home; this older page talked to the retired Python matcher. */
export default function Page() {
  redirect("/volunteer");
}
