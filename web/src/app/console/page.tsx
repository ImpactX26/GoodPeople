import { redirect } from "next/navigation";

/** The call sheet is a view of the agents page now. */
export default function ConsolePage() {
  redirect("/admin/agents?view=sheet");
}
