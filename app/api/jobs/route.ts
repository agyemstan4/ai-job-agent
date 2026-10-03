import { NextResponse } from "next/server";
import db, { filterNewJobs } from "@/lib/db";
import { recordDiscovery } from "@/lib/pipeline/discovery";
import type { DiscoveredListing } from "@/lib/pipeline/discovery";
import { describeError } from "@/lib/log-safety";
import { applyDiscoveryFilter, preferencesForProfile, searchPlan } from "@/lib/pipeline/preferences";
import type { SearchPreferences } from "@/lib/pipeline/preferences";

export async function POST(req: Request) {
  try {
    const { role, location, candidateProfileId, triggeredBy } = await req.json();

    const appId = process.env.ADZUNA_APP_ID;
    const appKey = process.env.ADZUNA_APP_KEY;
    const reedKey = process.env.REED_API_KEY;

    if (!appId || !appKey) {
      return NextResponse.json(
        { error: "Adzuna API keys missing" },
        { status: 500 }
      );
    }

    let failedRequests = 0;

    // Search preferences (lib/pipeline/preferences.ts) of the candidate behind
    // the profile. None saved, no profile (the scheduler) or unreadable: the
    // previous fixed terms and the location sent in.
    let preferences: SearchPreferences | null = null;
    try {
      preferences = preferencesForProfile(db, candidateProfileId);
    } catch (error) {
      console.warn("Search preferences unavailable; using the defaults:", describeError(error));
    }
    const { terms: searchTerms, location: searchLocation } = searchPlan(preferences, { role, location });
    console.log(
      "Search preferences:",
      preferences
        ? { terms: searchTerms.length, excludeKeywords: preferences.excludeKeywords.length, salaryFloor: preferences.minSalary !== null }
        : "none (defaults)"
    );

    // ── Adzuna ──────────────────────────────────────────────────────────────
    const fetchAdzuna = async () => {
      const fetches = searchTerms.map(async (term) => {
        const url = `https://api.adzuna.com/v1/api/jobs/gb/search/1?app_id=${appId}&app_key=${appKey}&results_per_page=20&what=${encodeURIComponent(term)}&where=${encodeURIComponent(searchLocation)}`;
        const response = await fetch(url).catch((error) => {
          console.log("Adzuna request error:", term, describeError(error));
          return null;
        });
        if (!response || !response.ok) {
          console.log("Adzuna failed:", term, response?.status);
          failedRequests++;
          return [];
        }
        const data = await response.json();
        return data.results || [];
      });

      const results = await Promise.all(fetches);
      const allJobs = results.flat();

      return allJobs.map((job: any) => ({
        id: `adzuna_${job.id || job.redirect_url}`,
        title: job.title,
        company: job.company?.display_name || "Unknown",
        location: job.location?.display_name || "Unknown",
        salary_min: job.salary_min,
        salary_max: job.salary_max,
        contract_type: job.contract_type,
        created: job.created,
        description: job.description,
        url: job.redirect_url,
        source: "Adzuna",
        raw: job,
      }));
    };

    // ── Reed ────────────────────────────────────────────────────────────────
    const fetchReed = async () => {
      if (!reedKey) return [];

      const fetches = searchTerms.map(async (term) => {
        const url = `https://www.reed.co.uk/api/1.0/search?keywords=${encodeURIComponent(term)}&location=${encodeURIComponent(searchLocation)}&resultsToTake=20`;
        const response = await fetch(url, {
          headers: {
            Authorization: `Basic ${Buffer.from(reedKey + ":").toString("base64")}`,
          },
        }).catch((error) => {
          console.log("Reed request error:", term, describeError(error));
          return null;
        });
        if (!response || !response.ok) {
          console.log("Reed failed:", term, response?.status);
          failedRequests++;
          return [];
        }
        const data = await response.json();
        return data.results || [];
      });

      const results = await Promise.all(fetches);
      const allJobs = results.flat();

      return allJobs.map((job: any) => ({
        id: `reed_${job.jobId}`,
        title: job.jobTitle,
        company: job.employerName || "Unknown",
        location: job.locationName || "Unknown",
        salary_min: job.minimumSalary,
        salary_max: job.maximumSalary,
        contract_type: job.contractType || null,
        created: job.date,
        description: job.jobDescription,
        url: job.jobUrl,
        source: "Reed",
        raw: job,
      }));
    };

    // ── Fetch both APIs in parallel ──────────────────────────────────────────
    console.log("Fetching from Adzuna and Reed in parallel...");
    const [adzunaJobs, reedJobs] = await Promise.all([fetchAdzuna(), fetchReed()]);
    const allJobs = [...adzunaJobs, ...reedJobs];
    console.log("TOTAL RAW JOBS:", allJobs.length);

    if (allJobs.length === 0 && failedRequests > 0) {
      return NextResponse.json(
        {
          error: "Failed to fetch jobs",
          details: `All ${failedRequests} job source request(s) failed. Check the server logs.`,
        },
        { status: 502 }
      );
    }

    // ── Record listings and deduplicate into canonical jobs ─────────────────
    // Listings are merged into one job when they are the same vacancy (same
    // source ID, or same normalised company + title, across Adzuna and Reed).
    // The last listing of a job is the one returned (as before), with every
    // source ID of the job in this batch, so /api/match marks them all seen.
    // Jobs are NOT marked as seen here: /api/match does that once they have
    // actually been scored, so fetched-but-unprocessed jobs stay eligible.
    let newJobs: (Omit<(typeof allJobs)[number], "raw"> & { sourceIds: string[]; jobId?: number })[];
    try {
      const listings: DiscoveredListing[] = allJobs.map((job) => {
        const sourceId = job.source === "Reed" ? "reed" : "adzuna";
        return {
          sourceId,
          externalId: String(job.id).slice(sourceId.length + 1),
          title: job.title,
          company: job.company,
          location: job.location,
          url: job.url,
          salaryMin: job.salary_min ?? null,
          salaryMax: job.salary_max ?? null,
          salaryIsPredicted:
            sourceId === "adzuna" && job.raw?.salary_is_predicted !== undefined
              ? String(job.raw.salary_is_predicted) === "1"
              : null,
          contractType: job.contract_type ?? null,
          contractTime: sourceId === "adzuna" ? job.raw?.contract_time ?? null : null,
          postedAt: job.created ?? null,
          description: job.description ?? null,
          raw: job.raw,
        };
      });
      const discovery = recordDiscovery(db, {
        listings,
        candidateProfileId: typeof candidateProfileId === "number" ? candidateProfileId : null,
        triggeredBy: triggeredBy === "scheduler" ? "scheduler" : "ui",
        params: preferences ? { role, location: searchLocation, preferences: true } : { role, location },
      });
      for (const warning of discovery.warnings) console.warn("Discovery:", warning);
      console.log("UNIQUE (this batch):", discovery.stats.uniqueJobs);
      newJobs = discovery.newJobs.map((job) => {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { raw, ...representative } = allJobs[job.representativeIndex];
        return { ...representative, sourceIds: job.sourceIds, jobId: job.jobId };
      });
    } catch (error) {
      // Persisting must not stop job search: fall back to the previous
      // in-memory deduplication and seen_jobs check.
      console.error("Recording discovered jobs failed; using legacy deduplication:", error);
      const groups = new Map<string, { job: (typeof allJobs)[number]; sourceIds: string[] }>();
      for (const job of allJobs) {
        const key = `${job.title}-${job.company}`;
        const sourceIds = [...(groups.get(key)?.sourceIds ?? []), job.id];
        groups.set(key, { job, sourceIds: Array.from(new Set(sourceIds)) });
      }
      newJobs = Array.from(groups.values())
        .filter(({ sourceIds }) => filterNewJobs(sourceIds.map((id) => ({ id }))).length === sourceIds.length)
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        .map(({ job: { raw, ...job }, sourceIds }) => ({ ...job, sourceIds }));
    }
    console.log("NEW (not processed before):", newJobs.length);

    // Preferences: leave out excluded titles and jobs below the salary floor.
    // Nothing is recorded for them, so they return if the preferences change.
    if (preferences) {
      const salaryIsPredicted = new Map(
        allJobs.map((job) => [
          job.id,
          job.source === "Adzuna" && job.raw?.salary_is_predicted !== undefined
            ? String(job.raw.salary_is_predicted) === "1"
            : null,
        ])
      );
      const filtered = applyDiscoveryFilter(preferences, newJobs, (job) => ({
        title: job.title,
        salaryMin: job.salary_min ?? null,
        salaryMax: job.salary_max ?? null,
        salaryIsPredicted: salaryIsPredicted.get(job.id) ?? null,
      }));
      newJobs = filtered.kept;
      console.log("Left out by preferences:", { excludedByKeyword: filtered.excludedByKeyword, belowMinSalary: filtered.belowMinSalary, returned: newJobs.length });
    }

    return NextResponse.json(newJobs);
  } catch (error) {
    console.error("POST /api/jobs error:", describeError(error));
    return NextResponse.json(
      { error: "Failed to fetch jobs" },
      { status: 500 }
    );
  }
}