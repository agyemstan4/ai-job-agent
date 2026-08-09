"use client";

import { useState } from "react";

export default function Home() {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [structuredCV, setStructuredCV] = useState<any>(null);
  const [tailoringJob, setTailoringJob] = useState<Record<number, boolean>>({});
  const [questionInputs, setQuestionInputs] = useState<Record<number, string>>({});
  const [questionAnswers, setQuestionAnswers] = useState<Record<number, { question: string; answer: string }[]>>({});
  const [answeringQuestions, setAnsweringQuestions] = useState<Record<number, boolean>>({});
  const [analysis, setAnalysis] = useState<any>(null);
  const [matches, setMatches] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [loadingStep, setLoadingStep] = useState("");
  const [coverLetters, setCoverLetters] = useState<Record<number, string>>({});
  const [generatingCoverLetter, setGeneratingCoverLetter] = useState<Record<number, boolean>>({});
  const [selectedRoles, setSelectedRoles] = useState<string[]>(["Junior Software Engineer"]);

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
      // analysis (from analyse-cv) no longer carries education/projects —
      // those were trimmed from that schema earlier. structuredCV (from
      // extract-cv-structured + extract-projects) still has real data for
      // both, so merge it in here rather than let the cover letter
      // silently generate with "undefined" degree / no project detail.
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
      if (data.coverLetter) {
        setCoverLetters((prev) => ({ ...prev, [index]: data.coverLetter }));
      }
    } catch (error) {
      console.error("Cover letter error:", error);
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
    setMatches(null);
    setStructuredCV(null);
    setCoverLetters({});

    try {
      const formData = new FormData();
      formData.append("cv", selectedFile);
      formData.append("roles", JSON.stringify(selectedRoles));

      // Run CV analysis, structured extraction, and project extraction in
      // parallel. Projects are extracted separately (rather than as part
      // of extract-cv-structured) because asking the model to fully
      // preserve multi-bullet project detail alongside everything else in
      // one call led to it condensing/summarising projects down to one
      // line each — a dedicated, narrowly-scoped call gets much better
      // bullet preservation.
      setLoadingStep("🤖 Analysing your CV...");
      const [analysisResponse, extractionResponse, projectsResponse] = await Promise.all([
        fetch("/api/analyse-cv", { method: "POST", body: formData }),
        fetch("/api/extract-cv-structured", { method: "POST", body: formData }),
        fetch("/api/extract-projects", { method: "POST", body: formData }),
      ]);

      const analysisData = await analysisResponse.json();
      const extractionData = await extractionResponse.json();
      const projectsData = await projectsResponse.json();

      if (!analysisResponse.ok) {
        throw new Error(analysisData.details || analysisData.error || "Analysis failed.");
      }

      const candidateAnalysis =
        typeof analysisData.analysis === "string"
          ? JSON.parse(analysisData.analysis)
          : analysisData.analysis;

      setAnalysis(candidateAnalysis);

      if (extractionResponse.ok && extractionData.structuredCV) {
        const mergedStructuredCV = {
          ...extractionData.structuredCV,
          projects: projectsResponse.ok && Array.isArray(projectsData.projects)
            ? projectsData.projects
            : [],
        };
        setStructuredCV(mergedStructuredCV);
      }

      setLoadingStep("🔍 Finding suitable jobs...");

      const jobsResponse = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: selectedRoles[0], location: "London" }),
      });

      const jobsData = await jobsResponse.json();

      if (!Array.isArray(jobsData)) {
        console.error("Jobs API failed:", jobsData);
        return;
      }

      const jobs = jobsData.map((job: any) => ({
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
        body: JSON.stringify({ candidate: candidateAnalysis, jobs }),
      });

      const matchResults = await matchResponse.json();
      setMatches(matchResults.matches);

    } catch (error) {
      console.error(error);
      alert("Something went wrong while analysing your CV.");
    } finally {
      setLoading(false);
      setLoadingStep("");
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
        body: JSON.stringify({ tailoredCV: tailorData.tailoredCV }),
      });

      if (!docxResponse.ok) {
        const errData = await docxResponse.json();
        throw new Error(errData.details || errData.error || "Document generation failed.");
      }

      const blob = await docxResponse.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const safeCompany = (job.company || "Company").replace(/\s+/g, "_");
      a.download = `${(structuredCV.name || "CV").replace(/\s+/g, "_")}_${safeCompany}_CV.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    } catch (error) {
      console.error(error);
      alert("Something went wrong generating the tailored CV. Check console.");
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
      const response = await fetch("/api/application-questions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidate: analysis, job, questions }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.details || data.error || "Answering questions failed.");
      }

      setQuestionAnswers((prev) => ({ ...prev, [index]: data.answers }));
    } catch (error) {
      console.error(error);
      alert("Something went wrong answering the questions. Check console.");
    } finally {
      setAnsweringQuestions((prev) => ({ ...prev, [index]: false }));
    }
  }

  return (
    <main className="min-h-screen bg-gray-100 p-8">
      <div className="mx-auto max-w-6xl">

        <h1 className="text-4xl font-bold text-gray-900">AI Job Agent</h1>
        <p className="mt-2 text-gray-600">
          Upload your CV and let AI analyse it for suitable software jobs.
        </p>

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
            <p className="mt-2 text-3xl font-bold">{analysis.matchScore ?? "N/A"}%</p>
            <p className="mt-2 font-semibold">
              {analysis.matchScore >= 90
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

            {/* Job Cards */}
            {matches && matches.length > 0 && (
              <div className="mt-10">
                <h2 className="text-3xl font-bold">🎯 Best Job Matches</h2>
                <p className="mt-2 text-gray-600">Ranked by AI based on your CV.</p>

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