"use client";

import { useState, useEffect } from "react";
import Link from "next/link";

type BatchResult = {
  id: number;
  batch_run_id: number;
  created_at: string;
  job_title: string;
  job_company: string;
  job_location: string;
  job_url: string;
  job_salary_min: number;
  job_salary_max: number;
  match_score: number;
  match_reason: string;
  cover_letter: string;
  cv_filename: string;
  status: "pending" | "approved" | "rejected" | "failed";
  reviewed_at: string;
  notes: string;
  error: string | null;
};

export default function ReviewQueue() {
  const [results, setResults] = useState<BatchResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"all" | "pending" | "approved" | "rejected" | "failed">("pending");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editedCoverLetter, setEditedCoverLetter] = useState("");
  const [saving, setSaving] = useState<Record<number, boolean>>({});
  const [notes, setNotes] = useState<Record<number, string>>({});

  useEffect(() => {
    fetchResults();
  }, [filter]);

  async function fetchResults() {
    setLoading(true);
    try {
      const url =
        filter === "all"
          ? "/api/batch-results"
          : `/api/batch-results?status=${filter}`;
      const res = await fetch(url);
      const data = await res.json();
      setResults(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error("Failed to fetch results:", err);
    } finally {
      setLoading(false);
    }
  }

  async function updateStatus(id: number, status: "approved" | "rejected") {
    setSaving((prev) => ({ ...prev, [id]: true }));
    try {
      const res = await fetch(`/api/batch-results/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status, notes: notes[id] }),
      });
      if (!res.ok) {
        throw new Error(`Status update failed (HTTP ${res.status})`);
      }

      // If approved, open the job URL so you can apply immediately
      if (status === "approved") {
        const result = results.find((r) => r.id === id);
        if (result?.job_url) {
          window.open(result.job_url, "_blank");
        }
      }

      await fetchResults();
    } catch (err) {
      console.error("Failed to update status:", err);
      alert(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving((prev) => ({ ...prev, [id]: false }));
    }
  }

  async function saveCoverLetter(id: number) {
    setSaving((prev) => ({ ...prev, [id]: true }));
    try {
      const res = await fetch(`/api/batch-results/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ coverLetter: editedCoverLetter }),
      });
      if (!res.ok) {
        throw new Error(`Saving the cover letter failed (HTTP ${res.status})`);
      }
      setEditingId(null);
      await fetchResults();
    } catch (err) {
      console.error("Failed to save cover letter:", err);
      alert(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving((prev) => ({ ...prev, [id]: false }));
    }
  }

  const pendingCount = results.filter((r) => r.status === "pending").length;

  const statusColour = (status: string) => {
    if (status === "approved") return "bg-green-100 text-green-700";
    if (status === "rejected") return "bg-red-100 text-red-700";
    if (status === "failed") return "bg-gray-100 text-gray-500";
    return "bg-yellow-100 text-yellow-700";
  };

  return (
    <main className="min-h-screen bg-gray-100 p-8">
      <div className="mx-auto max-w-5xl">

        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-4xl font-bold text-gray-900">Review Queue</h1>
            <p className="mt-1 text-gray-600">
              Approve to open the job and apply. Reject to skip. Edit cover letters before approving.
            </p>
          </div>
          <Link
            href="/"
            className="rounded-lg bg-gray-800 px-4 py-2 text-sm font-semibold text-white hover:bg-gray-700"
          >
            ← Back to Agent
          </Link>
        </div>

        {/* Filter Tabs */}
        <div className="mt-6 flex gap-2">
          {(["pending", "approved", "rejected", "failed", "all"] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`rounded-full px-4 py-2 text-sm font-semibold capitalize transition ${
                filter === f
                  ? "bg-blue-600 text-white"
                  : "bg-white text-gray-600 hover:bg-gray-50"
              }`}
            >
              {f}
              {f === "pending" && pendingCount > 0 && filter !== "pending" && (
                <span className="ml-2 rounded-full bg-yellow-400 px-2 py-0.5 text-xs text-white">
                  {pendingCount}
                </span>
              )}
            </button>
          ))}
          <button
            onClick={fetchResults}
            className="ml-auto rounded-lg bg-white px-4 py-2 text-sm font-semibold text-gray-600 hover:bg-gray-50"
          >
            🔄 Refresh
          </button>
        </div>

        {/* Results */}
        <div className="mt-6 space-y-6">
          {loading ? (
            <div className="rounded-xl bg-white p-8 text-center text-gray-500 shadow">
              Loading...
            </div>
          ) : results.length === 0 ? (
            <div className="rounded-xl bg-white p-8 text-center shadow">
              <p className="text-gray-500">
                {filter === "pending"
                  ? "No pending results. Run a batch from the main page first."
                  : `No ${filter} results yet.`}
              </p>
              <Link
                href="/"
                className="mt-4 inline-block rounded-lg bg-blue-600 px-5 py-2 font-semibold text-white hover:bg-blue-700"
              >
                Go run a batch →
              </Link>
            </div>
          ) : (
            results.map((result) => (
              <div
                key={result.id}
                className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm"
              >
                {/* Job Header */}
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h2 className="text-xl font-bold text-gray-900">
                      {result.job_title}
                    </h2>
                    <p className="text-gray-600">
                      {result.job_company}
                      {result.job_location ? ` • 📍 ${result.job_location}` : ""}
                    </p>
                    {result.job_salary_min && result.job_salary_max && (
                      <p className="mt-1 font-semibold text-green-600">
                        💷 £{result.job_salary_min.toLocaleString()} – £{result.job_salary_max.toLocaleString()}
                      </p>
                    )}
                    <p className="mt-1 text-sm text-gray-500">
                      Saved {new Date(result.created_at).toLocaleString()}
                    </p>
                  </div>
                  <div className="flex flex-col items-end gap-2">
                    {result.match_score && (
                      <div className="rounded-xl bg-blue-100 px-4 py-2 text-center">
                        <p className="text-2xl font-bold text-blue-700">
                          {result.match_score}%
                        </p>
                        <p className="text-xs text-blue-600">Match</p>
                      </div>
                    )}
                    <span
                      className={`rounded-full px-3 py-1 text-xs font-semibold capitalize ${statusColour(result.status)}`}
                    >
                      {result.status}
                    </span>
                  </div>
                </div>

                {result.error && (
                  <p className="mt-4 rounded-lg bg-amber-50 px-4 py-2 text-sm text-amber-800">
                    ⚠️ {result.error}
                  </p>
                )}

                {/* CV Download */}
                {result.cv_filename && (
                  <div className="mt-4">
                    <a
                      href={`/api/batch-results/${result.id}`}
                      download={result.cv_filename}
                      className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700"
                    >
                      📄 Download Tailored CV
                    </a>
                  </div>
                )}

                {/* Cover Letter */}
                {result.cover_letter && (
                  <div className="mt-4">
                    <div className="flex items-center justify-between">
                      <h3 className="font-semibold text-gray-900">✍️ Cover Letter</h3>
                      <div className="flex gap-2">
                        <button
                          onClick={() => navigator.clipboard.writeText(result.cover_letter)}
                          className="rounded-lg bg-gray-100 px-3 py-1 text-xs font-semibold text-gray-600 hover:bg-gray-200"
                        >
                          Copy
                        </button>
                        {editingId !== result.id && (
                          <button
                            onClick={() => {
                              setEditingId(result.id);
                              setEditedCoverLetter(result.cover_letter);
                            }}
                            className="rounded-lg bg-gray-100 px-3 py-1 text-xs font-semibold text-gray-600 hover:bg-gray-200"
                          >
                            Edit
                          </button>
                        )}
                      </div>
                    </div>

                    {editingId === result.id ? (
                      <div className="mt-2">
                        <textarea
                          value={editedCoverLetter}
                          onChange={(e) => setEditedCoverLetter(e.target.value)}
                          rows={12}
                          className="w-full rounded-lg border border-gray-300 p-3 text-sm text-gray-900"
                        />
                        <div className="mt-2 flex gap-2">
                          <button
                            onClick={() => saveCoverLetter(result.id)}
                            disabled={saving[result.id]}
                            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
                          >
                            {saving[result.id] ? "Saving..." : "Save"}
                          </button>
                          <button
                            onClick={() => setEditingId(null)}
                            className="rounded-lg bg-gray-200 px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-300"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="mt-2 rounded-lg bg-gray-50 p-4 text-sm text-gray-700 whitespace-pre-wrap leading-relaxed">
                        {result.cover_letter}
                      </div>
                    )}
                  </div>
                )}

                {/* Notes */}
                <div className="mt-4">
                  <textarea
                    value={notes[result.id] ?? result.notes ?? ""}
                    onChange={(e) =>
                      setNotes((prev) => ({ ...prev, [result.id]: e.target.value }))
                    }
                    rows={2}
                    placeholder="Add notes (optional)..."
                    className="w-full rounded-lg border border-gray-200 p-2 text-sm text-gray-700"
                  />
                </div>

                {/* Action Buttons */}
                {result.status === "pending" && (
                  <div className="mt-4 flex gap-3 border-t border-gray-100 pt-4">
                    <button
                      onClick={() => updateStatus(result.id, "approved")}
                      disabled={saving[result.id]}
                      className="rounded-lg bg-green-600 px-6 py-2 font-semibold text-white hover:bg-green-700 disabled:opacity-50"
                    >
                      {saving[result.id] ? "..." : "✅ Approve & Open Job"}
                    </button>
                    <button
                      onClick={() => updateStatus(result.id, "rejected")}
                      disabled={saving[result.id]}
                      className="rounded-lg bg-red-100 px-6 py-2 font-semibold text-red-700 hover:bg-red-200 disabled:opacity-50"
                    >
                      ❌ Reject
                    </button>
                    {result.job_url && (
                      <a
                        href={result.job_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="rounded-lg bg-gray-100 px-6 py-2 font-semibold text-gray-700 hover:bg-gray-200"
                      >
                        👀 Preview Job
                      </a>
                    )}
                  </div>
                )}

                {result.status === "approved" && (
                  <div className="mt-4 flex gap-3 border-t border-gray-100 pt-4">
                    <a
                      href={result.job_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="rounded-lg bg-blue-600 px-6 py-2 font-semibold text-white hover:bg-blue-700"
                    >
                      Apply Now →
                    </a>
                    <button
                      onClick={() => updateStatus(result.id, "rejected")}
                      className="rounded-lg bg-gray-100 px-4 py-2 text-sm font-semibold text-gray-600 hover:bg-gray-200"
                    >
                      Move to Rejected
                    </button>
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </main>
  );
}