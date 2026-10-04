import type { Metadata } from "next";
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
