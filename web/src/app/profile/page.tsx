import type { Metadata } from "next";
import ProfileRoute from "./ProfileRoute";

export const metadata: Metadata = { title: "Your profile · Luna" };

export default function ProfilePage() {
  return <ProfileRoute />;
}
