import type { Metadata } from "next";
import SignIn from "./SignIn";

export const metadata: Metadata = {
  title: "Sign in · Luna",
};

export default function LoginPage() {
  return <SignIn />;
}
