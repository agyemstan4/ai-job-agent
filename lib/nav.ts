// Navigation helpers (framework free, so they can be tested directly).

/** Which main-navigation section a path belongs to ("/review" is part of Applications). */
export function activeSection(pathname: string): string {
  if (pathname.startsWith("/applications") || pathname.startsWith("/review")) return "/applications";
  if (pathname.startsWith("/preferences")) return "/preferences";
  return pathname === "/" ? "/" : "";
}
