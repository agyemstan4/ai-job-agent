"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { Dashboard, DashboardMatch } from "@/lib/pipeline/dashboard";
import {
  actionFor,
  FEED_VIEWS,
  filterMatches,
  formatSalary,
  greetingFor,
  loadDashboard,
  newSinceLastVisit,
  pickFeatured,
  progressGroups,
  scoreBadge,
  sourceLabel,
  statusInfo,
  timeAgo,
  workArrangement,
} from "@/lib/dashboard-client";
import type { FeedView, LoadResult, MatchAction, Tone } from "@/lib/dashboard-client";
import type { PreparationItem, PreparationStatus } from "@/lib/pipeline/preparation-queue";
import {
  hasActiveWork,
  loadPreparationStatus,
  needsAttention,
  nextPollDelay,
  progressLine,
  queuePreparation,
  queuePreparations,
  stepsFor,
  whileYouWereAway,
} from "@/lib/preparation-client";

// The Command Centre (Phase 3 checkpoint 3c, v2 visual pass): your job hunt,
// built only from existing data. "Prepare Application" (or several selected
// jobs) adds jobs to the server's preparation queue and returns at once; the
// agent prepares them in the background, even if this page is closed. Each
// package is a draft for your review — nothing is approved, submitted or sent.
// "View Job" only opens the job advert in a new tab.

const LAST_VISIT_KEY = "jobAgent.lastVisit";

const TONES: Record<Tone, string> = {
  green: "bg-emerald-50 text-emerald-700 ring-emerald-600/20",
  blue: "bg-sky-50 text-sky-700 ring-sky-600/20",
  amber: "bg-amber-50 text-amber-800 ring-amber-600/20",
  red: "bg-rose-50 text-rose-700 ring-rose-600/20",
  gray: "bg-slate-100 text-slate-600 ring-slate-500/20",
  violet: "bg-violet-50 text-violet-700 ring-violet-600/20",
};

type Notice = { kind: "success" | "error" | "info"; text: string; matchId: number };
const NOTICE_STYLES: Record<Notice["kind"], string> = {
  success: "bg-emerald-50 text-emerald-800 ring-emerald-600/20",
  error: "bg-rose-50 text-rose-800 ring-rose-600/20",
  info: "bg-sky-50 text-sky-800 ring-sky-600/20",
};

function Pill({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${TONES[tone]}`}>{children}</span>;
}

function scoreColour(score: number | null) {
  if (score === null) return { ring: "#cbd5e1", text: "text-slate-500" };
  if (score >= 80) return { ring: "#059669", text: "text-emerald-700" };
  if (score >= 70) return { ring: "#16a34a", text: "text-green-700" };
  if (score >= 50) return { ring: "#d97706", text: "text-amber-700" };
  return { ring: "#e11d48", text: "text-rose-700" };
}

/** A circular match score. */
function ScoreRing({ score, size = 76 }: { score: number | null; size?: number }) {
  const stroke = size > 60 ? 7 : 5;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(100, score ?? 0));
  const colour = scoreColour(score);
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }} aria-label={score === null ? "Not scored" : `${score}% match`}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#eef2f7" strokeWidth={stroke} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={colour.ring} strokeWidth={stroke} strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c - (pct / 100) * c} />
      </svg>
      <div className={`absolute inset-0 grid place-items-center font-semibold tracking-tight ${colour.text} ${size > 60 ? "text-xl" : "text-sm"}`}>
        {score === null ? "–" : `${score}%`}
      </div>
    </div>
  );
}

/** The next action for a match, always exactly one primary button. */
type CardAction = MatchAction | "queued";

function PrimaryAction({ action, onPrepare, disabled, block, stage }: { action: CardAction; onPrepare: () => void; disabled: boolean; block?: boolean; stage?: string | null }) {
  const base = `inline-flex items-center justify-center rounded-lg px-4 py-2 text-sm font-semibold transition ${block ? "w-full" : ""}`;
  switch (action) {
    case "prepare":
      return (
        <button onClick={onPrepare} disabled={disabled} className={`${base} bg-indigo-600 text-white shadow-sm hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50`}>
          Prepare Application
        </button>
      );
    case "queued":
      return (
        <span className={`${base} cursor-default bg-slate-100 text-slate-600 ring-1 ring-inset ring-slate-300`}>Queued</span>
      );
    case "preparing":
      return (
        <span className={`${base} cursor-default bg-sky-50 text-sky-700 ring-1 ring-inset ring-sky-600/20`} title={stage ?? undefined}>
          <span className="mr-2 h-2 w-2 animate-pulse rounded-full bg-sky-500" />Preparing…
        </span>
      );
    case "review":
      return <Link href="/review" className={`${base} bg-violet-600 text-white shadow-sm hover:bg-violet-500`}>Review Application</Link>;
    case "apply":
      return <Link href="/applications" className={`${base} bg-emerald-600 text-white shadow-sm hover:bg-emerald-500`}>Ready to apply</Link>;
    case "track":
      return <Link href="/applications" className={`${base} bg-slate-900 text-white hover:bg-slate-700`}>Track</Link>;
  }
}

function ViewJob({ url, block }: { url: string | null; block?: boolean }) {
  if (!url) return null;
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className={`inline-flex items-center justify-center rounded-lg px-4 py-2 text-sm font-semibold text-slate-700 ring-1 ring-inset ring-slate-300 hover:bg-slate-50 ${block ? "w-full" : ""}`}>
      View Job <span aria-hidden="true" className="ml-1">↗</span>
    </a>
  );
}

function Breakdown({ breakdown }: { breakdown: NonNullable<DashboardMatch["breakdown"]> }) {
  const rows: [string, number | null][] = [
    ["Skills", breakdown.technicalSkills],
    ["Experience", breakdown.experienceLevel],
    ["Projects", breakdown.projects],
    ["Growth", breakdown.growthPotential],
  ];
  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
      {rows.filter(([, v]) => v !== null).map(([label, value]) => (
        <div key={label}>
          <dt className="flex justify-between text-xs text-slate-500"><span>{label}</span><span className="font-medium text-slate-700">{value}</span></dt>
          <dd className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full bg-indigo-500" style={{ width: `${value}%` }} /></dd>
        </div>
      ))}
    </dl>
  );
}

function NoticeLine({ notice }: { notice: Notice | null }) {
  if (!notice) return null;
  return (
    <p className={`mt-3 rounded-lg px-3 py-2 text-sm ring-1 ring-inset ${NOTICE_STYLES[notice.kind]}`} role={notice.kind === "error" ? "alert" : "status"}>
      {notice.text}
    </p>
  );
}

function Skeleton() {
  return (
    <div className="mt-8 animate-pulse space-y-4" aria-label="Loading your dashboard…">
      <p className="sr-only">Loading your dashboard…</p>
      <div className="h-56 rounded-2xl bg-white shadow-sm ring-1 ring-slate-200/70" />
      {[0, 1, 2].map((i) => <div key={i} className="h-20 rounded-xl bg-white shadow-sm ring-1 ring-slate-200/70" />)}
    </div>
  );
}

export default function CommandCentre() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [prep, setPrep] = useState<PreparationStatus | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [batchBusy, setBatchBusy] = useState(false);
  const polls = useRef(0);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [view, setView] = useState<FeedView>("all");
  const [query, setQuery] = useState("");
  const [lastVisit, setLastVisit] = useState<number | null>(null);
  const [hour, setHour] = useState<number | null>(null);

  function apply(result: LoadResult) {
    if (result.kind === "loaded") {
      setDashboard(result.dashboard);
      setError(null);
    } else {
      setError(result.message);
    }
    setLoading(false);
  }

  useEffect(() => {
    let cancelled = false;
    Promise.all([loadDashboard(), loadPreparationStatus()]).then(([result, prepResult]) => {
      if (cancelled) return;
      if (prepResult.kind === "loaded") setPrep(prepResult.status);
      // The previous visit (this browser only), then record this one.
      let previous: number | null = null;
      try {
        const stored = Number(window.localStorage.getItem(LAST_VISIT_KEY));
        previous = Number.isFinite(stored) && stored > 0 ? stored : null;
        window.localStorage.setItem(LAST_VISIT_KEY, String(Date.now()));
      } catch {
        previous = null;
      }
      setLastVisit(previous);
      setHour(new Date().getHours());
      apply(result);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function reload() {
    setLoading(true);
    apply(await loadDashboard());
  }

  const refreshQueue = useCallback(async () => {
    const result = await loadPreparationStatus();
    if (result.kind !== "loaded") return null;
    setPrep((previous) => {
      // A job finished: refresh the job cards once (not the whole page).
      const finishedNow = result.status.items.some((item) => {
        const before = previous?.items.find((p) => p.applicationId === item.applicationId);
        return before && before.state !== item.state && (item.state === "ready" || item.state === "failed");
      });
      if (finishedNow) loadDashboard().then(apply);
      return result.status;
    });
    return result.status;
  }, []);

  // Poll while anything is preparing or queued; stop when nothing remains.
  useEffect(() => {
    const delay = nextPollDelay(prep, polls.current);
    if (delay === null) {
      polls.current = 0;
      return;
    }
    const timer = setTimeout(() => {
      polls.current += 1;
      refreshQueue();
    }, delay);
    return () => clearTimeout(timer);
  }, [prep, refreshQueue]);

  async function afterQueueing() {
    polls.current = 0;
    await refreshQueue();
    apply(await loadDashboard());
  }

  async function prepare(match: DashboardMatch, retry = false) {
    const result = await queuePreparation(match.matchId, { retry });
    if (result.kind === "error") {
      setNotice({ kind: "error", matchId: match.matchId, text: result.message });
    } else if (result.kind === "existing" && !["queued", "preparing"].includes(result.state)) {
      setNotice({ kind: "info", matchId: match.matchId, text: "This job already has an application — nothing was prepared again." });
    } else {
      setNotice({ kind: "info", matchId: match.matchId, text: "Added to your preparation queue. Your agent keeps working in the background — you can leave this page." });
    }
    await afterQueueing();
  }

  async function prepareSelected() {
    const ids = [...selected];
    if (ids.length === 0) return;
    setBatchBusy(true);
    const result = await queuePreparations(ids);
    setBatchBusy(false);
    if (result.kind === "error") {
      setError(result.message);
      return;
    }
    setSelected(new Set());
    await afterQueueing();
  }

  async function retry(item: PreparationItem) {
    if (item.matchId === null) return;
    const result = await queuePreparation(item.matchId, { retry: true });
    if (result.kind === "error") setError(result.message);
    await afterQueueing();
  }

  const toggle = (matchId: number) =>
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(matchId)) next.delete(matchId);
      else next.add(matchId);
      return next;
    });

  const matches = useMemo(() => dashboard?.topMatches ?? [], [dashboard]);
  const featured = useMemo(() => pickFeatured(matches), [matches]);
  const feed = useMemo(
    () => filterMatches(matches.filter((m) => m.matchId !== featured?.matchId), view, query, dashboard?.strongMatchScore),
    [matches, featured, view, query, dashboard]
  );
  const fresh = useMemo(() => newSinceLastVisit(matches, lastVisit), [matches, lastVisit]);
  const prepByApp = useMemo(() => new Map((prep?.items ?? []).map((i) => [i.applicationId, i])), [prep]);
  const prepItemOf = (m: DashboardMatch) => (m.application ? prepByApp.get(m.application.id) ?? null : null);
  const actionOf = (m: DashboardMatch): CardAction => {
    const item = prepItemOf(m);
    if (item?.state === "queued") return "queued";
    if (item?.state === "preparing") return "preparing";
    return actionFor(m);
  };
  const away = useMemo(() => whileYouWereAway(prep, lastVisit), [prep, lastVisit]);

  const stats = dashboard?.stats;
  const progress = stats ? progressGroups(stats.applicationsByStatus) : [];
  const greeting = hour === null ? "Welcome back" : greetingFor(hour);
  const lastSearched = timeAgo(dashboard?.agent.lastDiscoveryAt);
  const searchTerms = dashboard?.search.terms ?? [];

  return (
    <section aria-labelledby="command-centre-heading">
      {/* ── Hero: greeting + agent status + discovery ─────────────────────── */}
      <div className="pt-2">
        <h1 id="command-centre-heading" className="text-3xl font-semibold tracking-tight text-slate-900 sm:text-4xl">
          {greeting}{dashboard?.firstName ? `, ${dashboard.firstName}` : ""}.
        </h1>
        <p className="mt-1 text-lg text-slate-500">Let&rsquo;s find your next move.</p>
        {dashboard && (
          <p className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-slate-500">
            <span className="inline-flex items-center gap-1.5 font-medium text-slate-700">
              <span className={`h-2 w-2 rounded-full ${stats && stats.preparing > 0 ? "animate-pulse bg-sky-500" : "bg-emerald-500"}`} />
              {stats && stats.preparing > 0 ? "Your agent is preparing an application" : "Your agent is ready"}
            </span>
            {lastSearched && <span>· last searched {lastSearched}</span>}
            {stats && <span>· {stats.discoveredJobs} jobs scanned · {stats.scoredMatches} matched</span>}
          </p>
        )}
      </div>

      <div className="mt-6 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200/70 sm:p-5">
        <div className="flex flex-col gap-3 md:flex-row md:items-center">
          <label className="relative flex-1">
            <span className="sr-only">Search your matches</span>
            <svg viewBox="0 0 24 24" className="pointer-events-none absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-slate-400" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search your matches — title, company, skill…"
              className="w-full rounded-xl border-0 bg-slate-50 py-3 pl-10 pr-3 text-slate-900 ring-1 ring-inset ring-slate-200 placeholder:text-slate-400 focus:bg-white focus:ring-2 focus:ring-indigo-500"
            />
          </label>
          <a href="#search" className="inline-flex items-center justify-center rounded-xl bg-indigo-600 px-5 py-3 text-sm font-semibold text-white shadow-sm hover:bg-indigo-500">
            Find new jobs
          </a>
        </div>
        {dashboard && (
          <p className="mt-3 text-sm text-slate-500">
            Searching for <span className="font-medium text-slate-700">{searchTerms.slice(0, 2).join(", ")}{searchTerms.length > 2 ? ` +${searchTerms.length - 2} more` : ""}</span> in{" "}
            <span className="font-medium text-slate-700">{dashboard.search.location}</span>
            {dashboard.search.usingPreferences ? "" : " (defaults)"} ·{" "}
            <Link href="/preferences" className="font-medium text-indigo-600 hover:text-indigo-500">Edit preferences</Link>
          </p>
        )}
      </div>

      {loading && !dashboard ? (
        <Skeleton />
      ) : error && !dashboard ? (
        <div className="mt-8 rounded-2xl bg-white p-8 text-center shadow-sm ring-1 ring-slate-200/70" role="alert">
          <p className="font-medium text-rose-700">{error}</p>
          <button onClick={reload} className="mt-4 rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700">Try again</button>
        </div>
      ) : dashboard && stats ? (
        <>
          {error && <p className="mt-4 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-800 ring-1 ring-inset ring-rose-600/20" role="alert">{error}</p>}

          {/* ── Since your last visit / today / next steps (only with real data) ── */}
          {(fresh.length > 0 || stats.strongToday > 0 || stats.needsReview > 0 || stats.readyToApply > 0) && (
            <div className="-mx-4 mt-6 flex snap-x gap-3 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0">
              {fresh.length > 0 && (
                <a href="#jobs" className="min-w-[13rem] flex-1 snap-start rounded-xl sm:max-w-[16rem] bg-white p-4 shadow-sm ring-1 ring-slate-200/70 hover:ring-indigo-300">
                  <p className="text-xs font-medium uppercase tracking-wide text-indigo-600">New since your last visit</p>
                  <p className="mt-1 text-2xl font-semibold text-slate-900">{fresh.length}</p>
                  <p className="text-sm text-slate-500">new {fresh.length === 1 ? "match" : "matches"} in your list</p>
                </a>
              )}
              {stats.strongToday > 0 && (
                <a href="#jobs" className="min-w-[13rem] flex-1 snap-start rounded-xl sm:max-w-[16rem] bg-white p-4 shadow-sm ring-1 ring-slate-200/70 hover:ring-indigo-300">
                  <p className="text-xs font-medium uppercase tracking-wide text-emerald-600">Strong matches today</p>
                  <p className="mt-1 text-2xl font-semibold text-slate-900">{stats.strongToday}</p>
                  <p className="text-sm text-slate-500">scored {dashboard.strongMatchScore}% or higher</p>
                </a>
              )}
              {stats.needsReview > 0 && (
                <Link href="/review" className="min-w-[13rem] flex-1 snap-start rounded-xl sm:max-w-[16rem] bg-white p-4 shadow-sm ring-1 ring-slate-200/70 hover:ring-violet-300">
                  <p className="text-xs font-medium uppercase tracking-wide text-violet-600">Waiting for your review</p>
                  <p className="mt-1 text-2xl font-semibold text-slate-900">{stats.needsReview}</p>
                  <p className="text-sm text-slate-500">prepared {stats.needsReview === 1 ? "application" : "applications"} →</p>
                </Link>
              )}
              {stats.readyToApply > 0 && (
                <Link href="/applications" className="min-w-[13rem] flex-1 snap-start rounded-xl sm:max-w-[16rem] bg-white p-4 shadow-sm ring-1 ring-slate-200/70 hover:ring-emerald-300">
                  <p className="text-xs font-medium uppercase tracking-wide text-emerald-600">Ready to apply</p>
                  <p className="mt-1 text-2xl font-semibold text-slate-900">{stats.readyToApply}</p>
                  <p className="text-sm text-slate-500">approved — apply on the employer&rsquo;s site →</p>
                </Link>
              )}
            </div>
          )}

          {/* ── While you were away (only when something finished since the last visit) ── */}
          {away && (
            <div className="mt-6 rounded-xl bg-indigo-50/70 px-4 py-3 ring-1 ring-inset ring-indigo-200" role="status">
              <p className="text-sm font-semibold text-indigo-900">While you were away</p>
              <p className="mt-0.5 text-sm text-indigo-800">
                {away.finished > 0 && <>{away.finished} {away.finished === 1 ? "application" : "applications"} finished preparing. </>}
                {away.processing > 0 && <>{away.processing} still processing. </>}
                {away.attention > 0 && <>{away.attention} {away.attention === 1 ? "needs" : "need"} attention.</>}
              </p>
            </div>
          )}

          {prep && prep.items.length > 0 && <PreparationPanel status={prep} onRetry={retry} />}

          {/* ── Featured opportunity ─────────────────────────────────────── */}
          <h2 className="mt-10 text-sm font-semibold uppercase tracking-wide text-slate-500">Recommended for you</h2>
          {!dashboard.hasProfile ? (
            <div className="mt-3 rounded-2xl bg-white p-8 text-center shadow-sm ring-1 ring-slate-200/70">
              <p className="text-lg font-medium text-slate-900">Let&rsquo;s get you matched.</p>
              <p className="mt-1 text-slate-500">No CV profile yet. Upload your CV and run <strong>Find Suitable Jobs</strong> to see your matches here.</p>
              <a href="#search" className="mt-4 inline-flex rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500">Upload your CV</a>
            </div>
          ) : matches.length === 0 ? (
            <div className="mt-3 rounded-2xl bg-white p-8 text-center shadow-sm ring-1 ring-slate-200/70">
              <p className="text-lg font-medium text-slate-900">No scored matches yet.</p>
              <p className="mt-1 text-slate-500">Run <strong>Find Suitable Jobs</strong> — it uses your <Link href="/preferences" className="text-indigo-600 hover:underline">search preferences</Link>.</p>
            </div>
          ) : featured ? (
            <FeaturedCard
              match={featured}
              action={actionOf(featured)}
              strong={dashboard.strongMatchScore}
              onPrepare={() => prepare(featured)}
              prepItem={prepItemOf(featured)}
              notice={notice?.matchId === featured.matchId ? notice : null}
            />
          ) : (
            <div className="mt-3 rounded-2xl bg-white p-6 text-slate-600 shadow-sm ring-1 ring-slate-200/70">
              You&rsquo;ve acted on all of your current matches. <a href="#search" className="font-medium text-indigo-600 hover:underline">Find new jobs</a> to keep going.
            </div>
          )}

          {/* ── Job hunt summary + application progress (secondary) ───────── */}
          <div className="mt-8 flex flex-col gap-3 rounded-xl bg-white/60 px-4 py-3 ring-1 ring-slate-200/70 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-slate-600">
              <span className="font-semibold text-slate-900">{stats.discoveredJobs}</span> discovered ·{" "}
              <span className="font-semibold text-slate-900">{stats.scoredMatches}</span> matched ·{" "}
              <span className="font-semibold text-slate-900">{stats.strongMatches}</span> strong ·{" "}
              <span className="font-semibold text-slate-900">{stats.submitted}</span> applied
            </p>
            {progress.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5" aria-label="Your application progress">
                <span className="mr-1 text-xs font-medium uppercase tracking-wide text-slate-500">Your progress</span>
                {progress.map((g) => (
                  <Link key={g.key} href={g.key === "review" ? "/review" : "/applications"}><Pill tone={g.tone}>{g.count} {g.label}</Pill></Link>
                ))}
              </div>
            )}
          </div>

          {/* ── Job feed ─────────────────────────────────────────────────── */}
          {matches.length > 0 && (
            <div id="jobs" className="mt-10">
              <div className="flex flex-wrap items-end justify-between gap-2">
                <h2 className="text-xl font-semibold tracking-tight text-slate-900">Your opportunities</h2>
                <button onClick={reload} disabled={loading} className="text-sm font-medium text-slate-500 hover:text-slate-900 disabled:opacity-50">
                  {loading ? "Refreshing…" : "↻ Refresh"}
                </button>
              </div>
              <div className="-mx-4 mt-3 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0" role="tablist" aria-label="Filter your opportunities">
                {FEED_VIEWS.map((v) => (
                  <button
                    key={v.key}
                    role="tab"
                    aria-selected={view === v.key}
                    onClick={() => setView(v.key)}
                    className={`shrink-0 rounded-full px-3.5 py-1.5 text-sm font-medium ring-1 ring-inset transition ${view === v.key ? "bg-slate-900 text-white ring-slate-900" : "bg-white text-slate-600 ring-slate-200 hover:ring-slate-300"}`}
                  >
                    {v.label}
                  </button>
                ))}
              </div>

              {feed.length === 0 ? (
                <p className="mt-4 rounded-xl bg-white p-6 text-center text-sm text-slate-500 shadow-sm ring-1 ring-slate-200/70">
                  No opportunities match {query ? <>&ldquo;{query}&rdquo;</> : "this filter"}.
                </p>
              ) : (
                <ul className="mt-3 divide-y divide-slate-100 overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-slate-200/70">
                  {feed.map((match) => (
                    <FeedRow
                      key={match.matchId}
                      match={match}
                      action={actionOf(match)}
                      strong={dashboard.strongMatchScore}
                      onPrepare={() => prepare(match)}
                      prepItem={prepItemOf(match)}
                      selected={selected.has(match.matchId)}
                      onToggle={() => toggle(match.matchId)}
                      notice={notice?.matchId === match.matchId ? notice : null}
                    />
                  ))}
                </ul>
              )}
            </div>
          )}
          {selected.size > 0 && (
            <div className="sticky bottom-20 z-30 mt-4 flex items-center justify-between gap-3 rounded-2xl bg-slate-900 px-4 py-3 text-white shadow-lg md:bottom-4">
              <p className="text-sm"><span className="font-semibold">{selected.size}</span> selected</p>
              <div className="flex gap-2">
                <button onClick={() => setSelected(new Set())} className="rounded-lg px-3 py-2 text-sm font-medium text-slate-300 hover:text-white">Clear</button>
                <button onClick={prepareSelected} disabled={batchBusy} className="rounded-lg bg-indigo-500 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-400 disabled:opacity-60">
                  {batchBusy ? "Adding…" : `Prepare ${selected.size === 1 ? "selected application" : "selected applications"}`}
                </button>
              </div>
            </div>
          )}
        </>
      ) : null}
    </section>
  );
}

type CardProps = {
  match: DashboardMatch;
  action: CardAction;
  strong: number;
  onPrepare: () => void;
  notice: Notice | null;
  prepItem: PreparationItem | null;
  selected?: boolean;
  onToggle?: () => void;
};

function FeaturedCard({ match, action, strong, onPrepare, notice, prepItem }: CardProps) {
  const badge = scoreBadge(match.score, strong);
  const salary = formatSalary(match.salaryMin, match.salaryMax, match.salaryIsPredicted);
  const arrangement = workArrangement(match.contractTime, match.contractType);
  const source = sourceLabel(match.sources);
  const status = statusInfo(match.application?.status);
  const found = timeAgo(match.firstSeenAt);
  return (
    <article className="mt-3 overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-slate-200/70">
      <div className="h-1 bg-gradient-to-r from-indigo-500 via-violet-500 to-emerald-400" />
      <div className="p-5 sm:p-7">
        <div className="flex gap-4 sm:gap-6">
          <div className="flex flex-col items-center gap-1.5">
            <ScoreRing score={match.score} />
            <span className={`text-xs font-semibold ${scoreColour(match.score).text}`}>{badge.label} match</span>
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <Pill tone="violet">Top opportunity</Pill>
              {status && <Pill tone={status.tone}>{status.label}</Pill>}
            </div>
            <h3 className="mt-2 text-xl font-semibold leading-snug tracking-tight text-slate-900 sm:text-2xl">{match.title}</h3>
            <p className="mt-1 text-slate-600">
              <span className="font-medium text-slate-800">{match.company}</span>
              {match.location && <> · {match.location}</>}
            </p>
            <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm text-slate-500">
              {salary && <span className="font-medium text-slate-700">{salary}</span>}
              {arrangement && <span>{arrangement}</span>}
              {source && <span>via {source}</span>}
              {found && <span>found {found}</span>}
            </div>
          </div>
        </div>

        <div className="mt-6 grid gap-5 lg:grid-cols-[1.4fr_1fr]">
          <div>
            {match.strengths.length > 0 && (
              <>
                <h4 className="text-sm font-semibold text-slate-900">Why this job fits you</h4>
                <ul className="mt-2 flex flex-wrap gap-2">
                  {match.strengths.map((s) => (
                    <li key={s} className="inline-flex items-center gap-1 rounded-lg bg-emerald-50 px-2.5 py-1 text-sm font-medium text-emerald-800">
                      <span aria-hidden="true">✓</span>{s}
                    </li>
                  ))}
                </ul>
              </>
            )}
            {match.reason && (
              <>
                <h4 className={`${match.strengths.length ? "mt-4" : ""} text-sm font-semibold text-slate-900`}>{match.strengths.length ? "Your advantage" : "Why this job fits you"}</h4>
                <p className="mt-1 text-sm leading-relaxed text-slate-600">{match.reason}</p>
              </>
            )}
            {match.missingSkills.length > 0 && (
              <>
                <h4 className="mt-4 text-sm font-semibold text-slate-900">Potential gap</h4>
                <p className="mt-1 text-sm text-slate-600">
                  The advert also asks for <span className="font-medium text-amber-800">{match.missingSkills.slice(0, 3).join(", ")}</span>
                  {match.missingSkills.length > 3 ? ` and ${match.missingSkills.length - 3} more` : ""}.
                </p>
              </>
            )}
          </div>
          {match.breakdown && (
            <div className="self-start rounded-xl bg-slate-50 p-4">
              <h4 className="mb-3 text-sm font-semibold text-slate-900">How you match</h4>
              <Breakdown breakdown={match.breakdown} />
            </div>
          )}
        </div>

        {prepItem && (prepItem.state === "preparing" || prepItem.state === "queued") && (
          <div className="mt-6 rounded-xl bg-sky-50/60 p-4 ring-1 ring-inset ring-sky-100">
            <p className="text-sm font-semibold text-slate-900">{prepItem.state === "queued" ? "Queued for preparation" : "Preparing application"}</p>
            <Steps item={prepItem} />
          </div>
        )}

        <div className="mt-6 flex flex-col gap-2 sm:flex-row">
          <PrimaryAction action={action} onPrepare={onPrepare} disabled={false} block stage={prepItem?.currentStage} />
          <ViewJob url={match.url} block />
        </div>
        <NoticeLine notice={notice} />
      </div>
    </article>
  );
}

function FeedRow({ match, action, strong, onPrepare, notice, prepItem, selected, onToggle }: CardProps) {
  const salary = formatSalary(match.salaryMin, match.salaryMax, match.salaryIsPredicted);
  const status = statusInfo(match.application?.status);
  const isStrong = match.score !== null && match.score >= strong;
  return (
    <li className="p-4 sm:px-5">
      <div className="flex items-start gap-3 sm:items-center sm:gap-4">
        {action === "prepare" && onToggle ? (
          <input type="checkbox" checked={Boolean(selected)} onChange={onToggle} aria-label={`Select ${match.title}`} className="mt-4 h-4 w-4 shrink-0 accent-indigo-600 sm:mt-0" />
        ) : (
          <span className="w-4 shrink-0" aria-hidden="true" />
        )}
        <ScoreRing score={match.score} size={48} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate font-semibold text-slate-900" title={match.title}>{match.title}</h3>
            {isStrong && !status && <Pill tone="green">Strong</Pill>}
            {status && <Pill tone={status.tone}>{status.label}</Pill>}
          </div>
          <p className="mt-0.5 truncate text-sm text-slate-500">
            <span className="text-slate-700">{match.company}</span>
            {match.location && <> · {match.location}</>}
            {salary && <> · <span className="text-slate-700">{salary}</span></>}
          </p>
          {prepItem && (prepItem.state === "preparing" || prepItem.state === "queued") && (
            <p className="mt-1 text-xs font-medium text-sky-700">{progressLine(prepItem)}</p>
          )}
          {match.strengths.length > 0 && (
            <div className="mt-2 hidden flex-wrap gap-1.5 sm:flex">
              {match.strengths.slice(0, 3).map((s) => (
                <span key={s} className="rounded-md bg-slate-100 px-2 py-0.5 text-xs text-slate-600">{s}</span>
              ))}
            </div>
          )}
        </div>
        <div className="hidden shrink-0 items-center gap-2 sm:flex">
          {match.url && (
            <a href={match.url} target="_blank" rel="noopener noreferrer" className="rounded-lg px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900">
              View Job ↗
            </a>
          )}
          <PrimaryAction action={action} onPrepare={onPrepare} disabled={false} stage={prepItem?.currentStage} />
        </div>
      </div>
      {/* Mobile: actions on their own row */}
      <div className="mt-3 flex gap-2 sm:hidden">
        <ViewJob url={match.url} />
        <div className="flex-1"><PrimaryAction action={action} onPrepare={onPrepare} disabled={false} block stage={prepItem?.currentStage} /></div>
      </div>
      <NoticeLine notice={notice} />
    </li>
  );
}

const STEP_ICON: Record<string, { icon: string; className: string }> = {
  done: { icon: "✓", className: "text-emerald-600" },
  running: { icon: "●", className: "animate-pulse text-sky-500" },
  pending: { icon: "○", className: "text-slate-300" },
  failed: { icon: "✕", className: "text-rose-600" },
};

function Steps({ item }: { item: PreparationItem }) {
  return (
    <ol className="mt-2 grid gap-1 text-sm sm:grid-cols-2">
      {stepsFor(item).map((step) => (
        <li key={step.label} className={`flex items-center gap-2 ${step.state === "pending" ? "text-slate-400" : "text-slate-700"}`}>
          <span className={`w-4 text-center ${STEP_ICON[step.state]?.className ?? ""}`} aria-hidden="true">{STEP_ICON[step.state]?.icon ?? "○"}</span>
          {step.label}
          <span className="sr-only">({step.state})</span>
        </li>
      ))}
    </ol>
  );
}

/** The live preparation queue: counts and each job's progress. */
function PreparationPanel({ status, onRetry }: { status: PreparationStatus; onRetry: (item: PreparationItem) => void }) {
  const { summary } = status;
  const active = hasActiveWork(status);
  const items = [...status.items].sort((a, b) => {
    const order: Record<string, number> = { preparing: 0, queued: 1, failed: 2, ready: 3 };
    return (order[a.state] ?? 9) - (order[b.state] ?? 9) || a.applicationId - b.applicationId;
  });
  return (
    <section className="mt-6 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200/70 sm:p-5" aria-label="Application preparation">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold text-slate-900">Application preparation</h2>
          <p className="text-sm text-slate-500">
            {active ? "Your applications are being prepared. Your agent keeps working even if you leave this page." : "Your agent has finished preparing."}
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5 text-xs">
          {summary.preparing > 0 && <Pill tone="blue">{summary.preparing} preparing</Pill>}
          {summary.queued > 0 && <Pill tone="gray">{summary.queued} queued</Pill>}
          {summary.ready > 0 && <Pill tone="violet">{summary.ready} ready for review</Pill>}
          {summary.failed > 0 && <Pill tone="red">{summary.failed} failed</Pill>}
        </div>
      </div>
      <ul className="mt-3 divide-y divide-slate-100">
        {items.slice(0, 8).map((item) => (
          <li key={item.applicationId} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-slate-900">{item.title} <span className="font-normal text-slate-500">· {item.company}</span></p>
              <p className={`text-sm ${needsAttention(item) ? "text-rose-700" : item.state === "ready" ? "text-emerald-700" : "text-slate-600"}`}>
                {item.state === "ready" && !item.error ? "✓ " : item.state === "failed" ? "✕ " : item.state === "preparing" ? "● " : ""}
                {progressLine(item)}
              </p>
              {item.state === "preparing" && <Steps item={item} />}
            </div>
            <div className="flex shrink-0 gap-2">
              {needsAttention(item) && item.matchId !== null && (
                <button onClick={() => onRetry(item)} className="rounded-lg px-3 py-1.5 text-sm font-semibold text-rose-700 ring-1 ring-inset ring-rose-300 hover:bg-rose-50">Retry</button>
              )}
              {item.state === "ready" && (
                <Link href="/review" className="rounded-lg bg-violet-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-violet-500">Review Application</Link>
              )}
            </div>
          </li>
        ))}
      </ul>
      {items.length > 8 && <p className="pt-2 text-xs text-slate-500">+{items.length - 8} more</p>}
    </section>
  );
}
