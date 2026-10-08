import type { Metadata, Viewport } from "next";
import { Hanken_Grotesk, Martian_Mono } from "next/font/google";
import PartnerNotifications from "@/components/trip/PartnerNotifications";
import "./globals.css";

const martian = Martian_Mono({
  variable: "--font-martian",
  subsets: ["latin"],
  axes: ["wdth"],
});

const hanken = Hanken_Grotesk({
  variable: "--font-hanken",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  // iOS turns phone numbers, dates and addresses into links before React hydrates,
  // which shows up as hydration mismatches on donor and delivery screens.
  formatDetection: { telephone: false, date: false, address: false, email: false },
  title: "Luna",
  description: "Surplus food to people who need it, before it goes bad.",
};

export const viewport: Viewport = {
  themeColor: "#d5d7d3",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // Browsers such as Chrome on iOS add their own attributes to <html> and <body> before React loads.
    <html lang="en" className={`${martian.variable} ${hanken.variable}`} suppressHydrationWarning>
      <body suppressHydrationWarning><PartnerNotifications>{children}</PartnerNotifications></body>
    </html>
  );
}
