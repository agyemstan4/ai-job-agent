"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { formatSalary, greetingFor, loadDashboard, timeAgo } from "@/lib/dashboard-client";
import type { Dashboard } from "@/lib/pipeline/dashboard";
import type { PreparationStatus } from "@/lib/pipeline/preparation-queue";
import { loadPreparationStatus } from "@/lib/preparation-client";
import { awayLines, buildDailyBrief, LAST_VISIT_KEY, readViewed } from "@/lib/daily-brief";
import { loadSavedBrief, workedWhileAway } from "@/lib/agent-client";
import type { BriefItem, DailyBrief } from "@/lib/daily-brief";
import {
  NOTIFICATION_SETTINGS_KEY,
  parseNotificationSettings,
  NOTIFICATION_TOPICS,
  notificationSupport,
  NOTIFICATIONS_DELIVERY_ENABLED,
  saveNotificationSettings,
} from "@/lib/notifications";
import type { NotificationSettings } from "@/lib/notifications";

// Today (Phase 4a): the mobile-first daily brief — what's worth your time,
// why, and what changed since you last looked. Built on demand from the jobs
// your agent has already found (lib/daily-brief.ts); it does not search, and
// it never claims a search ran on its own. Reviewing opens the full
// opportunity; applying always stays your decision.

const CARD = "rounded-2xl bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)] ring-1 ring-slate-200/80";

const PREP_TEXT: Partial<Record<BriefItem["preparation"], string>> = {
  queued: "Queued for preparation",
  preparing: "Being prepared",
  ready_for_review: "Application ready",
  approved: "Approved — ready to apply",
  failed: "Preparation needs attention",
};

function OpportunityCard({ item }: { item: BriefItem }) {
  const salary = formatSalary(item.salaryMin, item.salaryMax, item.salaryIsPredicted);
  return (
    <article className={`p-4 ${CARD}`} aria-labelledby={`opp-${item.matchId}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            {item.isNew && <span className="rounded-full bg-sky-50 px-2 py-0.5 text-xs font-semibold text-sky-800 ring-1 ring-inset ring-sky-600/20">New</span>}
            {PREP_TEXT[item.preparation] && (
              <span className="rounded-full bg-violet-50 px-2 py-0.5 text-xs font-semibold text-violet-800 ring-1 ring-inset ring-violet-600/20">{PREP_TEXT[item.preparation]}</span>
            )}
          </div>
          <h3 id={`opp-${item.matchId}`} className="mt-1 text-lg font-semibold leading-snug text-slate-900">{item.title}</h3>
          <p className="text-sm text-slate-700">{item.company}</p>
          <p className="mt-0.5 text-sm text-slate-600">
            {salary && <span className="font-semibold text-slate-900">{salary}</span>}
            {salary && item.location && " · "}
            {item.location ?? (salary ? "" : "Location not stated")}
          </p>
        </div>
        <div className="shrink-0 text-right">
          <p className="text-lg font-semibold text-slate-900">{item.score === null ? "–" : `${item.score}%`}</p>
          <p className="text-xs font-medium text-slate-600">{item.quality}</p>
        </div>
      </div>
      {item.benefits.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-1.5" aria-label="Benefits confirmed by the job advert">
          {item.benefits.map((b) => (
            <li key={b.id} className={`rounded-md px-2 py-0.5 text-sm font-medium ring-1 ring-inset ${b.priority ? "bg-emerald-50 text-emerald-900 ring-emerald-600/30" : "bg-white text-slate-700 ring-slate-300"}`}>
              <span aria-hidden="true">✓ </span>{b.label}{b.priority && <span className="sr-only"> (one of your preferences)</span>}
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-sm font-medium text-slate-900">{item.headline}</p>
      {item.whyHere !== item.headline && (
        <p className="mt-0.5 text-xs text-slate-600"><span className="sr-only">Why it&rsquo;s here: </span>{item.whyHere}</p>
      )}
      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
        <Link href={`/opportunity/${item.matchId}`} className="inline-flex min-h-11 flex-1 items-center justify-center rounded-lg bg-indigo-600 px-4 text-sm font-semibold text-white hover:bg-indigo-500">
          Review opportunity<span className="sr-only">: {item.title} at {item.company}</span>
        </Link>
        {item.preparation === "ready_for_review" && (
          <Link href="/review" className="inline-flex min-h-11 items-center justify-center rounded-lg px-4 text-sm font-semibold text-violet-800 ring-1 ring-inset ring-violet-300 hover:bg-violet-50">
            Review application
          </Link>
        )}
      </div>
    </article>
  );
}

// Notification choices live in this browser (localStorage), read as an external store.
const SETTINGS_EVENT = "jobAgent:notification-settings";
function subscribeSettings(onChange: () => void) {
  window.addEventListener("storage", onChange);
  window.addEventListener(SETTINGS_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(SETTINGS_EVENT, onChange);
  };
}
function readSettingsRaw(): string | null {
  try {
    return window.localStorage.getItem(NOTIFICATION_SETTINGS_KEY);
  } catch {
    return null;
  }
}
const noSubscribe = () => () => {};

function NotificationSettingsCard() {
  const raw = useSyncExternalStore(subscribeSettings, readSettingsRaw, () => null);
  const settings = useMemo(() => {
    try {
      return parseNotificationSettings(raw ? JSON.parse(raw) : null);
    } catch {
      return parseNotificationSettings(null);
    }
  }, [raw]);
  const installed = useSyncExternalStore(noSubscribe, () => notificationSupport(window).installed, () => true);
  function toggle(id: keyof NotificationSettings) {
    try {
      saveNotificationSettings(window.localStorage, { ...settings, [id]: !settings[id] });
      window.dispatchEvent(new Event(SETTINGS_EVENT));
    } catch {
      // Not remembered without storage; nothing else depends on it yet.
    }
  }
  return (
    <section className={`p-5 ${CARD}`} aria-labelledby="notifications-heading">
      <h2 id="notifications-heading" className="text-base font-semibold text-slate-900">Phone notifications</h2>
      <p className="mt-1 text-sm text-slate-600">
        {NOTIFICATIONS_DELIVERY_ENABLED ? "" : "Not switched on yet — nothing is sent. "}Choose what your agent should tell you about once phone notifications arrive. Saved on this device.
      </p>
      <ul className="mt-3 divide-y divide-slate-100">
        {NOTIFICATION_TOPICS.map((topic) => (
          <li key={topic.id}>
            <label className="flex min-h-12 cursor-pointer items-center justify-between gap-4 py-2">
              <span className="min-w-0">
                <span className="block text-sm font-medium text-slate-900">{topic.label}</span>
                <span className="block text-sm text-slate-600">{topic.description}</span>
              </span>
              <input type="checkbox" checked={settings[topic.id]} onChange={() => toggle(topic.id)} className="h-6 w-6 shrink-0 accent-indigo-600" />
            </label>
          </li>
        ))}
      </ul>
      {!installed && (
        <p className="mt-2 text-sm text-slate-600">Tip: add Job Agent to your home screen from your browser&rsquo;s menu to open it like an app.</p>
      )}
    </section>
  );
}

export default function TodayPage() {
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [brief, setBrief] = useState<DailyBrief | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hour, setHour] = useState<number | null>(null);
  const [worked, setWorked] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([loadDashboard(), loadPreparationStatus(), loadSavedBrief()]).then(([result, prepResult, saved]) => {
      if (cancelled) return;
      if (result.kind !== "loaded") {
        setError(result.message);
        return;
      }
      // The previous visit (this browser only), then record this one — shared with Home.
      let lastVisit: number | null = null;
      let viewed = new Set<number>();
      try {
        const stored = Number(window.localStorage.getItem(LAST_VISIT_KEY));
        lastVisit = Number.isFinite(stored) && stored > 0 ? stored : null;
        window.localStorage.setItem(LAST_VISIT_KEY, String(Date.now()));
        viewed = readViewed(window.localStorage);
      } catch {
        lastVisit = null;
      }
      const prep: PreparationStatus | null = prepResult.kind === "loaded" ? prepResult.status : null;
      setDashboard(result.dashboard);
      if (saved.kind === "ready") {
        // The daily run saved a brief today: show it (with "While you were away"
        // only if it was made after your last visit).
        const fresh = workedWhileAway(saved.brief, lastVisit);
        setWorked(fresh);
        setBrief({
          ...saved.brief,
          items: saved.brief.items.map((item) => ({ ...item, viewed: item.viewed || viewed.has(item.matchId) })),
          away: fresh ? saved.brief.away : null,
        });
      } else {
        // No saved brief yet today: build one now from the jobs already found.
        setBrief(buildDailyBrief(result.dashboard, prep, { lastVisit, viewed }));
      }
      setHour(new Date().getHours());
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const greeting = hour === null ? "Welcome back" : greetingFor(hour);
  const lastSearched = timeAgo(brief?.lastSearchAt);
  const first = brief?.items.slice(0, brief.priorityCount) ?? [];
  const more = brief?.items.slice(brief.priorityCount) ?? [];

  return (
    <main className="w-full py-5 sm:py-8">
      <div className="app-shell max-w-3xl">
        <h1 className="text-3xl font-semibold tracking-tight text-slate-900">
          {greeting}{dashboard?.firstName ? `, ${dashboard.firstName}` : ""}.
        </h1>
        <p className="mt-1 text-base text-slate-600">
          {worked ? "Your agent worked while you were away. Here’s your job brief for today." : "Here’s your job brief for today."}
        </p>

        {error ? (
          <div className={`mt-6 p-6 text-center ${CARD}`} role="alert">
            <p className="font-medium text-rose-800">{error}</p>
            <button onClick={() => window.location.reload()} className="mt-3 min-h-11 rounded-lg bg-slate-900 px-5 text-sm font-semibold text-white">Try again</button>
          </div>
        ) : !brief ? (
          <div className="mt-6 space-y-3" aria-busy="true">
            <p className="sr-only" role="status">Loading your brief…</p>
            {[0, 1, 2].map((i) => <div key={i} className={`h-36 animate-pulse ${CARD}`} />)}
          </div>
        ) : !brief.hasProfile ? (
          <div className={`mt-6 p-6 ${CARD}`}>
            <p className="text-lg font-semibold text-slate-900">Let&rsquo;s get your agent started.</p>
            <p className="mt-1 text-slate-600">Upload your CV and tell your agent what you&rsquo;re looking for. Your brief will show the opportunities worth your time.</p>
            <Link href="/#search" className="mt-4 inline-flex min-h-11 items-center rounded-lg bg-indigo-600 px-5 text-sm font-semibold text-white hover:bg-indigo-500">Get started</Link>
          </div>
        ) : (
          <>
            {/* Summary */}
            <div className={`mt-5 p-5 ${CARD}`}>
              <p className="text-sm font-medium text-slate-600">Your agent has found</p>
              <dl className="mt-2 grid grid-cols-3 gap-2 text-center">
                <div><dt className="text-xs text-slate-600">Opportunities</dt><dd className="text-2xl font-semibold text-slate-900">{brief.considered}</dd></div>
                <div><dt className="text-xs text-slate-600">Strong matches</dt><dd className="text-2xl font-semibold text-emerald-700">{brief.strongMatches}</dd></div>
                <div><dt className="text-xs text-slate-600">Review first</dt><dd className="text-2xl font-semibold text-indigo-700">{brief.priorityCount}</dd></div>
              </dl>
              <p className="mt-3 text-xs text-slate-600">
                {brief.origin === "scheduled_run"
                  ? `Prepared by your agent at ${new Date(brief.generatedAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`
                  : "Based on the jobs your agent has found so far"}
                {lastSearched ? ` · last search ${lastSearched}` : ""}.
              </p>
            </div>

            {(brief.warnings ?? []).map((w) => (
              <p key={w} className="mt-3 rounded-xl bg-amber-50 px-4 py-2.5 text-sm text-amber-900 ring-1 ring-inset ring-amber-600/20" role="status">{w}</p>
            ))}

            {/* While you were away */}
            {brief.away && (
              <section className="mt-4 rounded-2xl bg-indigo-50 p-5 ring-1 ring-inset ring-indigo-200" aria-labelledby="away-heading" role="status">
                <h2 id="away-heading" className="text-base font-semibold text-indigo-950">While you were away</h2>
                <ul className="mt-2 space-y-1 text-sm text-indigo-950">
                  {awayLines(brief.away).map((line) => (
                    <li key={line} className="flex gap-2"><span aria-hidden="true">•</span>{line}</li>
                  ))}
                </ul>
              </section>
            )}

            {brief.items.length === 0 ? (
              <div className={`mt-4 p-6 ${CARD}`}>
                <p className="text-lg font-semibold text-slate-900">{brief.considered === 0 ? "No opportunities yet." : "You're up to date."}</p>
                <p className="mt-1 text-slate-600">
                  {brief.considered === 0
                    ? "Tell your agent what you’re looking for and it will find and rank jobs for you."
                    : "There’s nothing new to review right now. Your applications are on the Applications page."}
                </p>
                <Link href={brief.considered === 0 ? "/#search" : "/applications"} className="mt-4 inline-flex min-h-11 items-center rounded-lg bg-indigo-600 px-5 text-sm font-semibold text-white hover:bg-indigo-500">
                  {brief.considered === 0 ? "Describe what you’re looking for" : "Open applications"}
                </Link>
              </div>
            ) : (
              <>
                <section className="mt-6" aria-labelledby="first-heading">
                  <h2 id="first-heading" className="text-sm font-semibold uppercase tracking-wider text-slate-600">Worth reviewing first</h2>
                  <ol className="mt-3 space-y-3">
                    {first.map((item) => <li key={item.matchId}><OpportunityCard item={item} /></li>)}
                  </ol>
                </section>
                {more.length > 0 && (
                  <section className="mt-6" aria-labelledby="more-heading">
                    <h2 id="more-heading" className="text-sm font-semibold uppercase tracking-wider text-slate-600">More opportunities</h2>
                    <ol className="mt-3 space-y-3">
                      {more.map((item) => <li key={item.matchId}><OpportunityCard item={item} /></li>)}
                    </ol>
                  </section>
                )}
              </>
            )}

            <div className="mt-6 flex flex-col gap-2 sm:flex-row">
              <Link href="/#search" className="inline-flex min-h-11 flex-1 items-center justify-center rounded-lg px-4 text-sm font-semibold text-slate-800 ring-1 ring-inset ring-slate-300 hover:bg-slate-50">Find new jobs</Link>
              <Link href="/" className="inline-flex min-h-11 flex-1 items-center justify-center rounded-lg px-4 text-sm font-semibold text-slate-800 ring-1 ring-inset ring-slate-300 hover:bg-slate-50">Open full dashboard</Link>
            </div>
          </>
        )}

        <div className="mt-6">
          <NotificationSettingsCard />
        </div>
      </div>
    </main>
  );
}
