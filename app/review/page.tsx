"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import ApplicationsTabs from "@/app/components/ApplicationsTabs";
import DownloadFileButton from "@/app/components/DownloadFileButton";
import type { ReviewItem } from "@/lib/repositories/review";

type Filter = "pending" | "approved" | "rejected" | "failed" | "withdrawn" | "all";

// How each application status is shown (matching the filter tab names).
const STATUS_LABEL: Record<string, string> = {
  preparing: "Preparing",
  ready_for_review: "To review",
  preparation_failed: "Preparation failed",
  approved: "Approved",
  rejected: "Rejected",
  withdrawn: "Withdrawn",
};
const statusLabel = (status: string) => STATUS_LABEL[status] ?? status;

const REVIEW_FILTER_LABELS = {
  pending: "To review",
  approved: "Approved",
  rejected: "Rejected",
  failed: "Failed",
  withdrawn: "Withdrawn",
  all: "All",
} as const;

export default function ReviewQueue() {
  const [results, setResults] = useState<ReviewItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<Filter>("pending");
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
      const res = await fetch(`/api/applications?status=${filter}`);
      const data = await res.json();
      setResults(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error("Failed to fetch applications:", err);
    } finally {
      setLoading(false);
    }
  }

  // Sends one reviewer action; returns the updated application, or null if
  // it was refused (the reason is shown to the user).
  async function sendAction(id: number, body: Record<string, unknown>): Promise<ReviewItem | null> {
    const res = await fetch(`/api/applications/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || `Update failed (HTTP ${res.status})`);
    }
    return data as ReviewItem;
  }

  async function updateStatus(item: ReviewItem, action: "approve" | "reject" | "withdraw") {
    setSaving((prev) => ({ ...prev, [item.id]: true }));
    try {
      await sendAction(item.id, {
        action,
        note: notes[item.id],
        // Approval confirms exactly the content shown on this card.
        ...(action === "approve" ? { reviewedAssetsSha256: item.assetsHash } : {}),
      });

      // If approved, open the job URL so you can apply yourself.
      if (action === "approve" && item.job.url) {
        window.open(item.job.url, "_blank");
      }
    } catch (err) {
      console.error("Failed to update status:", err);
      alert(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving((prev) => ({ ...prev, [item.id]: false }));
      await fetchResults();
    }
  }

  async function saveCoverLetter(item: ReviewItem) {
    setSaving((prev) => ({ ...prev, [item.id]: true }));
    try {
      const updated = await sendAction(item.id, {
        action: "edit_cover_letter",
        coverLetter: editedCoverLetter,
      });
      setEditingId(null);
      if (item.status === "approved" && updated && updated.status !== "approved") {
        alert("The cover letter changed after approval, so the approval was withdrawn. Review and approve it again.");
      }
      await fetchResults();
    } catch (err) {
      console.error("Failed to save cover letter:", err);
      alert(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving((prev) => ({ ...prev, [item.id]: false }));
    }
  }

  const pendingCount = results.filter((r) => r.status === "ready_for_review").length;

  const statusColour = (status: string) => {
    if (status === "approved") return "bg-green-100 text-green-700";
    if (status === "rejected") return "bg-red-100 text-red-700";
    if (status === "preparation_failed" || status === "withdrawn") return "bg-gray-100 text-gray-500";
    return "bg-yellow-100 text-yellow-700";
  };

  return (
    <main className="w-full py-6 sm:py-8">
      <div className="app-shell">

        {/* Header */}
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-indigo-700">Applications</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight text-slate-900 sm:text-4xl">Ready for your review</h1>
          <p className="mt-2 max-w-3xl text-slate-600">
            Your agent prepared these drafts. Check each one and edit the cover letter if you like. Approve it to open the
            job and apply yourself, or reject it to skip. Nothing is ever submitted for you.
          </p>
        </div>
        <ApplicationsTabs />

        {/* Filter Tabs */}
        <div className="mt-6 flex gap-2 overflow-x-auto pb-1">
          {(["pending", "approved", "rejected", "failed", "withdrawn", "all"] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`min-h-10 shrink-0 rounded-full px-4 text-sm font-medium ring-1 ring-inset transition ${
                filter === f
                  ? "bg-slate-900 text-white ring-slate-900"
                  : "bg-white text-slate-700 ring-slate-300 hover:bg-slate-50"
              }`}
            >
              {REVIEW_FILTER_LABELS[f]}
              {f === "pending" && pendingCount > 0 && filter !== "pending" && (
                <span className="ml-2 rounded-full bg-yellow-400 px-2 py-0.5 text-xs text-white">
                  {pendingCount}
                </span>
              )}
            </button>
          ))}
          <button
            onClick={fetchResults}
            className="ml-auto min-h-10 shrink-0 rounded-lg px-3 text-sm font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900"
          >
            ↻ Refresh
          </button>
        </div>

        {/* Results */}
        <div className="mt-6 grid items-start gap-6 xl:grid-cols-2">
          {loading ? (
            <div className="rounded-2xl bg-white p-8 text-center text-slate-600 ring-1 ring-slate-200/80 xl:col-span-2" role="status">
              Loading your applications…
            </div>
          ) : results.length === 0 ? (
            <div className="rounded-2xl bg-white p-8 text-center ring-1 ring-slate-200/80 xl:col-span-2">
              <p className="text-slate-600">
                {filter === "pending"
                  ? "Nothing is waiting for your review. Prepare an application from your matches and it will appear here."
                  : `No ${filter} applications yet.`}
              </p>
              <Link
                href="/#jobs"
                className="mt-4 inline-flex min-h-11 items-center rounded-lg bg-indigo-600 px-5 font-semibold text-white hover:bg-indigo-500"
              >
                See my matches →
              </Link>
            </div>
          ) : (
            results.map((result) => (
              <div
                key={result.id}
                className="min-w-0 rounded-2xl bg-white p-5 shadow-[0_1px_2px_rgba(15,23,42,0.04)] ring-1 ring-slate-200/80 sm:p-6"
              >
                {/* Job Header */}
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h2 className="text-xl font-bold text-gray-900">
                      {result.job.title}
                    </h2>
                    <p className="text-gray-600">
                      {result.job.company}
                      {result.job.location ? ` · ${result.job.location}` : ""}
                    </p>
                    {result.job.salaryMin && result.job.salaryMax && (
                      <p className="mt-1 font-semibold text-green-600">
                        £{result.job.salaryMin.toLocaleString()} – £{result.job.salaryMax.toLocaleString()}
                      </p>
                    )}
                    <p className="mt-1 text-sm text-gray-500">
                      Saved {new Date(`${result.createdAt.replace(" ", "T")}Z`).toLocaleString()}
                      {result.isLegacyImport ? " • imported from the old review queue" : ""}
                    </p>
                  </div>
                  <div className="flex flex-col items-end gap-2">
                    {result.match?.score != null && (
                      <div className="rounded-xl bg-blue-100 px-4 py-2 text-center">
                        <p className="text-2xl font-bold text-blue-700">
                          {result.match.score}%
                        </p>
                        <p className="text-xs text-blue-600">Match</p>
                      </div>
                    )}
                    <span
                      className={`whitespace-nowrap rounded-full px-3 py-1 text-xs font-semibold ${statusColour(result.status)}`}
                    >
                      {statusLabel(result.status)}
                    </span>
                  </div>
                </div>

                {result.lastError && (
                  <p className="mt-4 rounded-lg bg-amber-50 px-4 py-2 text-sm text-amber-800">
                    {result.lastError}
                  </p>
                )}

                {/* CV Download */}
                {result.cvFile && (
                  <div className="mt-4">
                    <DownloadFileButton
                      href={`/api/applications/${result.id}/assets/${result.cvFile.assetId}`}
                      filename={result.cvFile.filename}
                      className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700"
                    >
                      Download tailored CV
                    </DownloadFileButton>
                  </div>
                )}

                {/* Cover Letter */}
                {result.coverLetter && (
                  <div className="mt-4">
                    <div className="flex items-center justify-between">
                      <h3 className="font-semibold text-gray-900">
                        Cover letter
                        {result.coverLetter.version > 1 && (
                          <span className="ml-2 text-xs font-normal text-gray-500">
                            version {result.coverLetter.version}
                            {result.coverLetter.origin === "user_edit" ? " (edited)" : ""}
                          </span>
                        )}
                      </h3>
                      <div className="flex gap-2">
                        <button
                          onClick={() => navigator.clipboard.writeText(result.coverLetter!.text)}
                          className="rounded-lg bg-gray-100 px-3 py-1 text-xs font-semibold text-gray-600 hover:bg-gray-200"
                        >
                          Copy
                        </button>
                        {editingId !== result.id && (
                          <button
                            onClick={() => {
                              setEditingId(result.id);
                              setEditedCoverLetter(result.coverLetter!.text);
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
                            onClick={() => saveCoverLetter(result)}
                            disabled={saving[result.id]}
                            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
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
                        {result.coverLetter.text}
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
                {result.status === "ready_for_review" && (
                  <div className="mt-4 flex gap-3 border-t border-gray-100 pt-4">
                    <button
                      onClick={() => updateStatus(result, "approve")}
                      disabled={saving[result.id]}
                      className="rounded-lg bg-green-600 px-6 py-2 font-semibold text-white hover:bg-green-700 disabled:opacity-50"
                    >
                      {saving[result.id] ? "..." : "Approve & Open Job"}
                    </button>
                    <button
                      onClick={() => updateStatus(result, "reject")}
                      disabled={saving[result.id]}
                      className="rounded-lg bg-red-100 px-6 py-2 font-semibold text-red-700 hover:bg-red-200 disabled:opacity-50"
                    >
                      Reject
                    </button>
                    {result.job.url && (
                      <a
                        href={result.job.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="rounded-lg bg-gray-100 px-6 py-2 font-semibold text-gray-700 hover:bg-gray-200"
                      >
                        Preview Job
                      </a>
                    )}
                  </div>
                )}

                {result.status === "approved" && (
                  <div className="mt-4 flex gap-3 border-t border-gray-100 pt-4">
                    {result.job.url && (
                      <a
                        href={result.job.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="rounded-lg bg-indigo-600 px-6 py-2 font-semibold text-white hover:bg-indigo-500"
                      >
                        Apply Now →
                      </a>
                    )}
                    <button
                      onClick={() => updateStatus(result, "reject")}
                      disabled={saving[result.id]}
                      className="rounded-lg bg-gray-100 px-4 py-2 text-sm font-semibold text-gray-600 hover:bg-gray-200 disabled:opacity-50"
                    >
                      Move to Rejected
                    </button>
                    <button
                      onClick={() => updateStatus(result, "withdraw")}
                      disabled={saving[result.id]}
                      className="rounded-lg bg-gray-100 px-4 py-2 text-sm font-semibold text-gray-600 hover:bg-gray-200 disabled:opacity-50"
                    >
                      Withdraw
                    </button>
                    <Link
                      href="/applications"
                      className="ml-auto self-center text-sm font-semibold text-blue-700 hover:underline"
                    >
                      Track in Applications →
                    </Link>
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
