import { NextResponse } from "next/server";
import { filterNewJobs, markJobsSeen } from "@/lib/db";

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
        const response = await fetch(url);
        if (!response.ok) {
          console.log("Adzuna failed:", term, response.status);
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
        });
        if (!response.ok) {
          console.log("Reed failed:", term, response.status);
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

    // ── Deduplicate by title+company within this batch ───────────────────────
    const withinBatchUnique = Array.from(
      new Map(
        allJobs.map((job) => [`${job.title}-${job.company}`, job])
      ).values()
    );
    console.log("UNIQUE (this batch):", withinBatchUnique.length);

    // ── Deduplicate against DB — filter out already-seen job IDs ────────────
    const newJobs = filterNewJobs(withinBatchUnique);
    console.log("NEW (not seen before):", newJobs.length);

    // Mark all new jobs as seen immediately so they won't appear in the next run
    if (newJobs.length > 0) {
      markJobsSeen(newJobs.map((j) => j.id));
    }

    return NextResponse.json(newJobs);
  } catch (error) {
    console.error(error);
    return NextResponse.json(
      { error: "Failed to fetch jobs" },
      { status: 500 }
    );
  }
}