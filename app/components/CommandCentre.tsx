"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { Dashboard, DashboardMatch } from "@/lib/pipeline/dashboard";
import {
  actionFor,
  awayMessage,
  FEED_VIEWS,
  filterMatches,
  formatSalary,
  greetingFor,
  loadDashboard,
  matchQuality,
  newSinceLastVisit,
  nextStep,
  pickFeatured,
  progressGroups,
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

// The Command Centre: your job hunt at a glance, built only from existing
// data. It always shows one clear next step. "Prepare Application" (or several
// selected jobs) adds jobs to the server's preparation queue and returns at
// once; the agent prepares them in the background, even if this page is
// closed. Each package is a draft for your review — nothing is approved,
// submitted or sent. "View Job" only opens the job advert in a new tab.

const LAST_VISIT_KEY = "jobAgent.lastVisit";

const TONES: Record<Tone, string> = {
  green: "bg-emerald-50 text-emerald-800 ring-emerald-600/20",
  blue: "bg-sky-50 text-sky-800 ring-sky-600/20",
  amber: "bg-amber-50 text-amber-900 ring-amber-600/20",
  red: "bg-rose-50 text-rose-800 ring-rose-600/20",
  gray: "bg-slate-100 text-slate-700 ring-slate-500/20",
  violet: "bg-violet-50 text-violet-800 ring-violet-600/20",
};

type Notice = { kind: "success" | "error" | "info"; text: string; matchId: number };
const NOTICE_STYLES: Record<Notice["kind"], string> = {
  success: "bg-emerald-50 text-emerald-900 ring-emerald-600/20",
  error: "bg-rose-50 text-rose-900 ring-rose-600/20",
  info: "bg-sky-50 text-sky-900 ring-sky-600/20",
};

const CARD = "rounded-2xl bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)] ring-1 ring-slate-200/80";

function Pill({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return <span className={`inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${TONES[tone]}`}>{children}</span>;
}

function scoreColour(score: number | null) {
  if (score === null) return { ring: "#cbd5e1", text: "text-slate-600" };
  if (score >= 80) return { ring: "#059669", text: "text-emerald-700" };
  if (score >= 70) return { ring: "#16a34a", text: "text-green-700" };
  if (score >= 50) return { ring: "#d97706", text: "text-amber-700" };
  return { ring: "#e11d48", text: "text-rose-700" };
}

/** A circular match score. The text label next to it carries the meaning, not the colour. */
function ScoreRing({ score, size = 76 }: { score: number | null; size?: number }) {
  const stroke = size > 60 ? 7 : 5;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(100, score ?? 0));
  const colour = scoreColour(score);
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }} role="img" aria-label={score === null ? "Not scored" : `${score}% match`}>
      <svg width={size} height={size} className="-rotate-90" aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#eef2f7" strokeWidth={stroke} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={colour.ring} strokeWidth={stroke} strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c - (pct / 100) * c} />
      </svg>
      <div className={`absolute inset-0 grid place-items-center font-semibold tracking-tight ${colour.text} ${size > 60 ? "text-xl" : "text-sm"}`} aria-hidden="true">
        {score === null ? "–" : `${score}%`}
      </div>
    </div>
  );
}

/** The next action for a match, always exactly one primary button. */
type CardAction = MatchAction | "queued";

function PrimaryAction({ action, onPrepare, disabled, block, stage }: { action: CardAction; onPrepare: () => void; disabled: boolean; block?: boolean; stage?: string | null }) {
  const base = `inline-flex min-h-10 items-center justify-center whitespace-nowrap rounded-lg px-4 py-2 text-sm font-semibold transition ${block ? "w-full" : ""}`;
  switch (action) {
    case "prepare":
      return (
        <button onClick={onPrepare} disabled={disabled} className={`${base} bg-indigo-600 text-white shadow-sm hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50`}>
          Prepare Application
        </button>
      );
    case "queued":
      return (
        <span className={`${base} cursor-default bg-slate-100 text-slate-700 ring-1 ring-inset ring-slate-300`}>Queued</span>
      );
    case "preparing":
      return (
        <span className={`${base} cursor-default bg-sky-50 text-sky-800 ring-1 ring-inset ring-sky-600/20`} title={stage ?? undefined}>
          <span className="mr-2 h-2 w-2 animate-pulse rounded-full bg-sky-500" aria-hidden="true" />Preparing…
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

function ViewJob({ url, block, subtle }: { url: string | null; block?: boolean; subtle?: boolean }) {
  if (!url) return null;
  return (
    <a
      href={url} target="_blank" rel="noopener noreferrer"
      className={`inline-flex min-h-10 items-center justify-center whitespace-nowrap rounded-lg px-4 py-2 text-sm font-semibold ${subtle ? "text-slate-700 hover:bg-slate-100" : "text-slate-800 ring-1 ring-inset ring-slate-300 hover:bg-slate-50"} ${block ? "w-full" : ""}`}
    >
      View Job <span aria-hidden="true" className="ml-1">↗</span>
      <span className="sr-only">(opens the job advert in a new tab)</span>
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
    <dl className="grid grid-cols-2 gap-x-6 gap-y-3">
      {rows.filter(([, v]) => v !== null).map(([label, value]) => (
        <div key={label}>
          <dt className="flex justify-between text-sm text-slate-600"><span>{label}</span><span className="font-semibold text-slate-800">{value}</span></dt>
          <dd className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-200/70"><div className="h-full rounded-full bg-indigo-500" style={{ width: `${value}%` }} /></dd>
        </div>
      ))}
    </dl>
  );
}

/** Why a job fits: only the stored match explanation (strengths, reason, gaps). */
function WhyDetails({ match, compact }: { match: DashboardMatch; compact?: boolean }) {
  const hasAny = match.strengths.length > 0 || match.reason || match.missingSkills.length > 0;
  if (!hasAny) return <p className="text-sm text-slate-600">No detailed explanation was saved for this match.</p>;
  return (
    <div className="space-y-4">
      {match.strengths.length > 0 && (
        <div>
          <h4 className="text-sm font-semibold text-slate-900">Why this job fits you</h4>
          <ul className="mt-2 flex flex-wrap gap-2">
            {match.strengths.map((s) => (
              <li key={s} className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-50 px-2.5 py-1 text-sm font-medium text-emerald-900">
                <span aria-hidden="true">✓</span>{s}
              </li>
            ))}
          </ul>
        </div>
      )}
      {match.reason && (
        <div>
          <h4 className="text-sm font-semibold text-slate-900">{match.strengths.length ? "Your advantage" : "Why this job fits you"}</h4>
          <p className={`mt-1 text-sm leading-relaxed text-slate-700 ${compact ? "max-w-3xl" : ""}`}>{match.reason}</p>
        </div>
      )}
      {match.missingSkills.length > 0 && (
        <div>
          <h4 className="text-sm font-semibold text-slate-900">Potential gap</h4>
          <p className="mt-1 text-sm text-slate-700">
            The advert also asks for <span className="font-semibold text-amber-900">{match.missingSkills.slice(0, 3).join(", ")}</span>
            {match.missingSkills.length > 3 ? ` and ${match.missingSkills.length - 3} more` : ""}.
          </p>
        </div>
      )}
    </div>
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
    <div className="mt-8 animate-pulse space-y-6" aria-busy="true">
      <p className="sr-only" role="status">Loading your dashboard…</p>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => <div key={i} className={`h-24 ${CARD}`} />)}
      </div>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem] 2xl:grid-cols-[minmax(0,1fr)_26rem]">
        <div className={`h-72 ${CARD}`} />
        <div className={`h-72 ${CARD}`} />
      </div>
      {[0, 1, 2].map((i) => <div key={i} className={`h-20 ${CARD}`} />)}
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
  const [batchNotice, setBatchNotice] = useState<string | null>(null);
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
      // Arriving at /#search, /#jobs or /#preparation: the browser jumped there
      // before the dashboard loaded, so scroll again once it has rendered.
      const section = window.location.hash.slice(1);
      if (["search", "jobs", "preparation"].includes(section)) {
        requestAnimationFrame(() => requestAnimationFrame(() => document.getElementById(section)?.scrollIntoView({ block: "start" })));
      }
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
    setBatchNotice(`${ids.length === 1 ? "1 application was" : `${ids.length} applications were`} added. Your applications are being prepared — you can keep browsing or leave this page.`);
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
  const freshIds = useMemo(() => new Set(fresh.map((m) => m.matchId)), [fresh]);
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
  const strong = dashboard?.strongMatchScore ?? 70;
  const progress = stats ? progressGroups(stats.applicationsByStatus) : [];
  const greeting = hour === null ? "Welcome back" : greetingFor(hour);
  const lastSearched = timeAgo(dashboard?.agent.lastDiscoveryAt);
  const searchTerms = dashboard?.search.terms ?? [];
  const inProgress = prep ? prep.summary.preparing + prep.summary.queued : stats?.preparing ?? 0;
  const awaitingResponse = stats ? (stats.applicationsByStatus.submitted ?? 0) + (stats.applicationsByStatus.acknowledged ?? 0) : 0;
  const step = dashboard && stats
    ? nextStep({
        hasProfile: dashboard.hasProfile,
        matches: matches.length,
        strongToExplore: matches.filter((m) => m.score !== null && m.score >= strong && actionFor(m) === "prepare").length,
        needsReview: stats.needsReview,
        readyToApply: stats.readyToApply,
        preparing: inProgress,
        applied: stats.submitted,
        awaitingResponse,
      })
    : null;
  const awayText = lastVisit === null
    ? null
    : awayMessage({
        newMatches: fresh.length,
        newStrong: fresh.filter((m) => m.score !== null && m.score >= strong).length,
        finished: away?.finished ?? 0,
        processing: away?.processing ?? 0,
        attention: away?.attention ?? 0,
      });

  return (
    <section aria-labelledby="command-centre-heading">
      {/* ── Hero: greeting, agent status and the one next step ───────────── */}
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(22rem,30rem)] lg:items-end">
        <div>
          <h1 id="command-centre-heading" className="text-3xl font-semibold tracking-tight text-slate-900 sm:text-4xl">
            {greeting}{dashboard?.firstName ? `, ${dashboard.firstName}` : ""}.
          </h1>
          <p className="mt-1.5 text-lg text-slate-600">Let&rsquo;s find your next move.</p>
          {dashboard && (
            <p className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-slate-600">
              <span className="inline-flex items-center gap-1.5 font-medium text-slate-800">
                <span className={`h-2 w-2 rounded-full ${inProgress > 0 ? "animate-pulse bg-sky-500" : "bg-emerald-500"}`} aria-hidden="true" />
                {inProgress > 0 ? `Your agent is preparing ${inProgress === 1 ? "an application" : `${inProgress} applications`}` : "Your agent is ready"}
              </span>
              {lastSearched && <span>· last searched {lastSearched}</span>}
              {stats && <span>· {stats.discoveredJobs} jobs checked · {stats.scoredMatches} matched to you</span>}
            </p>
          )}
        </div>
        {step && (
          <div className="rounded-2xl bg-slate-900 p-5 text-white shadow-sm" role="region" aria-label="Your next step">
            <p className="text-xs font-semibold uppercase tracking-wider text-indigo-200">Your next step</p>
            <p className="mt-1.5 text-lg font-semibold leading-snug">{step.title}</p>
            {step.detail && <p className="mt-1 text-sm text-slate-300">{step.detail}</p>}
            <Link href={step.action.href} className="mt-4 inline-flex min-h-10 items-center rounded-lg bg-white px-4 py-2 text-sm font-semibold text-slate-900 hover:bg-indigo-50">
              {step.action.label} <span aria-hidden="true" className="ml-1.5">→</span>
            </Link>
          </div>
        )}
      </div>

      {/* ── Search your matches + find new jobs ──────────────────────────── */}
      <div className={`mt-6 p-4 sm:p-5 ${CARD}`}>
        <div className="flex flex-col gap-3 md:flex-row md:items-center">
          <label className="relative flex-1">
            <span className="sr-only">Search your matches</span>
            <svg viewBox="0 0 24 24" className="pointer-events-none absolute left-3.5 top-1/2 h-5 w-5 -translate-y-1/2 text-slate-500" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search your matches: title, company, skill"
              className="min-h-12 w-full rounded-xl border-0 bg-slate-50 py-3 pl-11 pr-3 text-base text-slate-900 ring-1 ring-inset ring-slate-200 placeholder:text-slate-500 focus:bg-white focus:ring-2 focus:ring-indigo-500"
            />
          </label>
          <a href="#search" className="inline-flex min-h-12 items-center justify-center rounded-xl bg-indigo-600 px-6 text-sm font-semibold text-white shadow-sm hover:bg-indigo-500">
            Find new jobs
          </a>
        </div>
        {dashboard && (
          <div className="mt-3 flex flex-col gap-1 text-sm text-slate-600 md:flex-row md:items-center md:justify-between">
            <p>
              Looking for <span className="font-medium text-slate-800">{searchTerms.slice(0, 2).join(" · ")}{searchTerms.length > 2 ? ` · +${searchTerms.length - 2} more` : ""}</span> in{" "}
              <span className="font-medium text-slate-800">{dashboard.search.location}</span>
              {dashboard.search.usingPreferences ? "" : " (default search)"} ·{" "}
              <Link href="/preferences" className="font-medium text-indigo-700 underline-offset-2 hover:underline">Edit preferences</Link>
            </p>
            <p className="text-slate-500">Your agent searches several job sites for you.</p>
          </div>
        )}
      </div>

      {loading && !dashboard ? (
        <Skeleton />
      ) : error && !dashboard ? (
        <div className={`mt-8 p-8 text-center ${CARD}`} role="alert">
          <p className="font-medium text-rose-800">{error}</p>
          <button onClick={reload} className="mt-4 min-h-10 rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700">Try again</button>
        </div>
      ) : dashboard && stats ? (
        <>
          {error && <p className="mt-4 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-900 ring-1 ring-inset ring-rose-600/20" role="alert">{error}</p>}

          {/* ── Job-hunt summary (secondary to the jobs themselves) ──────── */}
          {dashboard.hasProfile && (
            <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
              <SummaryTile
                href="#jobs"
                label="Strong matches"
                value={stats.strongMatches}
                detail={stats.strongToday > 0 ? `${stats.strongToday} new today · ${strong}%+` : `scored ${strong}% or higher`}
                accent="text-emerald-700"
              />
              <SummaryTile href="/review" label="Ready for review" value={stats.needsReview} detail={stats.needsReview > 0 ? "Waiting for your review →" : "nothing waiting"} accent="text-violet-700" />
              <SummaryTile
                href="#preparation"
                label="Being prepared"
                value={inProgress}
                detail={prep && prep.summary.queued > 0 ? `${prep.summary.preparing} now · ${prep.summary.queued} queued` : inProgress > 0 ? "in the background" : "nothing in progress"}
                accent="text-sky-700"
                live={inProgress > 0}
              />
              <SummaryTile
                href="/applications"
                label="Applied"
                value={stats.submitted}
                detail={stats.readyToApply > 0 ? `${stats.readyToApply} Ready to apply →` : awaitingResponse > 0 ? `${awaitingResponse} awaiting a response` : "jobs you've applied to"}
                accent="text-slate-900"
              />
            </div>
          )}

          {/* ── While you were away (only with real activity since the last visit) ── */}
          {awayText && (
            <div className="mt-6 flex flex-col gap-2 rounded-2xl bg-indigo-50 px-5 py-4 ring-1 ring-inset ring-indigo-200 sm:flex-row sm:items-center sm:justify-between" role="status">
              <div>
                <p className="text-sm font-semibold text-indigo-950">While you were away</p>
                <p className="mt-0.5 text-sm text-indigo-900">{awayText}</p>
              </div>
              <div className="flex shrink-0 gap-2">
                {fresh.length > 0 && <a href="#jobs" onClick={() => setView("all")} className="inline-flex min-h-10 items-center rounded-lg bg-white px-3.5 text-sm font-semibold text-indigo-800 ring-1 ring-inset ring-indigo-200 hover:bg-indigo-100">New since your last visit</a>}
                {(away?.finished ?? 0) > 0 && <Link href="/review" className="inline-flex min-h-10 items-center rounded-lg bg-indigo-600 px-3.5 text-sm font-semibold text-white hover:bg-indigo-500">Review applications</Link>}
              </div>
            </div>
          )}

          {/* ── Strongest opportunity + agent activity, side by side on desktop ── */}
          <div className="mt-6 grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_22rem] 2xl:grid-cols-[minmax(0,1fr)_27rem]">
            <div className="min-w-0">
              {!dashboard.hasProfile ? (
                <div className={`p-8 text-center sm:p-12 ${CARD}`}>
                  <p className="text-xl font-semibold text-slate-900">Let&rsquo;s get you matched.</p>
                  <p className="mx-auto mt-2 max-w-xl text-slate-600">No CV profile yet. Upload your CV and press <strong>Find Suitable Jobs</strong> — your agent searches for jobs and ranks each one against your experience.</p>
                  <a href="#search" className="mt-5 inline-flex min-h-11 items-center rounded-lg bg-indigo-600 px-5 text-sm font-semibold text-white hover:bg-indigo-500">Upload your CV</a>
                </div>
              ) : matches.length === 0 ? (
                <div className={`p-8 text-center sm:p-12 ${CARD}`}>
                  <p className="text-xl font-semibold text-slate-900">No scored matches yet.</p>
                  <p className="mx-auto mt-2 max-w-xl text-slate-600">Press <strong>Find Suitable Jobs</strong> below — it uses your <Link href="/preferences" className="font-medium text-indigo-700 hover:underline">search preferences</Link>.</p>
                  <a href="#search" className="mt-5 inline-flex min-h-11 items-center rounded-lg bg-indigo-600 px-5 text-sm font-semibold text-white hover:bg-indigo-500">Find jobs</a>
                </div>
              ) : featured ? (
                <FeaturedCard
                  match={featured}
                  action={actionOf(featured)}
                  strong={strong}
                  onPrepare={() => prepare(featured)}
                  prepItem={prepItemOf(featured)}
                  notice={notice?.matchId === featured.matchId ? notice : null}
                  isNew={freshIds.has(featured.matchId)}
                />
              ) : (
                <div className={`p-6 text-slate-700 ${CARD}`}>
                  You&rsquo;ve acted on all of your current matches. <a href="#search" className="font-medium text-indigo-700 hover:underline">Find new jobs</a> to keep going.
                </div>
              )}
            </div>

            <aside className="min-w-0 space-y-6" aria-label="Your agent's activity">
              {prep && prep.items.length > 0 ? (
                <PreparationPanel status={prep} onRetry={retry} notice={batchNotice} />
              ) : progress.length === 0 ? (
                <HowItWorks />
              ) : null}
              {progress.length > 0 && !(prep && prep.items.length > 0) && (
                <div className={`p-5 ${CARD}`}>
                  <h2 className="text-base font-semibold text-slate-900">Your progress</h2>
                  <ul className="mt-3 space-y-1" aria-label="Your application progress">
                    {progress.map((g) => (
                      <li key={g.key}>
                        <Link href={g.key === "review" ? "/review" : "/applications"} className="flex min-h-10 items-center justify-between rounded-lg px-2 text-sm text-slate-700 hover:bg-slate-50">
                          <span>{g.label}</span>
                          <Pill tone={g.tone}>{g.count}</Pill>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </aside>
          </div>

          {/* ── Your opportunities ───────────────────────────────────────── */}
          {matches.length > 0 && (
            <div id="jobs" className="mt-10 scroll-mt-20">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
                <div>
                  <h2 className="text-xl font-semibold tracking-tight text-slate-900 sm:text-2xl">Your opportunities</h2>
                  <p className="mt-0.5 text-sm text-slate-600">
                    {feed.length} {feed.length === 1 ? "job" : "jobs"} ranked against your CV. Tick several to prepare them together.
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0 sm:pb-0" role="tablist" aria-label="Filter your opportunities">
                    {FEED_VIEWS.map((v) => (
                      <button
                        key={v.key}
                        role="tab"
                        aria-selected={view === v.key}
                        onClick={() => setView(v.key)}
                        className={`min-h-10 shrink-0 rounded-full px-4 text-sm font-medium ring-1 ring-inset transition ${view === v.key ? "bg-slate-900 text-white ring-slate-900" : "bg-white text-slate-700 ring-slate-300 hover:bg-slate-50"}`}
                      >
                        {v.label}
                      </button>
                    ))}
                  </div>
                  <button onClick={reload} disabled={loading} className="hidden min-h-10 shrink-0 rounded-lg px-3 text-sm font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900 disabled:opacity-50 sm:inline-flex sm:items-center">
                    {loading ? "Refreshing…" : "↻ Refresh"}
                  </button>
                </div>
              </div>

              {feed.length === 0 ? (
                <p className={`mt-4 p-6 text-center text-sm text-slate-600 ${CARD}`}>
                  No opportunities match {query ? <>&ldquo;{query}&rdquo;</> : "this filter"}.
                </p>
              ) : (
                <ul className={`mt-4 divide-y divide-slate-100 overflow-hidden ${CARD}`}>
                  {feed.map((match) => (
                    <FeedRow
                      key={match.matchId}
                      match={match}
                      action={actionOf(match)}
                      strong={strong}
                      onPrepare={() => prepare(match)}
                      prepItem={prepItemOf(match)}
                      selected={selected.has(match.matchId)}
                      onToggle={() => toggle(match.matchId)}
                      notice={notice?.matchId === match.matchId ? notice : null}
                      isNew={freshIds.has(match.matchId)}
                    />
                  ))}
                </ul>
              )}
            </div>
          )}
          {selected.size > 0 && (
            <div className="sticky bottom-20 z-30 mt-4 flex flex-col gap-3 rounded-2xl bg-slate-900 px-4 py-3 text-white shadow-lg sm:flex-row sm:items-center sm:justify-between md:bottom-4" role="region" aria-label="Selected jobs">
              <p className="text-sm"><span className="font-semibold">{selected.size}</span> {selected.size === 1 ? "job" : "jobs"} selected — your agent will prepare them one after another.</p>
              <div className="flex gap-2">
                <button onClick={() => setSelected(new Set())} className="min-h-10 rounded-lg px-3 text-sm font-medium text-slate-300 hover:text-white">Clear</button>
                <button onClick={prepareSelected} disabled={batchBusy} className="min-h-10 flex-1 rounded-lg bg-indigo-500 px-4 text-sm font-semibold text-white hover:bg-indigo-400 disabled:opacity-60 sm:flex-none">
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

function SummaryTile({ href, label, value, detail, accent, live }: { href: string; label: string; value: number; detail: string; accent: string; live?: boolean }) {
  const inner = (
    <>
      <p className="flex items-center gap-1.5 text-sm font-medium text-slate-600">
        {live && <span className="h-2 w-2 animate-pulse rounded-full bg-sky-500" aria-hidden="true" />}
        {label}
      </p>
      <p className={`mt-1 text-3xl font-semibold tracking-tight ${value > 0 ? accent : "text-slate-400"}`}>{value}</p>
      <p className="mt-0.5 truncate text-sm text-slate-600">{detail}</p>
    </>
  );
  const cls = `block p-4 transition hover:ring-indigo-300 sm:p-5 ${CARD}`;
  return href.startsWith("#") ? <a href={href} className={cls}>{inner}</a> : <Link href={href} className={cls}>{inner}</Link>;
}

/** For people with no applications yet: what the agent does, in four plain steps. */
function HowItWorks() {
  const steps = [
    ["Find", "Your agent searches job sites and ranks every job against your CV."],
    ["Prepare", "Pick the jobs you like. Your agent tailors your CV and writes a cover letter."],
    ["Review", "Check and edit each application. Nothing is sent without you."],
    ["Apply", "Apply on the employer's site yourself, then track the response here."],
  ];
  return (
    <div className={`p-5 ${CARD}`}>
      <h2 className="text-base font-semibold text-slate-900">How your agent helps</h2>
      <ol className="mt-3 space-y-3">
        {steps.map(([title, text], i) => (
          <li key={title} className="flex gap-3">
            <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-indigo-50 text-sm font-semibold text-indigo-700" aria-hidden="true">{i + 1}</span>
            <p className="text-sm text-slate-700"><span className="font-semibold text-slate-900">{title}.</span> {text}</p>
          </li>
        ))}
      </ol>
    </div>
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
  isNew?: boolean;
};

function FeaturedCard({ match, action, strong, onPrepare, notice, prepItem, isNew }: CardProps) {
  const salary = formatSalary(match.salaryMin, match.salaryMax, match.salaryIsPredicted);
  const arrangement = workArrangement(match.contractTime, match.contractType);
  const source = sourceLabel(match.sources);
  const status = statusInfo(match.application?.status);
  const found = timeAgo(match.firstSeenAt);
  return (
    <article className={`overflow-hidden ${CARD}`} aria-labelledby="featured-title">
      <div className="h-1 bg-gradient-to-r from-indigo-500 via-violet-500 to-emerald-400" aria-hidden="true" />
      <div className="p-5 sm:p-7">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-xs font-semibold uppercase tracking-wider text-indigo-700">Your strongest opportunity</p>
          {isNew && <Pill tone="blue">New</Pill>}
          {status && <Pill tone={status.tone}>{status.label}</Pill>}
        </div>
        <div className="mt-4 flex gap-4 sm:gap-6">
          <div className="flex flex-col items-center gap-1.5">
            <ScoreRing score={match.score} size={84} />
            <span className={`text-center text-sm font-semibold ${scoreColour(match.score).text}`}>{matchQuality(match.score, strong)}</span>
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="featured-title" className="text-xl font-semibold leading-snug tracking-tight text-slate-900 sm:text-2xl">{match.title}</h2>
            <p className="mt-1 text-slate-700">
              <span className="font-medium text-slate-900">{match.company}</span>
              {match.location && <> · {match.location}</>}
            </p>
            <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm text-slate-600">
              {salary && <span className="font-semibold text-slate-800">{salary}</span>}
              {arrangement && <span>{arrangement}</span>}
              {source && <span>via {source}</span>}
              {found && <span>found {found}</span>}
            </div>
          </div>
        </div>

        <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1.5fr)_minmax(16rem,1fr)]">
          <WhyDetails match={match} />
          {match.breakdown && (
            <div className="self-start rounded-xl bg-slate-50 p-4 ring-1 ring-inset ring-slate-200/70">
              <h3 className="mb-3 text-sm font-semibold text-slate-900">How you match</h3>
              <Breakdown breakdown={match.breakdown} />
            </div>
          )}
        </div>

        {prepItem && (prepItem.state === "preparing" || prepItem.state === "queued") && (
          <div className="mt-6 rounded-xl bg-sky-50/70 p-4 ring-1 ring-inset ring-sky-100">
            <p className="text-sm font-semibold text-slate-900">{prepItem.state === "queued" ? "Queued for preparation" : "Preparing application"}</p>
            <Steps item={prepItem} />
          </div>
        )}

        <div className="mt-6 flex flex-col gap-2 sm:flex-row">
          <div className="sm:w-64"><PrimaryAction action={action} onPrepare={onPrepare} disabled={false} block stage={prepItem?.currentStage} /></div>
          <div className="sm:w-44"><ViewJob url={match.url} block /></div>
        </div>
        <NoticeLine notice={notice} />
      </div>
    </article>
  );
}

function FeedRow({ match, action, strong, onPrepare, notice, prepItem, selected, onToggle, isNew }: CardProps) {
  const [open, setOpen] = useState(false);
  const salary = formatSalary(match.salaryMin, match.salaryMax, match.salaryIsPredicted);
  const status = statusInfo(match.application?.status);
  const detailsId = `why-${match.matchId}`;
  const preparing = prepItem && (prepItem.state === "preparing" || prepItem.state === "queued");
  const whyButton = (
    <button
      onClick={() => setOpen((v) => !v)}
      aria-expanded={open}
      aria-controls={detailsId}
      className="inline-flex min-h-10 items-center justify-center whitespace-nowrap rounded-lg px-3 text-sm font-medium text-slate-700 ring-1 ring-inset ring-slate-200 hover:bg-slate-100 sm:ring-0"
    >
      Why?
      <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" className={`ml-1 h-4 w-4 transition-transform ${open ? "rotate-180" : ""}`}><path fillRule="evenodd" d="M5.2 7.2a.75.75 0 0 1 1.06.04L10 11.2l3.74-3.96a.75.75 0 1 1 1.09 1.03l-4.28 4.53a.75.75 0 0 1-1.09 0L5.17 8.27a.75.75 0 0 1 .04-1.06z" clipRule="evenodd" /></svg>
      <span className="sr-only">{open ? "Hide" : "Show"} why this job fits you</span>
    </button>
  );
  return (
    <li className={selected ? "bg-indigo-50/50" : ""}>
      <div className="flex items-start gap-3 px-4 py-4 sm:px-5 lg:items-center lg:gap-5">
        {action === "prepare" && onToggle ? (
          <label className="-m-2 flex shrink-0 cursor-pointer items-center p-2 pt-5 lg:pt-2">
            <input type="checkbox" checked={Boolean(selected)} onChange={onToggle} aria-label={`Select ${match.title}`} className="h-5 w-5 rounded accent-indigo-600" />
          </label>
        ) : (
          <span className="w-5 shrink-0" aria-hidden="true" />
        )}
        <div className="flex w-[4.5rem] shrink-0 flex-col items-center gap-1">
          <ScoreRing score={match.score} size={52} />
          <span className={`text-center text-xs font-semibold leading-tight ${scoreColour(match.score).text}`}>{matchQuality(match.score, strong)}</span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="font-semibold leading-snug text-slate-900">{match.title}</h3>
            {isNew && <Pill tone="blue">New</Pill>}
            {status && <Pill tone={status.tone}>{status.label}</Pill>}
          </div>
          <p className="mt-0.5 text-sm text-slate-600">
            <span className="font-medium text-slate-800">{match.company}</span>
            {match.location && <> · {match.location}</>}
            {salary && <> · <span className="font-medium text-slate-800">{salary}</span></>}
          </p>
          {preparing && <p className="mt-1 text-sm font-medium text-sky-800">{progressLine(prepItem)}</p>}
          {match.strengths.length > 0 && (
            <ul className="mt-2 hidden flex-wrap gap-1.5 sm:flex xl:hidden" aria-label="Matching skills">
              {match.strengths.slice(0, 4).map((s) => (
                <li key={s} className="rounded-md bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">{s}</li>
              ))}
            </ul>
          )}
        </div>
        {match.strengths.length > 0 && (
          <ul className="hidden w-72 shrink-0 flex-wrap gap-1.5 xl:flex 2xl:w-96" aria-label="Matching skills">
            {match.strengths.slice(0, 5).map((s) => (
              <li key={s} className="rounded-md bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">{s}</li>
            ))}
          </ul>
        )}
        <div className="hidden shrink-0 items-center gap-1 sm:flex">
          {whyButton}
          <ViewJob url={match.url} subtle />
          <div className="ml-1 w-48"><PrimaryAction action={action} onPrepare={onPrepare} disabled={false} block stage={prepItem?.currentStage} /></div>
        </div>
      </div>
      {/* Mobile: actions on their own row, full size */}
      <div className="grid grid-cols-2 gap-2 px-4 pb-4 sm:hidden">
        <div className="col-span-2"><PrimaryAction action={action} onPrepare={onPrepare} disabled={false} block stage={prepItem?.currentStage} /></div>
        {whyButton}
        <ViewJob url={match.url} block />
      </div>
      {open && (
        <div id={detailsId} className="mx-4 mb-4 rounded-xl bg-slate-50 p-4 ring-1 ring-inset ring-slate-200/70 sm:mx-5 sm:ml-[8.75rem]">
          <div className="grid gap-5 lg:grid-cols-[minmax(0,1.5fr)_minmax(14rem,1fr)]">
            <WhyDetails match={match} compact />
            {match.breakdown && (
              <div>
                <h4 className="mb-3 text-sm font-semibold text-slate-900">How you match</h4>
                <Breakdown breakdown={match.breakdown} />
              </div>
            )}
          </div>
        </div>
      )}
      {preparing && open && (
        <div className="mx-4 mb-4 sm:mx-5 sm:ml-[8.75rem]"><Steps item={prepItem} /></div>
      )}
      {notice && <div className="px-4 pb-4 sm:px-5"><NoticeLine notice={notice} /></div>}
    </li>
  );
}

const STEP_ICON: Record<string, { icon: string; className: string }> = {
  done: { icon: "✓", className: "text-emerald-600" },
  running: { icon: "●", className: "animate-pulse text-sky-500" },
  pending: { icon: "○", className: "text-slate-400" },
  failed: { icon: "✕", className: "text-rose-600" },
};

const STEP_WORD: Record<string, string> = { done: "done", running: "in progress", pending: "waiting", failed: "failed" };

function Steps({ item, single }: { item: PreparationItem; single?: boolean }) {
  return (
    <ol className={`mt-2 grid gap-1 text-sm ${single ? "" : "sm:grid-cols-2"}`}>
      {stepsFor(item).map((step) => (
        <li key={step.label} className={`flex items-center gap-2 ${step.state === "pending" ? "text-slate-500" : step.state === "running" ? "font-medium text-slate-900" : "text-slate-700"}`}>
          <span className={`w-4 text-center ${STEP_ICON[step.state]?.className ?? ""}`} aria-hidden="true">{STEP_ICON[step.state]?.icon ?? "○"}</span>
          {step.label}
          <span className="sr-only">({STEP_WORD[step.state] ?? step.state})</span>
        </li>
      ))}
    </ol>
  );
}

/** The live preparation queue: counts and each job's progress. */
function PreparationPanel({ status, onRetry, notice }: { status: PreparationStatus; onRetry: (item: PreparationItem) => void; notice: string | null }) {
  const { summary } = status;
  const active = hasActiveWork(status);
  const [showAll, setShowAll] = useState(false);
  const items = [...status.items].sort((a, b) => {
    const order: Record<string, number> = { preparing: 0, queued: 1, failed: 2, ready: 3 };
    return (order[a.state] ?? 9) - (order[b.state] ?? 9) || a.applicationId - b.applicationId;
  });
  const visible = showAll ? items : items.slice(0, 6);
  return (
    <section id="preparation" className={`scroll-mt-20 p-5 ${CARD}`} aria-label="Application preparation">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-slate-900">Application preparation</h2>
          <p className="mt-0.5 text-sm text-slate-600">
            {active ? "Your applications are being prepared. Your agent keeps working even if you leave this page." : "Your agent has finished preparing."}
          </p>
        </div>
        {active && <span className="mt-1.5 h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-sky-500" aria-hidden="true" />}
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {summary.ready > 0 && <Pill tone="violet">{summary.ready} ready for review</Pill>}
        {summary.preparing > 0 && <Pill tone="blue">{summary.preparing} preparing</Pill>}
        {summary.queued > 0 && <Pill tone="gray">{summary.queued} queued</Pill>}
        {summary.failed > 0 && <Pill tone="red">{summary.failed} failed</Pill>}
      </div>
      {notice && active && <p className="mt-3 rounded-lg bg-sky-50 px-3 py-2 text-sm text-sky-900 ring-1 ring-inset ring-sky-600/20" role="status">{notice}</p>}
      <ul className="mt-3 divide-y divide-slate-100">
        {visible.map((item) =>
          item.state === "ready" && !needsAttention(item) ? (
            <li key={item.applicationId} className="flex items-center gap-2.5 py-2.5">
              <span className="w-4 shrink-0 text-center text-sm text-emerald-600" aria-hidden="true">✓</span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-slate-900">{item.title}</p>
                <p className="truncate text-sm text-slate-600">{item.company}<span className="sr-only"> · Ready for review</span></p>
              </div>
              <Link href="/review" className="inline-flex min-h-9 shrink-0 items-center rounded-lg px-3 text-sm font-semibold text-violet-700 ring-1 ring-inset ring-violet-200 hover:bg-violet-50">
                Review<span className="sr-only"> the application for {item.title}</span>
              </Link>
            </li>
          ) : (
            <li key={item.applicationId} className="py-3">
              <div className="flex items-start gap-2.5">
                <span
                  className={`mt-0.5 w-4 shrink-0 text-center text-sm ${needsAttention(item) ? "text-rose-600" : item.state === "preparing" ? "animate-pulse text-sky-500" : "text-slate-400"}`}
                  aria-hidden="true"
                >
                  {needsAttention(item) ? "!" : item.state === "preparing" ? "●" : "○"}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold leading-snug text-slate-900">{item.title}</p>
                  <p className="truncate text-sm text-slate-600">{item.company}</p>
                  <p className={`mt-0.5 text-sm ${needsAttention(item) ? "font-medium text-rose-800" : item.state === "preparing" ? "font-medium text-sky-800" : "text-slate-600"}`}>
                    {progressLine(item)}
                  </p>
                  {item.state === "preparing" && <Steps item={item} single />}
                  {needsAttention(item) && (
                    <div className="mt-2 flex gap-2">
                      {item.matchId !== null && (
                        <button onClick={() => onRetry(item)} className="min-h-9 rounded-lg px-3 text-sm font-semibold text-rose-800 ring-1 ring-inset ring-rose-300 hover:bg-rose-50">Retry</button>
                      )}
                      {item.state === "ready" && (
                        <Link href="/review" className="inline-flex min-h-9 items-center rounded-lg bg-violet-600 px-3 text-sm font-semibold text-white hover:bg-violet-500">Review Application</Link>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </li>
          )
        )}
      </ul>
      {items.length > 6 && (
        <button onClick={() => setShowAll((v) => !v)} className="mt-1 min-h-9 text-sm font-medium text-indigo-700 hover:underline">
          {showAll ? "Show fewer" : `Show all ${items.length}`}
        </button>
      )}
    </section>
  );
}
