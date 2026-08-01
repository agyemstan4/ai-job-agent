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


let allJobs: any[] = [];


for (const term of searchTerms) {

  const url = `https://api.adzuna.com/v1/api/jobs/gb/search/1?app_id=${appId}&app_key=${appKey}&results_per_page=20&what=${encodeURIComponent(
    term
  )}&where=${encodeURIComponent(location)}`;


  const response = await fetch(url);

  const text = await response.text();


  console.log(
    "ADZUNA SEARCH:",
    term,
    "STATUS:",
    response.status
  );


  if (!response.ok) {
    console.log("Adzuna failed:", text);
    continue;
  }


  const data = JSON.parse(text);


  allJobs.push(...data.results);

}


console.log(
  "TOTAL RAW JOBS:",
  allJobs.length
);


// remove duplicate jobs
const uniqueJobs = Array.from(
  new Map(
    allJobs.map((job) => [
      job.id || job.redirect_url,
      job,
    ])
  ).values()
);


console.log(
  "UNIQUE JOBS:",
  uniqueJobs.length
);


const jobs = uniqueJobs.map((job: any) => ({
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


    
   return NextResponse.json(jobs);

  } catch (error) {
    console.error(error);

    return NextResponse.json(
      { error: "Failed to fetch jobs" },
      { status: 500 }
    );
  }
}