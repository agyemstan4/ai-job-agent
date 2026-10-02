import { NextResponse } from "next/server";
import { filterNewJobs } from "@/lib/db";

export async function POST(req: Request) {
  try {
    const { role, location } = await req.json();

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

    const searchTerms = Array.from(
      new Set([
        role,
        "junior software engineer",
        "graduate software developer",
        "android developer",
        "java developer",
        "frontend developer",
        "full stack developer",
      ])
    );

    // ── Adzuna ──────────────────────────────────────────────────────────────
    const fetchAdzuna = async () => {
      const fetches = searchTerms.map(async (term) => {
        const url = `https://api.adzuna.com/v1/api/jobs/gb/search/1?app_id=${appId}&app_key=${appKey}&results_per_page=20&what=${encodeURIComponent(term)}&where=${encodeURIComponent(location)}`;
        const response = await fetch(url).catch((error) => {
          console.log("Adzuna request error:", term, error);
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
      }));
    };

    // ── Reed ────────────────────────────────────────────────────────────────
    const fetchReed = async () => {
      if (!reedKey) return [];

      const fetches = searchTerms.map(async (term) => {
        const url = `https://www.reed.co.uk/api/1.0/search?keywords=${encodeURIComponent(term)}&location=${encodeURIComponent(location)}&resultsToTake=20`;
        const response = await fetch(url, {
          headers: {
            Authorization: `Basic ${Buffer.from(reedKey + ":").toString("base64")}`,
          },
        }).catch((error) => {
          console.log("Reed request error:", term, error);
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

    // ── Deduplicate by title+company within this batch ───────────────────────
    // The last listing for a title+company wins (as before), but every source
    // ID in the group is kept so the same job from another source (Adzuna vs
    // Reed) is also recognised as seen in future runs.
    const groups = new Map<string, { job: (typeof allJobs)[number]; sourceIds: string[] }>();
    for (const job of allJobs) {
      const key = `${job.title}-${job.company}`;
      const sourceIds = [...(groups.get(key)?.sourceIds ?? []), job.id];
      groups.set(key, { job, sourceIds: Array.from(new Set(sourceIds)) });
    }
    const withinBatchUnique = Array.from(groups.values()).map(({ job, sourceIds }) => ({
      ...job,
      sourceIds,
    }));
    console.log("UNIQUE (this batch):", withinBatchUnique.length);

    // ── Deduplicate against DB — filter out already-seen job IDs ────────────
    // A job is skipped if any of its source IDs has been seen before.
    const newJobs = withinBatchUnique.filter(
      (job) => filterNewJobs(job.sourceIds.map((id) => ({ id }))).length === job.sourceIds.length
    );
    console.log("NEW (not seen before):", newJobs.length);

    // Jobs are NOT marked as seen here. /api/match marks them once they have
    // actually been scored, so jobs that are fetched but never processed stay
    // eligible for the next run.
    return NextResponse.json(newJobs);
  } catch (error) {
    console.error(error);
    return NextResponse.json(
      { error: "Failed to fetch jobs" },
      { status: 500 }
    );
  }
}