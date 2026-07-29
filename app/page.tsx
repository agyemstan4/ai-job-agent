"use client";

import { useState } from "react";


export default function Home() {

  const [jobDescription, setJobDescription] = useState("");

  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [analysis, setAnalysis] = useState<any>(null);
  const [matches, setMatches] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [loadingStep, setLoadingStep] = useState("");

  const [selectedRoles, setSelectedRoles] = useState<string[]>([
    "Junior Software Engineer",
  ]);

  const roles = [
    "Junior Software Engineer",
    "Graduate Software Engineer",
    "Android Developer",
    "Frontend Developer",
    "Backend Developer",
    "Full Stack Developer",
    "Java Developer",
    "C# Developer",
  ];

  const toggleRole = (role: string) => {
    setSelectedRoles((prev) =>
      prev.includes(role)
        ? prev.filter((r) => r !== role)
        : [...prev, role]
    );
  };

  async function analyseCV() {
    if (!selectedFile) {
      alert("Please upload a CV first.");
      return;
    }

    setLoading(true);
    setLoadingStep("📄 Reading your CV...");
    setAnalysis(null);
    setMatches(null);

    
    try {
  const formData = new FormData();
  formData.append("cv", selectedFile);

  formData.append(
    "roles",
    JSON.stringify(selectedRoles)
  );

  formData.append(
    "jobDescription",
    jobDescription
  );

      const controller = new AbortController();

      const timeout = setTimeout(() => {
      controller.abort();
      },  300000); // 3 minutes

const response = await fetch("/api/analyse-cv", {
  method: "POST",
  body: formData,
  signal: controller.signal,
});

clearTimeout(timeout);

      const data = await response.json();

if (!response.ok) {
  throw new Error(data.details || data.error || "Analysis failed.");
}

console.log("RAW AI RESPONSE:", data.analysis);

setLoadingStep("🤖 AI analysing your CV...");

const candidateAnalysis =
  typeof data.analysis === "string"
    ? JSON.parse(data.analysis)
    : data.analysis;

setAnalysis(candidateAnalysis);

setLoadingStep("🧠 AI ranking the best jobs...");
// Get jobs from Adzuna
const jobsResponse = await fetch("/api/jobs", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    role: selectedRoles[0],
    location: "London",
  }),
});

const jobsData = await jobsResponse.json();

console.log("JOBS FOUND:", jobsData);



if (!Array.isArray(jobsData)) {
  console.error("Jobs API failed:", jobsData);
  return;
}

const jobs = jobsData.map((job:any)=>({
  title: job.title,
  company: job.company,
  location: job.location,
  url: job.url,
  description: job.description?.slice(0,500),
  salaryMin: job.salary_min,
  salaryMax: job.salary_max,
  contractType: job.contract_type,
  created: job.created
}));

console.log("JOBS FOR AI:", jobs);

console.log("STEP 1 - JOBS DATA TYPE:", typeof jobsData);
console.log("STEP 2 - JOBS ARRAY:", jobs);

console.log("SENDING TO MATCH AI:", {
  candidate: candidateAnalysis,
  jobs
});


console.log("STEP 3 - ABOUT TO CALL MATCH API");
// Match jobs with AI
const matchResponse = await fetch("/api/match", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    candidate: candidateAnalysis,
    jobs,
  }),
});

console.log("STEP 4 - MATCH API RESPONSE RECEIVED");

const matchResults = await matchResponse.json();

console.log("STEP 5 - MATCH RESULT:", matchResults);

console.log("AI JOB MATCHES:", matchResults);

console.log("SETTING MATCHES:", matchResults.matches);

setMatches(matchResults.matches);

console.log("AFTER SET:", matchResults.matches);

      
       console.log("Server response:", data);
      
    } catch (error) {
      console.error(error);
      alert("Something went wrong while analysing your CV.");
    } finally {
      setLoading(false);
      setLoadingStep("");
    }
  }

  return (
    <main className="min-h-screen bg-gray-100 p-8">
      <div className="mx-auto max-w-4xl">

        <h1 className="text-4xl font-bold text-gray-900">
          AI Job Agent
        </h1>

        <p className="mt-2 text-gray-600">
          Upload your CV and let AI analyse it for suitable software jobs.
        </p>

        {/* CV Upload */}
        <div className="mt-6 rounded-xl bg-white p-6 text-gray-900 shadow">

          <h2 className="text-2xl font-semibold text-gray-900">
            Your CV
          </h2>

          <p className="mt-2 text-gray-600">
            Upload your PDF CV.
          </p>

          <label className="mt-6 inline-block cursor-pointer rounded-lg bg-black px-5 py-3 text-white hover:bg-gray-800">

            Upload CV

            <input
              type="file"
              accept=".pdf"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];

                if (file) {
                  setSelectedFile(file);
                }
              }}
            />

          </label>

          {selectedFile && (
            <p className="mt-4 text-green-600">
              ✓ {selectedFile.name}
            </p>
          )}

        </div>

        {/* Target Roles */}

        <div className="mt-6 rounded-xl bg-white p-6 text-gray-900 shadow">

          <h2 className="text-2xl font-semibold text-gray-900">
            Target Roles
          </h2>

          <div className="mt-4 flex flex-wrap gap-3">

            {roles.map((role) => (
  <button
    key={role}
    onClick={() => toggleRole(role)}
    className={`rounded-full px-4 py-2 transition ${
      selectedRoles.includes(role)
        ? "bg-blue-600 text-white"
        : "bg-gray-200 text-gray-700 hover:bg-gray-300"
    }`}
  >
    {role}
  </button>
))}

          </div>

        </div>

{/* Job Description */}

<div className="mt-6 rounded-xl bg-white p-6 text-gray-900 shadow">

  <h2 className="text-2xl font-semibold text-gray-900">
    Job Description
  </h2>

  <p className="mt-2 text-gray-600">
    Paste the job description you want to compare your CV against.
  </p>

  <textarea
  value={jobDescription}
  onChange={(e) => setJobDescription(e.target.value)}
  placeholder="Paste the full job advert here..."
  rows={10}
  className="mt-4 w-full rounded-lg border border-gray-300 bg-white p-4 text-gray-900 placeholder:text-gray-500 focus:border-blue-500 focus:outline-none"
/>

</div>


        {/* Analyse Button */}

        <button
          onClick={analyseCV}
          disabled={loading}
          className="mt-6 w-full rounded-lg bg-blue-600 px-5 py-3 font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
        >
          
          {loading ? loadingStep : "Find Suitable Jobs"}
        </button>
        
  
      {/* AI Output */}

{analysis && (
  <div className="mt-8 rounded-xl bg-white p-6 text-gray-900 shadow">

  <h2 className="text-2xl font-semibold">
      AI Analysis
    </h2>

    <h3 className="mt-6 text-xl font-semibold">
      Match Score
    </h3>

    <p className="mt-2 text-3xl font-bold">
      {analysis.matchScore}%
    </p>

   <p className="mt-2 font-semibold">
  {analysis.matchScore >= 90
    ? "🟢 Excellent Match"
    : analysis.matchScore >= 75
    ? "🟢 Strong Match"
    : analysis.matchScore >= 60
    ? "🟡 Moderate Match"
    : "🔴 Weak Match"}
</p>


    <div className="mt-3 h-3 w-full rounded-full bg-gray-200">
      <div
        className="h-3 rounded-full bg-blue-600"
        style={{
          width: `${analysis.matchScore}%`
        }}
      />
    </div>


    <h3 className="mt-6 text-xl font-semibold">
      Candidate Summary
    </h3>

    <p className="mt-2 text-gray-700">
      {analysis.summary}
    </p>


    <h3 className="mt-6 text-xl font-semibold">
      Recommendation
    </h3>

    <p className="mt-2 text-gray-700">
      {analysis.recommendation}
    </p>


    <h3 className="mt-6 text-xl font-semibold">
      Matching Skills
    </h3>

    <div className="mt-3 flex flex-wrap gap-2">

      {analysis.matchingSkills?.map((skill:string)=>(
        <span
          key={skill}
          className="rounded-full bg-blue-100 px-3 py-1 text-blue-700"
        >
          {skill}
        </span>
      ))}

    </div>


    <h3 className="mt-6 text-xl font-semibold">
      Missing Skills
    </h3>

   <ul className="mt-2 list-disc pl-5">

  {analysis.missingSkills?.length > 0 ? (

    analysis.missingSkills.map((skill: any, index: number) => (
  <li key={index}>
    {typeof skill === "string" ? skill : skill.skillName}
  </li>
))

  ) : (

    <li>
      No major skill gaps detected 🎉
    </li>

  )}

</ul>

    {/* JOB MATCHES */}

    {matches && matches.length > 0 && (

      <div className="mt-10">

        <h2 className="text-3xl font-bold">
          🎯 Best Job Matches
        </h2>

        <p className="mt-2 text-gray-600">
          Ranked by AI based on your CV.
        </p>


        <div className="mt-6 space-y-6">


          {matches.map((job:any,index:number)=>(

            <div
              key={index}
              className="rounded-2xl
    border
    border-gray-200
    bg-white
    p-8
    shadow-sm
    transition
    duration-300
    hover:-translate-y-1
    hover:shadow-xl
"
            >


              <div className="flex items-start justify-between">

  <div>

    <h3 className="text-2xl font-bold text-gray-900">
  {job.title}
</h3>


<p className="text-gray-600">
{job.company}
</p>
</div>


  <div>

    <span
      className={`
        rounded-full
        px-4
        py-2
        text-lg
        font-bold
        ${
  Number(job.matchScore) >= 75
? "bg-green-100 text-green-700"
: Number(job.matchScore) >= 60
? "bg-yellow-100 text-yellow-700"
: "bg-red-100 text-red-700"
}
      `}
    >
    {Number(job.matchScore)}% Match
    </span>

  </div>

</div>


<div className="mt-4">

  <div className="flex justify-between text-sm text-gray-600">
    <span>AI Compatibility</span>
    <span>{job.matchScore}%</span>
  </div>

  <div className="mt-2 h-3 rounded-full bg-gray-200">

    <div
      className="h-3 rounded-full bg-blue-600"
      style={{
  width: `${Number(job.matchScore)}%`
}}
    />

  </div>

</div>

<p className="mt-1 text-sm text-gray-500">
  📍 {job.location}
</p>

              {job.salaryMin && job.salaryMax && (
  <p className="mt-2 text-green-600 font-semibold">
    💷 £{job.salaryMin.toLocaleString()} - £{job.salaryMax.toLocaleString()}
  </p>
)}

{job.contractType && (
  <p className="text-sm text-gray-600">
    📄 {job.contractType}
  </p>
)}

{job.created && (
  <p className="text-sm text-gray-500">
    🕒 Posted: {new Date(job.created).toLocaleDateString()}
  </p>
)}

              {job.breakdown && (
  <div className="mt-6 grid grid-cols-2 gap-4">

    <div className="rounded-xl bg-blue-50 p-4">
      <p className="text-sm text-gray-600">
        Technical Skills
      </p>
      <p className="mt-1 text-2xl font-bold text-blue-700">
        {job.breakdown.technicalSkills}%
      </p>
    </div>


    <div className="rounded-xl bg-green-50 p-4">
      <p className="text-sm text-gray-600">
        Experience
      </p>
      <p className="mt-1 text-2xl font-bold text-green-700">
        {job.breakdown.experienceLevel}%
      </p>
    </div>


    <div className="rounded-xl bg-purple-50 p-4">
      <p className="text-sm text-gray-600">
        Projects
      </p>
      <p className="mt-1 text-2xl font-bold text-purple-700">
        {job.breakdown.projects}%
      </p>
    </div>


    <div className="rounded-xl bg-orange-50 p-4">
      <p className="text-sm text-gray-600">
        Growth Potential
      </p>
      <p className="mt-1 text-2xl font-bold text-orange-700">
        {job.breakdown.growthPotential}%
      </p>
    </div>

  </div>
)}

              <div className="mt-5 rounded-xl bg-gray-50 p-5">

                <h4 className="text-lg font-semibold">
                  🤖 AI Recommendation
                </h4>


                <p className="mt-2 font-semibold">
  {Number(job.matchScore) >= 90
    ? "🟢 Excellent Match"
    : Number(job.matchScore) >= 75
    ? "🟢 Strong Match"
    : Number(job.matchScore) >= 60
    ? "🟡 Moderate Match"
    : "🔴 Weak Match"}
</p>

                <p className="mt-3 text-sm text-gray-700 leading-relaxed">
                  {job.reason}
                </p>


                <div className="mt-4">

                  <p className="text-sm font-semibold">
                    Why you stand out:
                  </p>

<ul className="mt-2 space-y-1 text-sm text-gray-700">

  {job.strengths?.map((strength:string)=>(
    <li key={strength}>
      ✓ {strength}
    </li>
  ))}

</ul>
                 

                </div>

              </div>

              


              <h4 className="mt-5 font-semibold">
                Missing Skills
              </h4>


              {job.missingSkills?.length > 0 ? (

                <div className="mt-3 flex flex-wrap gap-2">

{job.missingSkills.map((skill:string)=>(
  <span
    key={skill}
    className="
      rounded-full
      bg-red-100
      px-3
      py-1
      text-sm
      text-red-700
    "
  >
    {skill}
  </span>
))}

</div>

              ) : (

                <p className="mt-2 text-green-600">
                  No major skill gaps detected.
                </p>

              )}


              <a
                href={job.url}
                target="_blank"
                rel="noopener noreferrer"
                className="
mt-6
inline-flex
items-center
rounded-lg
bg-blue-600
px-6
py-3
font-semibold
text-white
transition
hover:bg-blue-700
hover:scale-105
"
              >
                Apply Now →
              </a>


            </div>

          ))}


        </div>

      </div>

    )}


  </div>
)}    
 </div>
</main>
);
}