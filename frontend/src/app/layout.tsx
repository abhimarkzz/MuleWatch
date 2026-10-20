import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";

// Vendored Latin subsets (SIL OFL, see fonts/LICENSE.md) so neither builds
// nor page loads depend on reaching Google Fonts.
const plexSans = localFont({
  variable: "--font-plex-sans",
  src: [{ path: "./fonts/IBMPlexSans-Variable-latin.woff2", weight: "400 600", style: "normal" }],
  fallback: ["ui-sans-serif", "system-ui", "sans-serif"],
});

const plexMono = localFont({
  variable: "--font-plex-mono",
  src: [
    { path: "./fonts/IBMPlexMono-Regular-latin.woff2", weight: "400", style: "normal" },
    { path: "./fonts/IBMPlexMono-Medium-latin.woff2", weight: "500", style: "normal" },
  ],
  fallback: ["ui-monospace", "monospace"],
});

export const metadata: Metadata = {
  title: {
    default: "MuleWatch",
    template: "%s · MuleWatch",
  },
  description:
    "Transaction risk scoring and fraud-network investigation prototype built on synthetic PaySim data.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${plexSans.variable} ${plexMono.variable} antialiased`}>
      <body className="min-h-dvh">{children}</body>
    </html>
  );
}
