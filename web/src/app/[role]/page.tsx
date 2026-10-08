import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { ROLES, ROLE_META, isRole } from "@/lib/luna/roles";
import RoleHome from "./RoleHome";

export function generateStaticParams() {
  return ROLES.map((role) => ({ role }));
}

export const dynamicParams = false;

export async function generateMetadata({ params }: PageProps<"/[role]">): Promise<Metadata> {
  const { role } = await params;
  return { title: isRole(role) ? `${ROLE_META[role].label} · Luna` : "Luna" };
}

export default async function RolePage({ params }: PageProps<"/[role]">) {
  const { role } = await params;
  if (!isRole(role)) notFound();
  return <RoleHome role={role} />;
}
