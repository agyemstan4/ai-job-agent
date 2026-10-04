"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// App navigation (Command Centre v2): a top bar on desktop and a bottom tab
// bar on mobile. Only existing routes; "Jobs" is the feed section on the home
// page. Navigation only — nothing here searches, prepares or sends anything.

const ITEMS = [
  { href: "/", label: "Home", icon: "M3 10.5 12 3l9 7.5V21a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z" },
  { href: "/#jobs", label: "Jobs", icon: "M4 7h16v12a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1zM9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" },
  { href: "/review", label: "Review", icon: "M9 12l2 2 4-4M7 3h10a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" },
  { href: "/applications", label: "Applications", icon: "M4 6h16M4 12h16M4 18h10" },
  { href: "/preferences", label: "Preferences", icon: "M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0M14 4v4M8 10v4M16 16v4" },
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
  const isActive = (href: string) => (href === "/" || href === "/#jobs" ? pathname === "/" && href === "/" : pathname.startsWith(href));

  return (
    <>
      {/* Desktop / tablet: top bar */}
      <header className="sticky top-0 z-40 border-b border-slate-200/80 bg-white/85 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4 sm:px-6">
          <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight text-slate-900">
            <span className="grid h-7 w-7 place-items-center rounded-lg bg-indigo-600 text-sm font-bold text-white">J</span>
            Job Agent
          </Link>
          <nav aria-label="Main" className="hidden items-center gap-1 md:flex">
            {ITEMS.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                aria-current={isActive(item.href) ? "page" : undefined}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                  isActive(item.href) ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                }`}
              >
                {item.label}
              </Link>
            ))}
          </nav>
        </div>
      </header>

      {/* Mobile: bottom tab bar */}
      <nav aria-label="Main" className="fixed inset-x-0 bottom-0 z-40 border-t border-slate-200 bg-white/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden">
        <ul className="grid grid-cols-5">
          {ITEMS.map((item) => (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={isActive(item.href) ? "page" : undefined}
                className={`flex flex-col items-center gap-0.5 py-2 text-[11px] font-medium ${isActive(item.href) ? "text-indigo-600" : "text-slate-500"}`}
              >
                <Icon d={item.icon} />
                {item.label === "Applications" ? "Applied" : item.label === "Preferences" ? "Prefs" : item.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </>
  );
}
