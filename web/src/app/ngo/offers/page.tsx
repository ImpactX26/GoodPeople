import { redirect } from "next/navigation";

/** Offers from the Logistics Agent are on the NGO home; this older page talked to the retired Python matcher. */
export default function Page() {
  redirect("/ngo");
}
