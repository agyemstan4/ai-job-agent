"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { Dashboard, DashboardMatch } from "@/lib/pipeline/dashboard";
import { actionFor, formatSalary, loadDashboard, requestPreparation, scoreBadge } from "@/lib/dashboard-client";
import type { LoadResult } from "@/lib/dashboard-client";

// The Command Centre (Phase 3 checkpoint 3c): stats and the strongest
// current matches, from real data. "Prepare Application" prepares ONE job on
// the server (a draft for review — nothing is approved, submitted or sent).
// "View Job" only opens the job advert.

type Notice = { kind: "success" | "error" | "info"; text: string; matchId: number };

const NOTICE_STYLES: Record<Notice["kind"], string> = {
  success: "border-emerald-200 bg-emerald-50 text-emerald-800",
  error: "border-red-200 bg-red-50 text-red-800",
  info: "border-blue-200 bg-blue-50 text-blue-800",
};

function Stat({ label, value, href, accent }: { label: string; value: number; href?: string; accent: string }) {
  const body = (
    <div className={`rounded-xl border-l-4 ${accent} bg-white p-4 shadow-sm`}>
      <div className="text-3xl font-bold text-gray-900">{value}</div>
      <div className="mt-1 text-sm text-gray-600">{label}</div>
    </div>
  );
  return href ? <Link href={href} className="block hover:opacity-90">{body}</Link> : body;
}

export default function CommandCentre() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [preparingId, setPreparingId] = useState<number | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

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
    loadDashboard().then((result) => {
      if (!cancelled) apply(result);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function reload() {
    setLoading(true);
    apply(await loadDashboard());
  }

  async function prepare(match: DashboardMatch) {
    setPreparingId(match.matchId);
    setNotice({ kind: "info", matchId: match.matchId, text: `Preparing "${match.title}" — tailored CV, CV file and cover letter. This takes several minutes; keep this tab open.` });
    const result = await requestPreparation(match.matchId);
    if (result.kind === "prepared") {
      setNotice({
        kind: "success",
        matchId: match.matchId,
        text: `Prepared — ready for your review.${result.warnings.length ? ` Note: ${result.warnings.join("; ")}` : ""}`,
      });
    } else if (result.kind === "exists") {
      setNotice({ kind: "info", matchId: match.matchId, text: "This job already has an application; nothing was prepared again." });
    } else {
      setNotice({ kind: "error", matchId: match.matchId, text: result.message });
    }
    setPreparingId(null);
    apply(await loadDashboard());
  }

  const stats = dashboard?.stats;

  return (
    <section className="mt-6" aria-labelledby="command-centre-heading">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 id="command-centre-heading" className="text-2xl font-bold text-gray-900">Command Centre</h2>
          <p className="text-sm text-gray-600">Your strongest current matches. Preparing creates a draft for review; you always apply yourself.</p>
        </div>
        <button onClick={reload} disabled={loading} className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-semibold text-gray-800 hover:bg-gray-50 disabled:opacity-50">
          {loading ? "Refreshing…" : "↻ Refresh"}
        </button>
      </div>

      {loading && !dashboard ? (
        <div className="mt-4 rounded-xl bg-white p-8 text-center text-gray-500 shadow-sm">Loading your dashboard…</div>
      ) : error && !dashboard ? (
        <div className="mt-4 rounded-xl bg-white p-8 text-center shadow-sm" role="alert">
          <p className="text-red-700">{error}</p>
          <button onClick={reload} className="mt-4 rounded-lg bg-gray-800 px-4 py-2 font-semibold text-white hover:bg-gray-700">Try again</button>
        </div>
      ) : dashboard && stats ? (
        <>
          {error && <p className="mt-3 rounded-lg border border-red-200 bg-red-50 p-2 text-sm text-red-800" role="alert">{error}</p>}
          <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Jobs discovered" value={stats.discoveredJobs} accent="border-gray-400" />
            <Stat label={`Strong matches (${dashboard.strongMatchScore}+) of ${stats.scoredMatches} scored`} value={stats.strongMatches} accent="border-green-500" />
            <Stat label="Need your review" value={stats.needsReview} href="/review" accent="border-emerald-500" />
            <Stat label="Applied" value={stats.submitted} href="/applications" accent="border-blue-500" />
          </div>
          {(stats.preparing > 0 || stats.readyToApply > 0) && (
            <p className="mt-2 text-sm text-gray-600">
              {stats.preparing > 0 && <>{stats.preparing} being prepared. </>}
              {stats.readyToApply > 0 && <><Link href="/applications" className="font-semibold text-blue-700 hover:underline">{stats.readyToApply} approved and ready to apply</Link>.</>}
            </p>
          )}

          <h3 className="mt-6 text-lg font-semibold text-gray-900">Top matches</h3>
          {!dashboard.hasProfile ? (
            <div className="mt-2 rounded-xl bg-white p-6 text-center text-gray-600 shadow-sm">
              No CV profile yet. Upload your CV below and run <strong>Find Suitable Jobs</strong> to see your matches here.
            </div>
          ) : dashboard.topMatches.length === 0 ? (
            <div className="mt-2 rounded-xl bg-white p-6 text-center text-gray-600 shadow-sm">
              No scored matches yet. Run <strong>Find Suitable Jobs</strong> below (it uses your <Link href="/preferences" className="text-blue-700 hover:underline">search preferences</Link>).
            </div>
          ) : (
            <ol className="mt-2 space-y-3">
              {dashboard.topMatches.map((match, index) => {
                const badge = scoreBadge(match.score, dashboard.strongMatchScore);
                const salary = formatSalary(match.salaryMin, match.salaryMax, match.salaryIsPredicted);
                const action = preparingId === match.matchId ? "preparing" : actionFor(match);
                const busyElsewhere = preparingId !== null && preparingId !== match.matchId;
                return (
                  <li key={match.matchId} className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-semibold text-gray-400">#{index + 1}</span>
                          <span className={`rounded-full px-2.5 py-0.5 text-sm font-bold ${badge.className}`}>
                            {match.score ?? "–"} · {badge.label}
                          </span>
                          {match.application && <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-700">{match.application.status.replace(/_/g, " ")}</span>}
                        </div>
                        <h4 className="mt-1 truncate text-lg font-semibold text-gray-900" title={match.title}>{match.title}</h4>
                        <p className="text-sm text-gray-700">
                          {match.company}
                          {match.location && <> · 📍 {match.location}</>}
                          {salary && <> · 💷 {salary}</>}
                        </p>
                        {match.strengths.length > 0 && (
                          <div className="mt-2 flex flex-wrap gap-1">
                            {match.strengths.map((s) => (
                              <span key={s} className="rounded bg-emerald-50 px-2 py-0.5 text-xs text-emerald-800">✓ {s}</span>
                            ))}
                            {match.missingSkills.slice(0, 3).map((s) => (
                              <span key={s} className="rounded bg-amber-50 px-2 py-0.5 text-xs text-amber-800">△ {s}</span>
                            ))}
                          </div>
                        )}
                        {match.reason && <p className="mt-2 line-clamp-2 text-sm text-gray-600">{match.reason}</p>}
                      </div>
                      <div className="flex shrink-0 flex-wrap gap-2 sm:flex-col sm:items-stretch">
                        {match.url && (
                          <a href={match.url} target="_blank" rel="noopener noreferrer" className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-center text-sm font-semibold text-gray-800 hover:bg-gray-50">
                            View Job ↗
                          </a>
                        )}
                        {action === "prepare" && (
                          <button onClick={() => prepare(match)} disabled={busyElsewhere} className="rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50" title={busyElsewhere ? "One preparation at a time" : undefined}>
                            Prepare Application
                          </button>
                        )}
                        {action === "preparing" && (
                          <span className="rounded-lg bg-blue-100 px-3 py-2 text-center text-sm font-semibold text-blue-800">Preparing…</span>
                        )}
                        {action === "review" && (
                          <Link href="/review" className="rounded-lg bg-emerald-600 px-3 py-2 text-center text-sm font-semibold text-white hover:bg-emerald-700">Review Application</Link>
                        )}
                        {action === "apply" && (
                          <Link href="/applications" className="rounded-lg bg-blue-600 px-3 py-2 text-center text-sm font-semibold text-white hover:bg-blue-700">Ready to apply</Link>
                        )}
                        {action === "track" && (
                          <Link href="/applications" className="rounded-lg bg-gray-800 px-3 py-2 text-center text-sm font-semibold text-white hover:bg-gray-700">Track</Link>
                        )}
                      </div>
                    </div>
                    {notice?.matchId === match.matchId && (
                      <p className={`mt-3 rounded-lg border p-2 text-sm ${NOTICE_STYLES[notice.kind]}`} role={notice.kind === "error" ? "alert" : "status"}>
                        {notice.text}
                      </p>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
        </>
      ) : null}
    </section>
  );
}
