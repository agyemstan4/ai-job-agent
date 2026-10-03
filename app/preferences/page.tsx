"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { SearchPreferences } from "@/lib/pipeline/preferences";
import {
  clearPreferences,
  EMPTY_PREFERENCES_FORM,
  formFromPreferences,
  loadPreferences,
  otherFieldErrors,
  savePreferences,
} from "@/lib/preferences-client";
import type { LoadResult, PreferenceField, PreferencesForm, SaveResult } from "@/lib/preferences-client";

// Search preferences (Phase 3 checkpoint 3b-5b): edit what job discovery
// searches for, through the existing GET/PUT /api/preferences. Saving only
// changes your preferences; nothing here searches, applies or sends anything.

type Message = { kind: "success" | "error" | "info"; text: string };

const MESSAGE_STYLES: Record<Message["kind"], string> = {
  success: "border-emerald-200 bg-emerald-50 text-emerald-800",
  error: "border-red-200 bg-red-50 text-red-800",
  info: "border-blue-200 bg-blue-50 text-blue-800",
};

const inputClass = (invalid: boolean) =>
  `mt-1 w-full rounded-lg border p-2 text-gray-900 ${invalid ? "border-red-400 bg-red-50" : "border-gray-300"} disabled:bg-gray-100`;

export default function PreferencesPage() {
  const [loading, setLoading] = useState(true);
  const [noCandidate, setNoCandidate] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saved, setSaved] = useState<SearchPreferences | null>(null);
  const [form, setForm] = useState<PreferencesForm>(EMPTY_PREFERENCES_FORM);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<Message | null>(null);
  const [busy, setBusy] = useState<"saving" | "clearing" | null>(null);

  function applyLoad(result: LoadResult) {
    if (result.kind === "loaded") {
      setNoCandidate(null);
      setLoadError(null);
      setSaved(result.preferences);
      setForm(formFromPreferences(result.preferences));
      setMessage(result.warning ? { kind: "error", text: result.warning } : null);
    } else if (result.kind === "no_candidate") {
      setNoCandidate(result.message);
    } else {
      setLoadError(result.message);
    }
    setLoading(false);
  }

  // Load once when the page opens (the same pattern as /applications).
  useEffect(() => {
    let cancelled = false;
    loadPreferences().then((result) => {
      if (!cancelled) applyLoad(result);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function retry() {
    setLoading(true);
    setLoadError(null);
    applyLoad(await loadPreferences());
  }

  function handleResult(result: SaveResult, successText: string) {
    if (result.kind === "saved") {
      setSaved(result.preferences);
      setForm(formFromPreferences(result.preferences));
      setFieldErrors({});
      setMessage({ kind: "success", text: successText });
    } else if (result.kind === "invalid") {
      setFieldErrors(result.fieldErrors as Record<string, string>);
      setMessage({ kind: "error", text: result.message });
    } else if (result.kind === "no_candidate") {
      setNoCandidate(result.message);
    } else {
      setMessage({ kind: "error", text: result.message });
    }
  }

  async function save() {
    setBusy("saving");
    setMessage(null);
    handleResult(await savePreferences(form), "Preferences saved. Your next job search will use them.");
    setBusy(null);
  }

  async function clear() {
    if (!window.confirm("Clear your search preferences? Job searches will go back to the default terms and London.")) return;
    setBusy("clearing");
    setMessage(null);
    handleResult(await clearPreferences(), "Preferences cleared. Job searches use the defaults again.");
    setBusy(null);
  }

  const update = (field: PreferenceField) => (value: string) => {
    setForm((prev) => ({ ...prev, [field]: value }));
    if (fieldErrors[field]) setFieldErrors((prev) => ({ ...prev, [field]: "" }));
  };

  const disabled = loading || busy !== null;
  const errorFor = (field: PreferenceField) => fieldErrors[field] || "";
  const others = otherFieldErrors(fieldErrors).filter(Boolean);

  return (
    <main className="min-h-screen bg-gray-100 p-8">
      <div className="mx-auto max-w-3xl">
        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-4xl font-bold text-gray-900">Search preferences</h1>
            <p className="mt-1 text-gray-600">
              Choose what job searches look for. Saving only changes your preferences; it does not search, apply or
              send anything.
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            <Link
              href="/"
              className="rounded-lg bg-gray-800 px-4 py-2 text-sm font-semibold text-white hover:bg-gray-700"
            >
              ← Back to Agent
            </Link>
          </div>
        </div>

        {loading ? (
          <div className="mt-6 rounded-xl bg-white p-8 text-center text-gray-500 shadow">Loading preferences…</div>
        ) : noCandidate ? (
          <div className="mt-6 rounded-xl bg-white p-8 text-center shadow">
            <p className="font-semibold text-gray-900">{noCandidate}</p>
            <p className="mt-2 text-gray-600">Preferences are saved with your profile, which is created when you upload your CV.</p>
            <Link href="/" className="mt-4 inline-block rounded-lg bg-blue-600 px-4 py-2 font-semibold text-white hover:bg-blue-700">
              Upload your CV
            </Link>
          </div>
        ) : loadError ? (
          <div className="mt-6 rounded-xl bg-white p-8 text-center shadow">
            <p className="text-red-700">{loadError}</p>
            <button onClick={retry} className="mt-4 rounded-lg bg-gray-800 px-4 py-2 font-semibold text-white hover:bg-gray-700">
              Try again
            </button>
          </div>
        ) : (
          <div className="mt-6 rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
            <p className="text-sm text-gray-600">
              {saved
                ? "Your saved preferences are shown below."
                : "No preferences are saved: job searches use the default terms and London."}{" "}
              The role you select on the main page is always searched first. Scheduled searches don&rsquo;t use these
              preferences.
            </p>

            {message && (
              <div role={message.kind === "error" ? "alert" : "status"} className={`mt-4 rounded-lg border p-3 text-sm ${MESSAGE_STYLES[message.kind]}`}>
                {message.text}
                {others.length > 0 && (
                  <ul className="mt-1 list-disc pl-5">
                    {others.map((text) => (
                      <li key={text}>{text}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            <label className="mt-6 block text-sm font-semibold text-gray-800" htmlFor="searchTerms">
              Search terms <span className="font-normal text-gray-500">(one per line, 1–6)</span>
            </label>
            <textarea
              id="searchTerms"
              rows={4}
              value={form.searchTerms}
              disabled={disabled}
              onChange={(e) => update("searchTerms")(e.target.value)}
              placeholder={"kotlin developer\nreact developer"}
              className={inputClass(Boolean(errorFor("searchTerms")))}
            />
            {errorFor("searchTerms") && <p className="mt-1 text-sm text-red-700">{errorFor("searchTerms")}</p>}

            <label className="mt-4 block text-sm font-semibold text-gray-800" htmlFor="location">
              Location
            </label>
            <input
              id="location"
              type="text"
              value={form.location}
              disabled={disabled}
              onChange={(e) => update("location")(e.target.value)}
              placeholder="London"
              className={inputClass(Boolean(errorFor("location")))}
            />
            {errorFor("location") && <p className="mt-1 text-sm text-red-700">{errorFor("location")}</p>}

            <label className="mt-4 block text-sm font-semibold text-gray-800" htmlFor="excludeKeywords">
              Exclude jobs whose title contains <span className="font-normal text-gray-500">(optional, one per line, up to 20)</span>
            </label>
            <textarea
              id="excludeKeywords"
              rows={3}
              value={form.excludeKeywords}
              disabled={disabled}
              onChange={(e) => update("excludeKeywords")(e.target.value)}
              placeholder={"Senior\nLead"}
              className={inputClass(Boolean(errorFor("excludeKeywords")))}
            />
            {errorFor("excludeKeywords") && <p className="mt-1 text-sm text-red-700">{errorFor("excludeKeywords")}</p>}

            <label className="mt-4 block text-sm font-semibold text-gray-800" htmlFor="minSalary">
              Minimum salary <span className="font-normal text-gray-500">(optional, £ per year)</span>
            </label>
            <input
              id="minSalary"
              type="text"
              inputMode="numeric"
              value={form.minSalary}
              disabled={disabled}
              onChange={(e) => update("minSalary")(e.target.value)}
              placeholder="30,000"
              className={inputClass(Boolean(errorFor("minSalary")))}
            />
            {errorFor("minSalary") ? (
              <p className="mt-1 text-sm text-red-700">{errorFor("minSalary")}</p>
            ) : (
              <p className="mt-1 text-xs text-gray-500">
                Jobs with no salary, an estimated salary or a day rate are always kept.
              </p>
            )}

            <div className="mt-6 flex flex-wrap gap-2">
              <button
                onClick={save}
                disabled={disabled}
                className="rounded-lg bg-blue-600 px-4 py-2 font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {busy === "saving" ? "Saving…" : "Save preferences"}
              </button>
              <button
                onClick={clear}
                disabled={disabled || saved === null}
                className="rounded-lg border border-gray-300 bg-white px-4 py-2 font-semibold text-gray-800 hover:bg-gray-50 disabled:opacity-50"
              >
                {busy === "clearing" ? "Clearing…" : "Clear preferences"}
              </button>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
