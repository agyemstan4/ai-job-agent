"use client";

import { useState } from "react";
import Link from "next/link";
import CommandCentre from "./components/CommandCentre";

// The CV route names the file (and picks .pdf or the .docx fallback) in its
// Content-Disposition header; fall back to a PDF-style name if it's missing.
function getDownloadFilename(response: Response, job: { company?: string }) {
  const header = response.headers.get("Content-Disposition") || "";
  const match = header.match(/filename="([^"]+)"/);
  if (match) return match[1];
  const isDocx = (response.headers.get("Content-Type") || "").includes("wordprocessingml");
  const safeCompany = (job.company || "Company").replace(/[^\w-]+/g, "_");
  return `CV_${safeCompany}.${isDocx ? "docx" : "pdf"}`;
}

export default function Home() {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [structuredCV, setStructuredCV] = useState<any>(null);
  const [tailoringJob, setTailoringJob] = useState<Record<number, boolean>>({});
  const [questionInputs, setQuestionInputs] = useState<Record<number, string>>({});
  const [questionAnswers, setQuestionAnswers] = useState<Record<number, { question: string; answer: string }[]>>({});
  const [answeringQuestions, setAnsweringQuestions] = useState<Record<number, boolean>>({});
  const [analysis, setAnalysis] = useState<any>(null);
  // The stored profile version the analysis belongs to (null if not saved).
  const [candidateProfileId, setCandidateProfileId] = useState<number | null>(null);
  const [matches, setMatches] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [loadingStep, setLoadingStep] = useState("");
  const [coverLetters, setCoverLetters] = useState<Record<number, string>>({});
  const [generatingCoverLetter, setGeneratingCoverLetter] = useState<Record<number, boolean>>({});
  const [selectedRoles, setSelectedRoles] = useState<string[]>(["Junior Software Engineer"]);
  const [batchCount, setBatchCount] = useState(3);
  const [batchRunning, setBatchRunning] = useState(false);
  const [batchProgress, setBatchProgress] = useState("");
  const [batchResults, setBatchResults] = useState<any[]>([]);


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

  const getMatchLabel = (score: number | undefined) => {
    if (score === undefined || score === null) return "No Score";
    if (score >= 90) return "Excellent Match";
    if (score >= 70) return "Strong Match";
    if (score >= 50) return "Potential Match";
    if (score >= 30) return "Weak Match";
    return "Poor Match";
  };

  const toggleRole = (role: string) => {
    setSelectedRoles((prev) =>
      prev.includes(role) ? prev.filter((r) => r !== role) : [...prev, role]
    );
  };

  async function generateCoverLetter(job: any, index: number) {
    setGeneratingCoverLetter((prev) => ({ ...prev, [index]: true }));
    try {
      const candidateForCoverLetter = {
        ...analysis,
        education: structuredCV?.education || [],
        projects: structuredCV?.projects || [],
      };

      const response = await fetch("/api/cover-letter", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidate: candidateForCoverLetter, job }),
      });
      const data = await response.json();
      if (!response.ok || !data.coverLetter) {
        throw new Error(data.details || data.error || "Cover letter generation failed.");
      }
      setCoverLetters((prev) => ({ ...prev, [index]: data.coverLetter }));
    } catch (error) {
      console.error("Cover letter error:", error);
      alert(
        `Something went wrong generating the cover letter.\n\n${
          error instanceof Error ? error.message : String(error)
        }`
      );
    } finally {
      setGeneratingCoverLetter((prev) => ({ ...prev, [index]: false }));
    }
  }

  async function analyseCV() {
    if (!selectedFile) {
      alert("Please upload a CV first.");
      return;
    }

    setLoading(true);
    setLoadingStep("📄 Reading your CV...");
    setAnalysis(null);
    setCandidateProfileId(null);
    setMatches(null);
    setStructuredCV(null);
    setCoverLetters({});

    try {
      const formData = new FormData();
      formData.append("cv", selectedFile);
      formData.append("roles", JSON.stringify(selectedRoles));

      setLoadingStep("🤖 Analysing your CV...");
const combinedResponse = await fetch("/api/analyse-and-extract", {
  method: "POST",
  body: formData,
});

const combinedData = await combinedResponse.json();

if (!combinedResponse.ok) {
  throw new Error(combinedData.details || combinedData.error || "Analysis failed.");
}

const candidateAnalysis = combinedData.analysis;
setAnalysis(candidateAnalysis);
const profileId: number | null =
  typeof combinedData.candidateProfileId === "number" ? combinedData.candidateProfileId : null;
setCandidateProfileId(profileId);

if (combinedData.structuredCV) {
  setStructuredCV(combinedData.structuredCV);
}
      

      setLoadingStep("🔍 Finding suitable jobs...");

      const jobsResponse = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: selectedRoles[0], location: "London", candidateProfileId: profileId }),
      });

      const jobsData = await jobsResponse.json();

      if (!jobsResponse.ok || !Array.isArray(jobsData)) {
        console.error("Jobs API failed:", jobsData);
        throw new Error(
          `Job search failed: ${jobsData?.details || jobsData?.error || jobsResponse.status}`
        );
      }

      const jobs = jobsData.map((job: any) => ({
        // id/sourceIds let /api/match mark jobs as seen once they're scored;
        // jobId is the stored job the match is recorded against.
        id: job.id,
        jobId: job.jobId,
        sourceIds: job.sourceIds,
        source: job.source,
        title: job.title,
        company: job.company,
        location: job.location,
        url: job.url,
        description: job.description?.slice(0, 500),
        salaryMin: job.salary_min,
        salaryMax: job.salary_max,
        contractType: job.contract_type,
        created: job.created,
      }));

      setLoadingStep("🧠 AI ranking the best jobs...");

      const matchResponse = await fetch("/api/match", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidate: candidateAnalysis, jobs, candidateProfileId: profileId }),
      });

      const matchResults = await matchResponse.json();

      if (!matchResponse.ok || !Array.isArray(matchResults.matches)) {
        throw new Error(
          `Job matching failed: ${matchResults?.details || matchResults?.error || matchResponse.status}`
        );
      }

      setMatches(matchResults.matches);

    } catch (error) {
      console.error(error);
      alert(
        `Something went wrong while analysing your CV.\n\n${
          error instanceof Error ? error.message : String(error)
        }`
      );
    } finally {
      setLoading(false);
      setLoadingStep("");
    }
  }
  

  async function runBatchApply() {
    if (!structuredCV || !matches || matches.length === 0) {
      alert("Please run 'Find Suitable Jobs' first.");
      return;
      
    }


    
    setBatchRunning(true);
    setBatchResults([]);

    const jobsToProcess = matches.slice(0, batchCount);
    const results: any[] = [];

    for (let i = 0; i < jobsToProcess.length; i++) {
      const job = jobsToProcess[i];
      setBatchProgress(`Processing ${i + 1} of ${jobsToProcess.length}: ${job.title} at ${job.company}`);

      const result: any = { job, success: false };

      try {
        const tailorResponse = await fetch("/api/tailor-cv", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            structuredCV,
            job: {
              title: job.title,
              company: job.company,
              description: job.description || "",
            },
          }),
        });
        const tailorData = await tailorResponse.json();
        if (!tailorResponse.ok) {
          throw new Error(tailorData.details || tailorData.error || "Tailoring failed.");
        }
        result.tailoredCV = tailorData.tailoredCV;

        const docxResponse = await fetch("/api/generate-cv-docx", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tailoredCV: tailorData.tailoredCV, job }),
        });
        if (!docxResponse.ok) {
          const errData = await docxResponse.json();
          throw new Error(errData.details || errData.error || "Document generation failed.");
        }
        const blob = await docxResponse.blob();
        result.cvUrl = window.URL.createObjectURL(blob);
        // Use the server's filename: it's .docx when PDF conversion fell back.
        result.cvFileName = getDownloadFilename(docxResponse, job);

        const candidateForCoverLetter = {
          ...analysis,
          education: structuredCV?.education || [],
          projects: structuredCV?.projects || [],
        };
        const coverResponse = await fetch("/api/cover-letter", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ candidate: candidateForCoverLetter, job }),
        });
        const coverData = await coverResponse.json();
        result.coverLetter = coverData.coverLetter || "";

        // The tailored CV is still usable, so the result stays successful,
        // but the cover-letter failure is recorded instead of silently dropped.
        if (!coverResponse.ok || !coverData.coverLetter) {
          result.error = `Cover letter failed: ${
            coverData.details || coverData.error || coverResponse.status
          }`;
        }

        result.success = true;
      } catch (error) {
        result.error = error instanceof Error ? error.message : String(error);
      }

      results.push(result);
      setBatchResults([...results]);
    }

    setBatchRunning(false);
    setBatchProgress("");

    // Save completed batch to DB so results survive page refresh
    try {
      const toSave = await Promise.all(
        results.map(async (r) => {
          let cvBase64: string | undefined;
          if (r.cvUrl) {
            const blob = await fetch(r.cvUrl).then((res) => res.blob());
            const buffer = await blob.arrayBuffer();
            const bytes = new Uint8Array(buffer);
            let binary = "";
            for (let i = 0; i < bytes.length; i++) {
              binary += String.fromCharCode(bytes[i]);
            }
            cvBase64 = btoa(binary);
          }
          return {
            job: r.job,
            coverLetter: r.coverLetter,
            cvBase64,
            cvFilename: r.cvFileName,
            tailoredCV: r.tailoredCV,
            success: r.success,
            error: r.error,
          };
        })
      );

      const saveResponse = await fetch("/api/applications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ results: toSave, candidateProfileId }),
      });
      const saveData = await saveResponse.json().catch(() => ({}));
      if (!saveResponse.ok) {
        throw new Error(saveData.error || `HTTP ${saveResponse.status}`);
      }
      // Results that could not be added (e.g. the job already has an
      // application) are reported rather than silently dropped.
      if (Array.isArray(saveData.warnings) && saveData.warnings.length > 0) {
        alert(
          `The batch was saved to the Review Queue, but some results were not added:\n\n${saveData.warnings.join("\n")}`
        );
      }
    } catch (err) {
      console.error("Failed to persist batch results:", err);
      alert(
        `The batch finished but could not be saved to the Review Queue.\n\n${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  async function generateTailoredCVForJob(job: any, index: number) {
    if (!structuredCV) {
      alert("Structured CV data not available. Please try clicking Find Suitable Jobs again.");
      return;
    }

    setTailoringJob((prev) => ({ ...prev, [index]: true }));

    try {
      const tailorResponse = await fetch("/api/tailor-cv", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          structuredCV,
          job: {
            title: job.title,
            company: job.company,
            description: job.description || "",
          },
        }),
      });

      const tailorData = await tailorResponse.json();

      if (!tailorResponse.ok) {
        throw new Error(tailorData.details || tailorData.error || "Tailoring failed.");
      }

      const docxResponse = await fetch("/api/generate-cv-docx", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tailoredCV: tailorData.tailoredCV, job }),
      });

      if (!docxResponse.ok) {
        const errData = await docxResponse.json();
        throw new Error(errData.details || errData.error || "Document generation failed.");
      }

      const blob = await docxResponse.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = getDownloadFilename(docxResponse, job);
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    } catch (error) {
      console.error(error);
      alert(
        `Something went wrong generating the tailored CV.\n\n${
          error instanceof Error ? error.message : String(error)
        }`
      );
    } finally {
      setTailoringJob((prev) => ({ ...prev, [index]: false }));
    }
  }

  async function answerApplicationQuestions(job: any, index: number) {
    const rawInput = questionInputs[index] || "";
    const questions = rawInput
      .split("\n")
      .map((q) => q.trim())
      .filter((q) => q.length > 0);

    if (questions.length === 0) {
      alert("Please paste in at least one application question (one per line).");
      return;
    }

    if (!analysis) {
      alert("Please run 'Find Suitable Jobs' first so your CV analysis is available.");
      return;
    }

    setAnsweringQuestions((prev) => ({ ...prev, [index]: true }));

    try {
      const candidateForQuestions = {
        ...analysis,
        education: structuredCV?.education || [],
        projects: structuredCV?.projects || [],
        experience: structuredCV?.experience || [],
      };

      const response = await fetch("/api/application-questions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidate: candidateForQuestions, job, questions }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.details || data.error || "Answering questions failed.");
      }

      setQuestionAnswers((prev) => ({ ...prev, [index]: data.answers }));
    } catch (error) {
      console.error(error);
      alert(
        `Something went wrong answering the questions.\n\n${
          error instanceof Error ? error.message : String(error)
        }`
      );
    } finally {
      setAnsweringQuestions((prev) => ({ ...prev, [index]: false }));
    }
  }

  return (
    <main className="min-h-screen bg-gray-100 p-8">
      <div className="mx-auto max-w-6xl">

        <div className="flex items-center justify-between">
          <h1 className="text-4xl font-bold text-gray-900">AI Job Agent</h1>
          <div className="flex gap-2">
            <a href="/review" className="rounded-lg bg-emerald-600 px-4 py-2 font-semibold text-white hover:bg-emerald-700">
              📋 Review Queue
            </a>
            <a href="/applications" className="rounded-lg bg-blue-600 px-4 py-2 font-semibold text-white hover:bg-blue-700">
              🗂 Applications
            </a>
            <Link href="/preferences" className="rounded-lg bg-gray-800 px-4 py-2 font-semibold text-white hover:bg-gray-700">
              ⚙️ Search preferences
            </Link>
          </div>
        </div>
        <p className="mt-2 text-gray-600">
          Your job-search command centre: matches, preparation, review and tracking. You always submit applications yourself.
        </p>

        <CommandCentre />

        <h2 className="mt-10 text-2xl font-bold text-gray-900">Run a new search</h2>
        <p className="text-sm text-gray-600">Upload your CV and let AI analyse it for suitable software jobs.</p>

        {/* CV Upload */}
        <div className="mt-6 rounded-xl bg-white p-6 text-gray-900 shadow">
          <h2 className="text-2xl font-semibold text-gray-900">Your CV</h2>
          <p className="mt-2 text-gray-600">Upload your PDF CV.</p>
          <label className="mt-6 inline-block cursor-pointer rounded-lg bg-black px-5 py-3 text-white hover:bg-gray-800">
            Upload CV
            <input
              type="file"
              accept=".pdf"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) setSelectedFile(file);
              }}
            />
          </label>
          {selectedFile && (
            <p className="mt-4 text-green-600">✓ {selectedFile.name}</p>
          )}
        </div>

        {/* Target Roles */}
        <div className="mt-6 rounded-xl bg-white p-6 text-gray-900 shadow">
          <h2 className="text-2xl font-semibold text-gray-900">Target Roles</h2>
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

        {/* Find Jobs Button */}
        <button
          onClick={analyseCV}
          disabled={loading}
          className="mt-6 w-full rounded-lg bg-blue-600 px-5 py-3 font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {loading ? loadingStep : "Find Suitable Jobs"}
        </button>

        {/* Analysis + Job Cards */}
        {analysis && (
          <div className="mt-8 rounded-xl bg-white p-6 text-gray-900 shadow">
            <h2 className="text-2xl font-semibold">AI Analysis</h2>

            <h3 className="mt-6 text-xl font-semibold">Candidate Match Score</h3>
            <p className="mt-2 text-3xl font-bold">
              {typeof analysis.matchScore === "number" ? `${analysis.matchScore}%` : "N/A"}
            </p>
            <p className="mt-2 font-semibold">
              {typeof analysis.matchScore !== "number"
                ? "No score — the AI did not return a valid score"
                : analysis.matchScore >= 90
                ? "🟢 Excellent Match"
                : analysis.matchScore >= 70
                ? "🟢 Strong Match"
                : analysis.matchScore >= 50
                ? "🟡 Potential Match"
                : analysis.matchScore >= 30
                ? "🟠 Weak Match"
                : "🔴 Poor Match"}
            </p>
            <div className="mt-3 h-3 w-full rounded-full bg-gray-200">
              <div
                className="h-3 rounded-full bg-blue-600"
                style={{ width: `${analysis.matchScore || 0}%` }}
              />
            </div>

            <h3 className="mt-6 text-xl font-semibold">Candidate Summary</h3>
            <p className="mt-2 text-gray-700 leading-relaxed">{analysis.summary}</p>

            <h3 className="mt-6 text-xl font-semibold">Recommendation</h3>
            <p className="mt-2 text-gray-700 leading-relaxed">{analysis.recommendation}</p>

            {analysis.strengths?.length > 0 && (
              <>
                <h3 className="mt-6 text-xl font-semibold">Standout Strengths</h3>
                <div className="mt-3 space-y-2">
                  {analysis.strengths.map((strength: any, index: number) => (
                    <div key={index} className="rounded-lg bg-green-50 px-4 py-2 text-green-700">
                      ✓ {strength}
                    </div>
                  ))}
                </div>
              </>
            )}

            {analysis.growthAreas?.length > 0 && (
              <>
                <h3 className="mt-6 text-xl font-semibold">Growth Areas</h3>
                <ul className="mt-2 list-disc pl-5 text-gray-700">
                  {analysis.growthAreas.map((area: any, index: number) => (
                    <li key={index}>{area}</li>
                  ))}
                </ul>
              </>
            )}

            <h3 className="mt-6 text-xl font-semibold">Matching Skills</h3>
            <div className="mt-3 flex flex-wrap gap-2">
              {analysis.matchingSkills?.map((skill: any, index: number) => (
                <span key={index} className="rounded-full bg-blue-100 px-3 py-1 text-blue-700">
                  {skill}
                </span>
              ))}
            </div>

            <h3 className="mt-6 text-xl font-semibold">Missing Skills</h3>
            <ul className="mt-2 list-disc pl-5">
              {analysis.missingSkills?.length > 0 ? (
                analysis.missingSkills.map((skill: any, index: number) => (
                  <li key={index}>
                    {typeof skill === "string" ? skill : `${skill.skill} (${skill.importance})`}
                  </li>
                ))
              ) : (
                <li>No major skill gaps detected 🎉</li>
              )}
            </ul>

            {matches && matches.length === 0 && (
              <p className="mt-10 rounded-xl bg-yellow-50 p-4 text-yellow-800">
                No new matching jobs found this time. Jobs that weren&apos;t scored stay
                available for the next search.
              </p>
            )}

            {/* Job Cards */}
            {matches && matches.length > 0 && (
              <div className="mt-10">
                <h2 className="text-3xl font-bold">🎯 Best Job Matches</h2>
                <p className="mt-2 text-gray-600">Ranked by AI based on your CV.</p>

                {/* Batch Apply Bar */}
                <div className="mt-4 flex flex-wrap items-center gap-3 rounded-xl bg-gray-50 p-4">
                  <label className="text-sm font-semibold text-gray-700">
                    Batch apply to top
                  </label>
                  <select
                    value={batchCount}
                    onChange={(e) => setBatchCount(Number(e.target.value))}
                    disabled={batchRunning}
                    className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
                  >
                    {[1, 2, 3, 5, matches.length]
                      .filter((n, i, arr) => n <= matches.length && arr.indexOf(n) === i)
                      .map((n) => (
                        <option key={n} value={n}>{n}</option>
                      ))}
                  </select>
                  <span className="text-sm text-gray-600">matches</span>
                  <button
                    onClick={runBatchApply}
                    disabled={batchRunning}
                    className="rounded-lg bg-emerald-600 px-5 py-2 font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
                  >
                    {batchRunning ? batchProgress || "Running..." : "🚀 Batch Apply"}
                  </button>
                </div>

                {/* Batch Results */}
                {batchResults.length > 0 && (
                  <div className="mt-6 space-y-4">
                    <h3 className="text-xl font-semibold">Batch Results — review before using</h3>
                    <p className="text-sm text-gray-600">
                      These are drafts. Read each one before sending — especially any cover letter describing a specific story.
                    </p>
                    {batchResults.map((result: any, i: number) => (
                      <div key={i} className="rounded-xl border border-gray-200 p-4">
                        <p className="font-semibold text-gray-900">
                          {result.job.title} — {result.job.company}
                        </p>
                        {result.success ? (
                          <>
                            <a
                              href={result.cvUrl}
                              download={result.cvFileName}
                              className="mt-2 inline-block rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700"
                            >
                              Download Tailored CV
                            </a>
                            {result.coverLetter && (
                              <div className="mt-3 rounded-lg bg-gray-50 p-3 text-sm text-gray-700 whitespace-pre-wrap">
                                {result.coverLetter}
                              </div>
                            )}
                            {result.error && (
                              <p className="mt-2 text-sm text-amber-700">⚠️ {result.error}</p>
                            )}
                          </>
                        ) : (
                          <p className="mt-2 text-sm text-red-600">Failed: {result.error}</p>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {/* Individual Job Cards */}
                <div className="mt-6 space-y-6">
                  {matches.map((job: any, index: number) => (
                    <div
                      key={index}
                      className="rounded-2xl border border-gray-200 bg-white p-8 shadow-sm"
                    >
                      <div className="flex justify-between">
                        <div>
                          <h3 className="text-2xl font-bold">{job.title}</h3>
                          <p className="text-gray-600">
                            {job.company} • 📍 {job.location}
                          </p>
                          {job.salaryMin && job.salaryMax && (
                            <p className="mt-2 font-semibold text-green-600">
                              💷 £{job.salaryMin.toLocaleString()} - £{job.salaryMax.toLocaleString()}
                            </p>
                          )}
                          {job.contractType && (
                            <p className="text-sm text-gray-600">
                              📄 {job.contractType.charAt(0).toUpperCase() + job.contractType.slice(1)}
                            </p>
                          )}
                          {job.created && (
                            <p className="text-sm text-gray-500">
                              🕒 Posted: {new Date(job.created).toLocaleDateString()}
                            </p>
                          )}
                        </div>
                        <div className="rounded-xl bg-blue-100 px-5 py-3 text-center">
                          <p className="text-3xl font-bold text-blue-700">
                            {String(job.matchScore)}%
                          </p>
                          <p className="text-sm">{getMatchLabel(job.matchScore)}</p>
                        </div>
                      </div>

                      <div className="mt-5">
                        <h4 className="font-semibold">🤖 AI Recommendation</h4>
                        <p className="mt-2 text-gray-700">{job.reason}</p>
                      </div>

                      {job.breakdown && (
                        <div className="mt-5">
                          <h4 className="font-semibold">📊 AI Compatibility Breakdown</h4>
                          <div className="mt-3 grid grid-cols-2 gap-3">
                            <div className="rounded-lg bg-gray-100 p-3">
                              💻 Technical Skills
                              <p className="font-bold">{job.breakdown.technicalSkills}%</p>
                            </div>
                            <div className="rounded-lg bg-gray-100 p-3">
                              🧑‍💻 Experience Level
                              <p className="font-bold">{job.breakdown.experienceLevel}%</p>
                            </div>
                            <div className="rounded-lg bg-gray-100 p-3">
                              🚀 Projects
                              <p className="font-bold">{job.breakdown.projects}%</p>
                            </div>
                            <div className="rounded-lg bg-gray-100 p-3">
                              📈 Growth Potential
                              <p className="font-bold">{job.breakdown.growthPotential}%</p>
                            </div>
                          </div>
                        </div>
                      )}

                      <div className="mt-5">
                        <h4 className="font-semibold">Why you stand out:</h4>
                        <div className="mt-3 space-y-2">
                          {job.strengths?.map((strength: any, i: number) => (
                            <div
                              key={i}
                              className="rounded-lg bg-green-50 px-4 py-2 text-green-700"
                            >
                              ✓ {strength}
                            </div>
                          ))}
                        </div>
                      </div>

                      {job.missingSkills && job.missingSkills.length > 0 && (
                        <div className="mt-5">
                          <h4 className="font-semibold">Missing Skills</h4>
                          <div className="mt-3 flex flex-wrap gap-2">
                            {job.missingSkills.map((skill: any, i: number) => (
                              <span
                                key={i}
                                className="rounded-full bg-red-100 px-3 py-1 text-red-700"
                              >
                                {typeof skill === "object"
                                  ? `${skill.skill} (${skill.importance})`
                                  : skill}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Action Buttons */}
                      <div className="mt-6 border-t border-gray-100 pt-6">
                        <div className="flex gap-3">
                          <button
                            onClick={() => generateCoverLetter(job, index)}
                            disabled={generatingCoverLetter[index]}
                            className="rounded-lg bg-purple-600 px-5 py-2 font-semibold text-white hover:bg-purple-700 disabled:opacity-50"
                          >
                            {generatingCoverLetter[index]
                              ? "✍️ Generating..."
                              : coverLetters[index]
                              ? "🔄 Regenerate Cover Letter"
                              : "✍️ Generate Cover Letter"}
                          </button>
                          <button
                            onClick={() => generateTailoredCVForJob(job, index)}
                            disabled={tailoringJob[index]}
                            className="rounded-lg bg-indigo-600 px-5 py-2 font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
                          >
                            {tailoringJob[index] ? "📄 Generating CV..." : "📄 Generate Tailored CV"}
                          </button>
                        </div>

                        {/* Application Questions */}
                        <div className="mt-6 rounded-xl bg-gray-50 p-4">
                          <h4 className="font-semibold text-gray-900">📝 Application Questions</h4>
                          <p className="mt-1 text-sm text-gray-600">
                            Paste each application question on its own line.
                          </p>
                          <textarea
                            value={questionInputs[index] || ""}
                            onChange={(e) =>
                              setQuestionInputs((prev) => ({ ...prev, [index]: e.target.value }))
                            }
                            rows={4}
                            placeholder={"Why do you want to work here?\nDescribe a time you solved a technical problem."}
                            className="mt-3 w-full rounded-lg border border-gray-300 p-3 text-sm text-gray-900"
                          />
                          <button
                            onClick={() => answerApplicationQuestions(job, index)}
                            disabled={answeringQuestions[index]}
                            className="mt-3 rounded-lg bg-teal-600 px-5 py-2 font-semibold text-white hover:bg-teal-700 disabled:opacity-50"
                          >
                            {answeringQuestions[index] ? "Answering..." : "Answer Questions"}
                          </button>

                          {questionAnswers[index] && (
                            <div className="mt-4 space-y-4">
                              {questionAnswers[index].map((qa, qIndex) => (
                                <div key={qIndex} className="rounded-lg bg-white p-4 shadow-sm">
                                  <p className="font-semibold text-gray-900">{qa.question}</p>
                                  <p className="mt-2 whitespace-pre-wrap text-gray-700">{qa.answer}</p>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>

                        {/* Cover Letter */}
                        {coverLetters[index] && (
                          <div className="mt-4 rounded-xl bg-gray-50 p-6">
                            <div className="flex items-center justify-between">
                              <h4 className="font-semibold text-gray-900">
                                📄 Cover Letter — {job.company}
                              </h4>
                              <button
                                onClick={() => navigator.clipboard.writeText(coverLetters[index])}
                                className="rounded-lg bg-gray-200 px-3 py-1 text-sm text-gray-700 hover:bg-gray-300"
                              >
                                Copy
                              </button>
                            </div>
                            <div className="mt-4 whitespace-pre-wrap text-gray-700 leading-relaxed">
                              {coverLetters[index]}
                            </div>
                          </div>
                        )}
                      </div>

                      <a
                        href={job.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mt-6 inline-flex rounded-lg bg-blue-600 px-6 py-3 font-semibold text-white"
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