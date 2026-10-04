import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import AppNav from "./components/AppNav";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Job Agent",
  description: "Your personal AI job-search agent: matches, applications and tracking. You always submit applications yourself.",
  applicationName: "Job Agent",
  // Opens like an app when added to a phone home screen (the manifest is app/manifest.ts).
  appleWebApp: { capable: true, title: "Job Agent", statusBarStyle: "default" },
  icons: { apple: "/icons/apple-touch-icon.png" },
};

export const viewport: Viewport = {
  themeColor: "#4f46e5",
  width: "device-width",
  initialScale: 1,
  // Content stays clear of notches and the home indicator (the tab bar pads for it).
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      {/* pb-20 keeps content clear of the mobile tab bar */}
      <body className="min-h-full flex flex-col pb-20 md:pb-0">
        <AppNav />
        {children}
      </body>
    </html>
  );
}
