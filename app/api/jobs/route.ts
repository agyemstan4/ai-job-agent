import { NextResponse } from "next/server";

export async function POST(req: Request) {
  try {
    const { role, location } = await req.json();

    const appId = process.env.ADZUNA_APP_ID;
    const appKey = process.env.ADZUNA_APP_KEY;

    console.log("APP ID:", appId);
    console.log("APP KEY:", appKey ? "Exists" : "Missing");

    if (!appId || !appKey) {
      return NextResponse.json(
        { error: "Adzuna API keys missing" },
        { status: 500 }
      );
    }

    const url = `https://api.adzuna.com/v1/api/jobs/gb/search/1?app_id=${appId}&app_key=${appKey}&results_per_page=50&what=${encodeURIComponent(
      role
    )}&where=${encodeURIComponent(location)}`;

    const response = await fetch(url);

const text = await response.text();

console.log("ADZUNA STATUS:", response.status);
console.log("ADZUNA RESPONSE:", text);

if (!response.ok) {
  return NextResponse.json(
    {
      error: "Adzuna request failed",
      details: text,
    },
    { status: response.status }
  );
}

const data = JSON.parse(text);

console.log("TOTAL JOBS FROM ADZUNA:", data.results.length);

  
    const jobs = data.results.map((job: any) => ({
  title: job.title,
  company: job.company?.display_name || "Unknown",
  location: job.location?.display_name || "Unknown",

  salary: job.salary_min && job.salary_max
    ? `£${job.salary_min.toLocaleString()} - £${job.salary_max.toLocaleString()}`
    : "Not provided",

  salary_min: job.salary_min,
  salary_max: job.salary_max,
  contract_type: job.contract_type,
  created: job.created,

  description: job.description,
  url: job.redirect_url,
}));


   console.log("CLEAN JOBS:", jobs);
   return NextResponse.json(jobs);

  } catch (error) {
    console.error(error);

    return NextResponse.json(
      { error: "Failed to fetch jobs" },
      { status: 500 }
    );
  }
}