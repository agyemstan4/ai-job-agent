"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { actionFor, formatSalary, loadDashboard, matchQuality, statusInfo, workArrangement } from "@/lib/dashboard-client";
import type { DashboardMatch } from "@/lib/pipeline/dashboard";
import type { PreparationItem } from "@/lib/pipeline/preparation-queue";
import { loadPreparationStatus, progressLine, queuePreparation } from "@/lib/preparation-client";
import { markViewed } from "@/lib/daily-brief";
import {
  BenefitChips,
  OpportunityReasons,
  Pill,
  PreferenceFitList,
  PrimaryAction,
  ScoreRing,
  ViewJob,
  WhyDetails,
  scoreColour,
} from "@/app/components/CommandCentre";
import type { CardAction } from "@/app/components/CommandCentre";

// One opportunity, full view (Phase 4a) — opened from Today's "Review
// opportunity". Shows what the job offers, why it suits you and what to check,
// then the one next step: prepare an application (queued on the server), or
// review the prepared one. "View Job" only opens the advert; you always apply
// yourself.

const CARD = "rounded-2xl bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)] ring-1 ring-slate-200/80";

export default function OpportunityPage() {
  const params = useParams<{ id: string }>();
  const matchId = Number(params.id);
  const [match, setMatch] = useState<DashboardMatch | null>(null);
  const [prepItem, setPrepItem] = useState<PreparationItem | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "missing" | "error">("loading");
  const [message, setMessage] = useState<string | null>(null);

  const apply = useCallback((result: Awaited<ReturnType<typeof loadDashboard>>, prep: Awaited<ReturnType<typeof loadPreparationStatus>>) => {
    if (result.kind !== "loaded") {
      setState("error");
      setMessage(result.message);
      return;
    }
    const found = result.dashboard.topMatches.find((m) => m.matchId === matchId) ?? null;
    setMatch(found);
    setPrepItem(found?.application && prep.kind === "loaded" ? prep.status.items.find((i) => i.applicationId === found.application!.id) ?? null : null);
    setState(found ? "ready" : "missing");
  }, [matchId]);

  const load = useCallback(async () => {
    const [result, prep] = await Promise.all([loadDashboard(), loadPreparationStatus()]);
    apply(result, prep);
  }, [apply]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([loadDashboard(), loadPreparationStatus()]).then(([result, prep]) => {
      if (cancelled) return;
      apply(result, prep);
      try {
        markViewed(window.localStorage, matchId);
      } catch {
        // Not remembered without storage.
      }
    });
    return () => {
      cancelled = true;
    };
  }, [apply, matchId]);

  async function prepare() {
    if (!match) return;
    const result = await queuePreparation(match.matchId, {});
    setMessage(
      result.kind === "error"
        ? result.message
        : "Added to your preparation queue. Your agent keeps working in the background — you can leave this page."
    );
    await load();
  }

  const action: CardAction | null = match
    ? prepItem?.state === "queued"
      ? "queued"
      : prepItem?.state === "preparing"
        ? "preparing"
        : actionFor(match)
    : null;
  const salary = match ? formatSalary(match.salaryMin, match.salaryMax, match.salaryIsPredicted) : null;
  const arrangement = match ? workArrangement(match.contractTime, match.contractType) : null;
  const status = match ? statusInfo(match.application?.status) : null;

  return (
    <main className="w-full py-5 sm:py-8">
      <div className="app-shell max-w-3xl">
        <Link href="/today" className="inline-flex min-h-10 items-center text-sm font-medium text-slate-600 hover:text-slate-900">← Back to Today</Link>

        {state === "loading" ? (
          <div className={`mt-3 h-64 animate-pulse ${CARD}`} aria-busy="true"><p className="sr-only" role="status">Loading the opportunity…</p></div>
        ) : state === "error" ? (
          <div className={`mt-3 p-6 ${CARD}`} role="alert"><p className="font-medium text-rose-800">{message}</p></div>
        ) : state === "missing" || !match || !action ? (
          <div className={`mt-3 p-6 ${CARD}`}>
            <p className="text-lg font-semibold text-slate-900">This opportunity isn&rsquo;t in your current list.</p>
            <p className="mt-1 text-slate-600">It may have been replaced by newer matches.</p>
            <Link href="/today" className="mt-4 inline-flex min-h-11 items-center rounded-lg bg-indigo-600 px-5 text-sm font-semibold text-white">Back to Today</Link>
          </div>
        ) : (
          <article className={`mt-3 p-5 sm:p-7 ${CARD}`} aria-labelledby="opportunity-title">
            <div className="flex items-start gap-4">
              <div className="flex flex-col items-center gap-1">
                <ScoreRing score={match.score} size={64} />
                <span className={`text-center text-xs font-semibold ${scoreColour(match.score).text}`}>{matchQuality(match.score, 70)}</span>
              </div>
              <div className="min-w-0 flex-1">
                {status && <Pill tone={status.tone}>{status.label}</Pill>}
                <h1 id="opportunity-title" className="mt-1 text-2xl font-semibold leading-snug tracking-tight text-slate-900">{match.title}</h1>
                <p className="text-slate-700">{match.company}</p>
                <p className="mt-1 text-sm text-slate-600">
                  {[salary, match.location, arrangement].filter(Boolean).join(" · ") || "Salary and location not stated"}
                </p>
              </div>
            </div>
            <BenefitChips match={match} max={5} large />

            {prepItem && (prepItem.state === "queued" || prepItem.state === "preparing") && (
              <p className="mt-4 rounded-lg bg-sky-50 px-3 py-2 text-sm font-medium text-sky-900 ring-1 ring-inset ring-sky-600/20" role="status">{progressLine(prepItem)}</p>
            )}

            {/* The next step */}
            <div className="mt-5 flex flex-col gap-2 sm:flex-row">
              <div className="sm:flex-1"><PrimaryAction action={action} onPrepare={prepare} disabled={false} block stage={prepItem?.currentStage} /></div>
              <div className="sm:w-44"><ViewJob url={match.url} block /></div>
            </div>
            {message && <p className="mt-3 rounded-lg bg-sky-50 px-3 py-2 text-sm text-sky-900 ring-1 ring-inset ring-sky-600/20" role="status">{message}</p>}
            <p className="mt-2 text-xs text-slate-600">Nothing is ever submitted for you — you decide what to apply for and apply on the employer&rsquo;s site yourself.</p>

            {(match.standsOut.length > 0 || match.cautions.length > 0) && (
              <div className="mt-6 rounded-xl bg-emerald-50/50 p-4 ring-1 ring-inset ring-emerald-600/15">
                <OpportunityReasons match={match} title="Why this job stands out" showSummary />
              </div>
            )}
            {match.preferenceFit.length > 0 && (
              <div className="mt-5">
                <h2 className="text-sm font-semibold text-slate-900">Your benefit preferences</h2>
                <div className="mt-2"><PreferenceFitList match={match} /></div>
              </div>
            )}
            <div className="mt-6">
              <WhyDetails match={match} withPreferences={false} withReasons={false} />
            </div>
          </article>
        )}
      </div>
    </main>
  );
}
