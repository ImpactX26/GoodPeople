import type { Metadata } from "next";
import ConsoleRoute from "./ConsoleRoute";

export const metadata: Metadata = {
  title: "Agents live · Luna",
  description: "Luna's four agents handing food to each other, with each agent's reasoning, live. For Luna admins.",
};

export default function ConsolePage() {
  return <ConsoleRoute />;
}
