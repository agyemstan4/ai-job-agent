"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { activeSection } from "@/lib/nav";

// App navigation: a top bar on desktop and a bottom tab bar on mobile, with
// plain-language labels. Only existing routes: "Find Jobs" is the search
// section on the home page, and "Applications" also covers the review page
// (/review), which is reached from "ready for review" prompts and the
// Applications tabs. Navigation only — nothing here searches, prepares or sends.

const ITEMS = [
  { href: "/", label: "Home", icon: "M3 10.5 12 3l9 7.5V21a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z" },
  { href: "/today", label: "Today", icon: "M12 3v2M12 19v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M3 12h2M19 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z" },
  { href: "/#search", label: "Find Jobs", icon: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4" },
  { href: "/applications", label: "Applications", icon: "M4 7h16v12a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1zM9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" },
  { href: "/preferences", label: "Preferences", icon: "M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M14 4v4M8 10v4M16 16v4" },
] as const;

function Icon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

export default function AppNav() {
  const pathname = usePathname();
  const active = activeSection(pathname);
  const isActive = (href: string) => href === active;

  return (
    <>
      {/* Desktop / tablet: top bar */}
      <header className="sticky top-0 z-40 border-b border-slate-200/80 bg-white/90 backdrop-blur">
        <div className="app-shell flex h-16 items-center justify-between gap-6">
          <Link href="/" className="flex min-h-11 items-center gap-2.5 font-semibold tracking-tight text-slate-900">
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-indigo-600 text-sm font-bold text-white" aria-hidden="true">J</span>
            <span className="text-[17px]">Job Agent</span>
          </Link>
          <nav aria-label="Main" className="hidden items-center gap-1 md:flex">
            {ITEMS.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                aria-current={isActive(item.href) ? "page" : undefined}
                className={`inline-flex min-h-10 items-center gap-2 rounded-lg px-3.5 text-sm font-medium transition-colors ${
                  isActive(item.href) ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                }`}
              >
                {item.label}
              </Link>
            ))}
          </nav>
        </div>
      </header>

      {/* Mobile: bottom tab bar with full labels */}
      <nav aria-label="Main" className="fixed inset-x-0 bottom-0 z-40 border-t border-slate-200 bg-white/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden">
        <ul className="grid grid-cols-5">
          {ITEMS.map((item) => (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={isActive(item.href) ? "page" : undefined}
                className={`flex min-h-14 flex-col items-center justify-center gap-1 text-xs font-medium ${isActive(item.href) ? "text-indigo-700" : "text-slate-600"}`}
              >
                <Icon d={item.icon} />
                {item.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </>
  );
}
