"use client";

import { useState } from "react";

export default function Home() {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [analysis, setAnalysis] = useState<any>(null);
  const [loading, setLoading] = useState(false);

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
    setAnalysis(null);

    try {
      const formData = new FormData();
      formData.append("cv", selectedFile);
      formData.append(
  "roles",
  JSON.stringify(selectedRoles)
);

      const controller = new AbortController();

      const timeout = setTimeout(() => {
      controller.abort();
      },  180000); // 3 minutes

const response = await fetch("/api/analyse-cv", {
  method: "POST",
  body: formData,
  signal: controller.signal,
});

clearTimeout(timeout);

      const data = await response.json();

      setAnalysis(JSON.parse(data.analysis));
      
      
       console.log("Server response:", data);

      if (!response.ok) {
        throw new Error(data.details || data.error || "Analysis failed.");
      }

      
    } catch (error) {
      console.error(error);
      alert("Something went wrong while analysing your CV.");
    } finally {
      setLoading(false);
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
        <div className="mt-8 rounded-xl bg-white p-6 shadow">

          <h2 className="text-2xl font-semibold">
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

        <div className="mt-6 rounded-xl bg-white p-6 shadow">

          <h2 className="text-2xl font-semibold">
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
                    : "bg-gray-200 hover:bg-gray-300"
                }`}
              >
                {role}
              </button>
            ))}

          </div>

        </div>

        {/* Analyse Button */}

        <button
          onClick={analyseCV}
          disabled={loading}
          className="mt-6 w-full rounded-lg bg-blue-600 px-5 py-3 font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {loading ? "Analysing CV..." : "Find Suitable Jobs"}
        </button>

                {/* AI Output */}

        {analysis && (
          <div className="mt-8 rounded-xl bg-white p-6 shadow">

            <h2 className="text-2xl font-semibold">
              AI Analysis
            </h2>

            <div className="mt-6">

              <h3 className="text-xl font-semibold">
                Candidate Summary
              </h3>

              <p className="mt-2 text-gray-700">
                {analysis.summary}
              </p>


              <h3 className="mt-6 text-xl font-semibold">
                Technical Skills
              </h3>

              <div className="mt-3 flex flex-wrap gap-2">
                {analysis.skills.map((skill: string) => (
                  <span
                    key={skill}
                    className="rounded-full bg-blue-100 px-3 py-1 text-blue-700"
                  >
                    {skill}
                  </span>
                ))}
              </div>


              <h3 className="mt-6 text-xl font-semibold">
                Recommended Roles
              </h3>

              <ul className="mt-2 list-disc pl-5 text-gray-700">
                {analysis.recommendedRoles.map((role: string) => (
                  <li key={role}>
                    {role}
                  </li>
                ))}
              </ul>


              <h3 className="mt-6 text-xl font-semibold">
                Missing Skills
              </h3>

              <ul className="mt-2 list-disc pl-5 text-gray-700">
                {analysis.missingSkills.map((skill: string) => (
                  <li key={skill}>
                    {skill}
                  </li>
                ))}
              </ul>


              <h3 className="mt-6 text-xl font-semibold">
                CV Improvements
              </h3>

              <ul className="mt-2 list-disc pl-5 text-gray-700">
                {analysis.cvImprovements.map((item: string) => (
                  <li key={item}>
                    {item}
                  </li>
                ))}
              </ul>

            </div>

          </div>
        )}

      </div>
    </main>
  );
}