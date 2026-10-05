"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import ApplicationsTabs from "@/app/components/ApplicationsTabs";
import DownloadFileButton from "@/app/components/DownloadFileButton";
import type { ReviewItem } from "@/lib/repositories/review";
import {
  buildMarkSubmittedRequest,
  buildReferenceRequest,
  buildStatusUpdateRequest,
  callApi,
  formatStored,
  initialMarkAppliedForm,
  initialStatusUpdateForm,
  minInputValue,
  patchApplication,
  statusLabel,
  toLocalInputValue,
  TRACKER_TABS,
} from "@/lib/tracker-client";
import type { MarkAppliedForm, StatusUpdateForm, TrackerTab } from "@/lib/tracker-client";

// The application tracker. Review and approval stay on /review.
//
//   Approved → "Apply Now" (opens the employer's site, nothing else)
//            → you submit the application there yourself
//            → "Mark as applied" (explicit, confirmed) → later status updates
//
// Nothing on this page submits an application or sends anything.

const EMPTY_MESSAGES: Record<TrackerTab, string> = {
  to_apply: "No approved applications are waiting. Approve applications in Ready for review first.",
  applied: "No applications marked as applied yet.",
  closed: "No closed applications.",
  tracked: "Nothing tracked yet.",
};

const statusColour = (status: string) => {
  if (status === "approved") return "bg-green-100 text-green-700";
  if (status === "offer") return "bg-emerald-100 text-emerald-800";
  if (status === "interviewing") return "bg-purple-100 text-purple-700";
  if (status === "unsuccessful" || status === "withdrawn") return "bg-gray-100 text-gray-600";
  return "bg-blue-100 text-blue-700"; // submitted, acknowledged
};

export default function ApplicationsTracker() {
  const [tab, setTab] = useState<TrackerTab>("to_apply");
  const [items, setItems] = useState<ReviewItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const data = await callApi<ReviewItem[]>(`/api/applications?status=${tab}`);
        if (!cancelled) setItems(Array.isArray(data) ? data : []);
      } catch (err) {
        if (!cancelled) {
          setItems([]);
          setError(err instanceof Error ? err.message : "Could not load applications.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [tab, reloadKey]);

  const refresh = () => setReloadKey((key) => key + 1);

  return (
    <main className="w-full py-6 sm:py-8">
      <div className="app-shell">
        {/* Header */}
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-indigo-700">Applications</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight text-slate-900 sm:text-4xl">Your applications</h1>
          <p className="mt-2 max-w-3xl text-slate-600">
            &ldquo;Apply Now&rdquo; only opens the employer&rsquo;s site. After you have submitted the application
            there yourself, use &ldquo;Mark as applied&rdquo; to record it, then track the response here. Nothing is ever submitted for you.
          </p>
        </div>
        <ApplicationsTabs />

        {/* Tabs */}
        <div className="mt-6 flex gap-2 overflow-x-auto pb-1">
          {TRACKER_TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`min-h-10 shrink-0 rounded-full px-4 text-sm font-medium ring-1 ring-inset transition ${
                tab === t.key ? "bg-slate-900 text-white ring-slate-900" : "bg-white text-slate-700 ring-slate-300 hover:bg-slate-50"
              }`}
            >
              {t.label}
            </button>
          ))}
          <button
            onClick={refresh}
            className="ml-auto min-h-10 shrink-0 rounded-lg px-3 text-sm font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900"
          >
            ↻ Refresh
          </button>
        </div>

        {/* Content */}
        <div className="mt-6 grid items-start gap-6 xl:grid-cols-2">
          {loading ? (
            <div className="rounded-2xl bg-white p-8 text-center text-slate-600 ring-1 ring-slate-200/80 xl:col-span-2" role="status">Loading your applications…</div>
          ) : error ? (
            <div className="rounded-2xl bg-white p-8 text-center ring-1 ring-slate-200/80 xl:col-span-2" role="alert">
              <p className="font-medium text-rose-800">{error}</p>
              <button
                onClick={refresh}
                className="mt-4 rounded-lg bg-indigo-600 px-5 py-2 font-semibold text-white hover:bg-indigo-500"
              >
                Try again
              </button>
            </div>
          ) : items.length === 0 ? (
            <div className="rounded-2xl bg-white p-8 text-center ring-1 ring-slate-200/80 xl:col-span-2">
              <p className="text-slate-600">{EMPTY_MESSAGES[tab]}</p>
              {tab === "to_apply" && (
                <Link
                  href="/review"
                  className="mt-4 inline-block rounded-lg bg-indigo-600 px-5 py-2 font-semibold text-white hover:bg-indigo-500"
                >
                  See applications ready for review →
                </Link>
              )}
            </div>
          ) : (
            items.map((item) => <TrackerCard key={item.id} item={item} onChanged={refresh} />)
          )}
        </div>
      </div>
    </main>
  );
}

function TrackerCard({ item, onChanged }: { item: ReviewItem; onChanged: () => void }) {
  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
      {/* Job header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-gray-900">{item.job.title}</h2>
          <p className="text-gray-600">
            {item.job.company}
            {item.job.location ? ` · ${item.job.location}` : ""}
          </p>
          {item.job.salaryMin && item.job.salaryMax && (
            <p className="mt-1 font-semibold text-green-600">
              £{item.job.salaryMin.toLocaleString()} – £{item.job.salaryMax.toLocaleString()}
            </p>
          )}
          <p className="mt-1 text-sm text-gray-500">Approved {formatStored(item.approvedAt)}</p>
        </div>
        <div className="flex flex-col items-end gap-2">
          {item.match?.score != null && (
            <div className="rounded-xl bg-blue-100 px-4 py-2 text-center">
              <p className="text-2xl font-bold text-blue-700">{item.match.score}%</p>
              <p className="text-xs text-blue-600">Match</p>
            </div>
          )}
          <span className={`rounded-full px-3 py-1 text-xs font-semibold ${statusColour(item.status)}`}>
            {statusLabel(item.status)}
          </span>
        </div>
      </div>

      {item.notes && (
        <p className="mt-4 rounded-lg bg-gray-50 px-4 py-2 text-sm text-gray-700">
          <span className="font-semibold">Latest note:</span> {item.notes}
        </p>
      )}

      <ApprovedAssets item={item} />

      {item.status === "approved" ? (
        <div className="mt-4 border-t border-gray-100 pt-4">
          <div className="flex flex-wrap items-center gap-3">
            <ApplyNowLink url={item.job.url} />
            <span className="text-sm text-gray-500">Opens the employer&rsquo;s site. It does not record anything.</span>
          </div>
          <MarkAppliedPanel item={item} onDone={onChanged} />
        </div>
      ) : (
        <SubmissionDetails item={item} onChanged={onChanged} />
      )}
    </div>
  );
}

/** "Apply Now": a plain link to the employer's site. It records nothing and calls nothing. */
function ApplyNowLink({ url }: { url: string | null }) {
  if (!url) return <span className="text-sm text-gray-500">No link to the job is available.</span>;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex min-h-11 items-center justify-center rounded-lg bg-indigo-600 px-6 py-2 font-semibold text-white hover:bg-indigo-500"
    >
      Apply Now ↗
    </a>
  );
}

function ApprovedAssets({ item }: { item: ReviewItem }) {
  if (!item.cvFile && !item.coverLetter) return null;
  const locked = item.status !== "approved";
  return (
    <div className="mt-4 rounded-lg border border-gray-200 p-4">
      <h3 className="text-sm font-semibold text-gray-900">
        Approved Job Agent documents{locked ? " (locked)" : ""}
      </h3>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        {item.cvFile && (
          <DownloadFileButton
            href={`/api/applications/${item.id}/assets/${item.cvFile.assetId}`}
            filename={item.cvFile.filename}
            className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700"
          >
            Download tailored CV
          </DownloadFileButton>
        )}
      </div>
      {item.coverLetter && (
        <details className="mt-3">
          <summary className="cursor-pointer text-sm font-semibold text-gray-700">Cover letter</summary>
          <div className="mt-2 rounded-lg bg-gray-50 p-4 text-sm leading-relaxed whitespace-pre-wrap text-gray-700">
            {item.coverLetter.text}
          </div>
        </details>
      )}
    </div>
  );
}

function MarkAppliedPanel({ item, onDone }: { item: ReviewItem; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<MarkAppliedForm>(() => initialMarkAppliedForm());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const update = (patch: Partial<MarkAppliedForm>) => setForm((f) => ({ ...f, ...patch }));

  if (!open) {
    return (
      <div className="mt-4">
        <button
          onClick={() => {
            setForm(initialMarkAppliedForm());
            setError(null);
            setOpen(true);
          }}
          className="rounded-lg bg-green-600 px-6 py-2 font-semibold text-white hover:bg-green-700"
        >
          Mark as applied…
        </button>
        <p className="mt-1 text-sm text-gray-500">Use this only after you have submitted the application yourself.</p>
      </div>
    );
  }

  async function confirm() {
    const built = buildMarkSubmittedRequest(item, form);
    if (!built.ok) {
      setError(built.error);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await patchApplication(item.id, built.body);
      setOpen(false);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not record the application.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-4 rounded-xl border border-green-200 bg-green-50 p-4">
      <h3 className="font-semibold text-gray-900">Mark as applied</h3>
      <p className="mt-1 text-sm text-gray-600">
        Record that you have already submitted this application on the employer&rsquo;s site. This is permanent: if it
        was a mistake, you can later move it to Withdrawn with a note.
      </p>

      <label className="mt-3 flex items-start gap-2 text-sm text-gray-800">
        <input
          type="checkbox"
          checked={form.confirmed}
          onChange={(e) => update({ confirmed: e.target.checked })}
          className="mt-1"
        />
        <span>I have submitted this application on the employer&rsquo;s site.</span>
      </label>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="text-sm text-gray-700">
          Applied at (your local time)
          <input
            type="datetime-local"
            value={form.appliedAtInput}
            min={item.approvedAt ? minInputValue(item.approvedAt) : undefined}
            max={toLocalInputValue(new Date())}
            onChange={(e) => update({ appliedAtInput: e.target.value, dateEdited: true })}
            className="mt-1 w-full rounded-lg border border-gray-300 p-2 text-gray-900"
          />
          <span className="text-xs text-gray-500">Defaults to now. Earlier is fine; not before the approval.</span>
        </label>
        <label className="text-sm text-gray-700">
          Application reference (optional)
          <input
            type="text"
            value={form.reference}
            maxLength={200}
            onChange={(e) => update({ reference: e.target.value })}
            placeholder="e.g. a confirmation number"
            className="mt-1 w-full rounded-lg border border-gray-300 p-2 text-gray-900"
          />
        </label>
      </div>

      <fieldset className="mt-3 text-sm text-gray-700">
        <legend className="font-medium">What did you submit?</legend>
        <label className="mt-1 flex items-center gap-2">
          <input type="radio" checked={!form.modifiedExternally} onChange={() => update({ modifiedExternally: false })} />
          The approved CV and cover letter, as approved
        </label>
        <label className="mt-1 flex items-center gap-2">
          <input type="radio" checked={form.modifiedExternally} onChange={() => update({ modifiedExternally: true })} />
          I changed something on the employer&rsquo;s site
        </label>
        {form.modifiedExternally && (
          <textarea
            value={form.externalChanges}
            onChange={(e) => update({ externalChanges: e.target.value })}
            rows={2}
            placeholder="What did you change? (required)"
            className="mt-2 w-full rounded-lg border border-gray-300 p-2 text-gray-900"
          />
        )}
      </fieldset>

      <label className="mt-3 block text-sm text-gray-700">
        Note (optional)
        <textarea
          value={form.note}
          onChange={(e) => update({ note: e.target.value })}
          rows={2}
          className="mt-1 w-full rounded-lg border border-gray-300 p-2 text-gray-900"
        />
      </label>

      {error && <p className="mt-3 rounded-lg bg-amber-50 px-4 py-2 text-sm text-amber-800">{error}</p>}

      <div className="mt-4 flex gap-2">
        <button
          onClick={confirm}
          disabled={!form.confirmed || saving}
          className="rounded-lg bg-green-600 px-5 py-2 text-sm font-semibold text-white hover:bg-green-700 disabled:opacity-50"
        >
          {saving ? "Saving..." : "Confirm: I have applied"}
        </button>
        <button
          onClick={() => setOpen(false)}
          disabled={saving}
          className="rounded-lg bg-gray-200 px-5 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-300"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function SubmissionDetails({ item, onChanged }: { item: ReviewItem; onChanged: () => void }) {
  const submission = item.submission;
  return (
    <div className="mt-4 space-y-4 border-t border-gray-100 pt-4">
      {submission && (
        <div className="grid gap-2 text-sm text-gray-700 sm:grid-cols-2">
          <p>
            <span className="font-semibold">Applied:</span> {formatStored(submission.submittedAt)} ({submission.method ?? "—"})
          </p>
          <p>
            <span className="font-semibold">Recorded:</span> {formatStored(submission.recordedAt)}
          </p>
          <p className="sm:col-span-2">
            <span className="font-semibold">What you submitted:</span>{" "}
            {submission.submittedContent === "modified_externally"
              ? `changed on the employer's site — ${submission.externalChanges ?? ""}`
              : submission.submittedContent === "as_approved"
                ? "the approved documents, as approved"
                : "not recorded"}
          </p>
        </div>
      )}

      {item.job.url && (
        <a href={item.job.url} target="_blank" rel="noopener noreferrer" className="text-sm font-semibold text-blue-700 hover:underline">
          View the job posting ↗
        </a>
      )}

      {submission && <ReferenceEditor item={item} onDone={onChanged} />}
      {item.nextStatuses.length > 0 && <StatusUpdatePanel item={item} onDone={onChanged} />}
      <Timeline item={item} />
    </div>
  );
}

function ReferenceEditor({ item, onDone }: { item: ReviewItem; onDone: () => void }) {
  const current = item.submission?.reference ?? null;
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(current ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const built = buildReferenceRequest(value);
    if (!built.ok) {
      setError(built.error);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await patchApplication(item.id, built.body);
      setEditing(false);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the reference.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="text-sm text-gray-700">
      {editing ? (
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="text"
            value={value}
            maxLength={200}
            onChange={(e) => setValue(e.target.value)}
            placeholder="Application reference (leave empty to remove)"
            className="w-72 rounded-lg border border-gray-300 p-2 text-gray-900"
          />
          <button
            onClick={save}
            disabled={saving}
            className="rounded-lg bg-indigo-600 px-4 py-2 font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
          >
            {saving ? "Saving..." : "Save reference"}
          </button>
          <button
            onClick={() => setEditing(false)}
            className="rounded-lg bg-gray-200 px-4 py-2 font-semibold text-gray-700 hover:bg-gray-300"
          >
            Cancel
          </button>
        </div>
      ) : (
        <p>
          <span className="font-semibold">Reference:</span> {current ?? "none"}{" "}
          <button
            onClick={() => {
              setValue(current ?? "");
              setError(null);
              setEditing(true);
            }}
            className="ml-2 rounded-lg bg-gray-100 px-3 py-1 text-xs font-semibold text-gray-600 hover:bg-gray-200"
          >
            {current ? "Edit" : "Add"}
          </button>
        </p>
      )}
      {error && <p className="mt-2 rounded-lg bg-amber-50 px-4 py-2 text-amber-800">{error}</p>}
      {item.referenceHistory.length > 0 && (
        <ul className="mt-2 list-disc pl-5 text-xs text-gray-500">
          {item.referenceHistory.map((change) => (
            <li key={change.eventId}>
              {formatStored(change.recordedAt)}: {change.from ?? "none"} → {change.to ?? "none"}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function StatusUpdatePanel({ item, onDone }: { item: ReviewItem; onDone: () => void }) {
  const [form, setForm] = useState<StatusUpdateForm>(initialStatusUpdateForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const update = (patch: Partial<StatusUpdateForm>) => setForm((f) => ({ ...f, ...patch }));
  const withdrawing = form.to === "withdrawn";

  async function save() {
    const built = buildStatusUpdateRequest(item, form);
    if (!built.ok) {
      setError(built.error);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await patchApplication(item.id, built.body);
      setForm(initialStatusUpdateForm());
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update the status.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-xl border border-gray-200 p-4">
      <h3 className="text-sm font-semibold text-gray-900">Update status</h3>
      <div className="mt-2 grid gap-3 sm:grid-cols-2">
        <label className="text-sm text-gray-700">
          New status
          <select
            value={form.to}
            onChange={(e) => update({ to: e.target.value })}
            className="mt-1 w-full rounded-lg border border-gray-300 p-2 text-gray-900"
          >
            <option value="">Choose…</option>
            {item.nextStatuses.map((status) => (
              <option key={status} value={status}>
                {statusLabel(status)}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm text-gray-700">
          When did this happen? (optional)
          <input
            type="datetime-local"
            value={form.occurredAtInput}
            min={item.submission ? minInputValue(item.submission.submittedAt) : undefined}
            max={toLocalInputValue(new Date())}
            onChange={(e) => update({ occurredAtInput: e.target.value })}
            className="mt-1 w-full rounded-lg border border-gray-300 p-2 text-gray-900"
          />
        </label>
      </div>
      <label className="mt-3 block text-sm text-gray-700">
        {withdrawing ? "Reason for withdrawing (required)" : "Note (optional)"}
        <textarea
          value={form.note}
          onChange={(e) => update({ note: e.target.value })}
          rows={2}
          placeholder={withdrawing ? "e.g. accepted another offer, or marked as applied by mistake" : ""}
          className={`mt-1 w-full rounded-lg border p-2 text-gray-900 ${withdrawing ? "border-amber-400" : "border-gray-300"}`}
        />
      </label>
      {withdrawing && (
        <p className="mt-1 text-xs text-gray-500">Withdrawn is final. Your reason is kept with the application.</p>
      )}
      {error && <p className="mt-3 rounded-lg bg-amber-50 px-4 py-2 text-sm text-amber-800">{error}</p>}
      <button
        onClick={save}
        disabled={saving || !form.to}
        className="mt-3 rounded-lg bg-indigo-600 px-5 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
      >
        {saving ? "Saving..." : "Save status"}
      </button>
    </div>
  );
}

function Timeline({ item }: { item: ReviewItem }) {
  // From approval onward; earlier steps belong to preparation and review.
  const start = item.statusHistory.findIndex((entry) => entry.toStatus === "approved");
  const entries = (start >= 0 ? item.statusHistory.slice(start) : item.statusHistory).filter(
    (entry) => entry.toStatus !== "submitting"
  );
  if (entries.length === 0) return null;
  return (
    <div>
      <h3 className="text-sm font-semibold text-gray-900">History</h3>
      <ol className="mt-2 space-y-1 text-sm text-gray-700">
        {entries.map((entry) => (
          <li key={entry.eventId}>
            <span className="font-medium">{statusLabel(entry.toStatus)}</span> —{" "}
            {entry.occurredAt ? (
              <>
                {formatStored(entry.occurredAt)}{" "}
                <span className="text-xs text-gray-500">(recorded {formatStored(entry.recordedAt)})</span>
              </>
            ) : (
              formatStored(entry.recordedAt)
            )}
            <span className="text-xs text-gray-500"> · {entry.actor === "user" ? "you" : entry.actor}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
