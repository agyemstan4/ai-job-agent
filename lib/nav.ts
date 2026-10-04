// Navigation helpers (framework free, so they can be tested directly).

/** Which main-navigation section a path belongs to ("/review" is part of Applications; an opportunity is part of Today). */
export function activeSection(pathname: string): string {
  if (pathname.startsWith("/today") || pathname.startsWith("/opportunity")) return "/today";
  if (pathname.startsWith("/applications") || pathname.startsWith("/review")) return "/applications";
  if (pathname.startsWith("/preferences")) return "/preferences";
  return pathname === "/" ? "/" : "";
}
