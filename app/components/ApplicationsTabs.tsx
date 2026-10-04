"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// The two views of "Applications": prepared drafts waiting for your review
// (/review) and every application you are tracking (/applications).
// Navigation only.

const TABS = [
  { href: "/review", label: "Ready for review", hint: "Check and approve what your agent prepared" },
  { href: "/applications", label: "Your applications", hint: "Apply, then track responses" },
] as const;

export default function ApplicationsTabs() {
  const pathname = usePathname();
  return (
    <nav aria-label="Applications" className="mt-6 grid grid-cols-2 gap-1 rounded-xl bg-slate-200/60 p-1 sm:inline-grid sm:w-auto">
      {TABS.map((tab) => {
        const active = pathname.startsWith(tab.href);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            title={tab.hint}
            className={`flex min-h-11 items-center justify-center rounded-lg px-4 text-sm font-semibold transition sm:px-6 ${
              active ? "bg-white text-slate-900 shadow-sm" : "text-slate-600 hover:text-slate-900"
            }`}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
