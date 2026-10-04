"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { SearchPreferences } from "@/lib/pipeline/preferences";
import { roleGroups, labelsForRoles } from "@/lib/pipeline/careers";
import { BENEFITS, PREFERABLE_BENEFITS } from "@/lib/pipeline/benefits";
import type { BenefitId, BenefitPriority } from "@/lib/pipeline/benefits";
import {
  clearPreferences,
  NEW_PREFERENCES_FORM,
  formFromPreferences,
  loadPreferences,
  otherFieldErrors,
  savePreferences,
  searchPreview,
  setBenefit,
  toggleRole,
} from "@/lib/preferences-client";
import type { LoadResult, PreferenceField, PreferencesForm, SaveResult } from "@/lib/preferences-client";
import DescribeSearch from "@/app/components/DescribeSearch";

// Search preferences: what kind of work you want now, where, for how much, and
// which employer benefits matter — through the existing GET/PUT
// /api/preferences. Your CV describes you; these describe what you want now,
// and you can change them any time. Saving only changes your preferences;
// nothing here searches, applies or sends anything.

type Message = { kind: "success" | "error" | "info"; text: string };

const MESSAGE_STYLES: Record<Message["kind"], string> = {
  success: "bg-emerald-50 text-emerald-900 ring-emerald-600/20",
  error: "bg-rose-50 text-rose-900 ring-rose-600/20",
  info: "bg-sky-50 text-sky-900 ring-sky-600/20",
};

const CARD = "rounded-2xl bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)] ring-1 ring-slate-200/80";

const inputClass = (invalid: boolean) =>
  `mt-2 block w-full rounded-xl border-0 px-3.5 py-2.5 text-base text-slate-900 ring-1 ring-inset placeholder:text-slate-500 focus:ring-2 focus:ring-indigo-500 disabled:bg-slate-100 ${
    invalid ? "bg-rose-50 ring-rose-400" : "bg-white ring-slate-300"
  }`;

const BENEFIT_LEVELS: { value: BenefitPriority | null; label: string }[] = [
  { value: null, label: "Not needed" },
  { value: "preferred", label: "Nice to have" },
  { value: "important", label: "Important" },
];

function Step({ number, title, hint, children }: { number: number; title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-slate-100 pt-6 first:border-t-0 first:pt-0" aria-labelledby={`step-${number}`}>
      <h2 id={`step-${number}`} className="flex items-center gap-2.5 text-lg font-semibold text-slate-900">
        <span className="grid h-7 w-7 place-items-center rounded-full bg-indigo-600 text-sm font-bold text-white" aria-hidden="true">{number}</span>
        {title}
      </h2>
      {hint && <p className="mt-1 text-sm text-slate-600 sm:pl-[2.375rem]">{hint}</p>}
      <div className="mt-4 sm:pl-[2.375rem]">{children}</div>
    </section>
  );
}

export default function PreferencesPage() {
  const [loading, setLoading] = useState(true);
  const [noCandidate, setNoCandidate] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saved, setSaved] = useState<SearchPreferences | null>(null);
  const [form, setForm] = useState<PreferencesForm>(NEW_PREFERENCES_FORM);
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

  const clearError = (field: PreferenceField) => {
    if (fieldErrors[field]) setFieldErrors((prev) => ({ ...prev, [field]: "" }));
  };
  const update = (field: "searchTerms" | "location" | "excludeKeywords" | "minSalary") => (value: string) => {
    setForm((prev) => ({ ...prev, [field]: value }));
    clearError(field);
  };

  const disabled = loading || busy !== null;
  const errorFor = (field: PreferenceField) => fieldErrors[field] || "";
  const others = otherFieldErrors(fieldErrors).filter(Boolean);
  const preview = searchPreview(form);
  const savedRoles = saved ? labelsForRoles(saved.targetRoles ?? []) : [];

  return (
    <main className="w-full py-6 sm:py-8">
      <div className="app-shell">
        <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,52rem)_minmax(16rem,24rem)]">
          <div className="min-w-0">
            {/* Header */}
            <div>
              <Link
                href="/"
                className="text-sm font-medium text-slate-600 hover:text-slate-900"
              >
                ← Home
              </Link>
              <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-900 sm:text-4xl">What are you looking for?</h1>
              <p className="mt-2 text-slate-600">
                Tell your agent what kind of work you want now. Your CV describes you; these choices describe what you want, and
                you can change them any time. Saving only changes your preferences; it does not search, apply or send anything.
              </p>
            </div>

            {loading ? (
              <div className={`mt-6 p-8 text-center text-slate-600 ${CARD}`} role="status">Loading preferences…</div>
            ) : noCandidate ? (
              <div className={`mt-6 p-8 text-center ${CARD}`}>
                <p className="font-semibold text-slate-900">{noCandidate}</p>
                <p className="mt-2 text-slate-600">Preferences are saved with your profile, which is created when you upload your CV.</p>
                <Link href="/" className="mt-4 inline-flex min-h-11 items-center rounded-lg bg-indigo-600 px-5 font-semibold text-white hover:bg-indigo-500">
                  Upload your CV
                </Link>
              </div>
            ) : loadError ? (
              <div className={`mt-6 p-8 text-center ${CARD}`} role="alert">
                <p className="font-medium text-rose-800">{loadError}</p>
                <button onClick={retry} className="mt-4 min-h-10 rounded-lg bg-slate-900 px-4 font-semibold text-white hover:bg-slate-700">
                  Try again
                </button>
              </div>
            ) : (
              <div className={`mt-6 space-y-6 p-5 sm:p-7 ${CARD}`}>
                <p className="rounded-xl bg-slate-50 px-4 py-3 text-sm text-slate-700 ring-1 ring-inset ring-slate-200/70">
                  {saved
                    ? "Your saved preferences are shown below. Change anything, then save."
                    : "Nothing is saved yet: job searches use the default software roles and London. Pick what you want below — only the first step is needed."}
                </p>

                <div className="rounded-xl bg-indigo-50/60 p-4 ring-1 ring-inset ring-indigo-100 sm:p-5">
                <DescribeSearch
                  saved={saved}
                  applyLabel="Fill in the form"
                  onApply={(p) => {
                    setForm((prev) => ({
                      ...prev,
                      targetRoles: p.targetRoles,
                      searchTerms: p.searchTerms.join("\n"),
                      location: p.location,
                      minSalary: p.minSalary === null ? "" : String(p.minSalary),
                      benefits: p.benefits,
                    }));
                    setFieldErrors({});
                    setMessage({ kind: "info", text: "The form below is filled in from your request. Check it, then press Save preferences." });
                  }}
                />
                </div>

                {/* 1. Kind of work */}
                <Step number={1} title="What kind of work are you looking for?" hint="Choose as many as you like, or add your own. You can change direction whenever you want.">
                  <div className="space-y-4">
                    {roleGroups().map(({ group, categories }) => (
                      <div key={group} role="group" aria-labelledby={`group-${group}`}>
                        <p id={`group-${group}`} className="text-sm font-medium text-slate-600">{group}</p>
                        <div className="mt-2 flex flex-wrap gap-2">
                          {categories.map((category) => {
                            const on = form.targetRoles.includes(category.id);
                            return (
                              <button
                                key={category.id}
                                type="button"
                                aria-pressed={on}
                                disabled={disabled}
                                onClick={() => {
                                  setForm((prev) => toggleRole(prev, category.id));
                                  clearError("targetRoles");
                                  clearError("searchTerms");
                                }}
                                className={`min-h-10 rounded-full px-4 text-sm font-medium ring-1 ring-inset transition disabled:opacity-60 ${
                                  on ? "bg-indigo-600 text-white ring-indigo-600" : "bg-white text-slate-700 ring-slate-300 hover:bg-slate-50"
                                }`}
                              >
                                {on && <span aria-hidden="true">✓ </span>}
                                {category.label}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>

                  <label className="mt-6 block text-sm font-semibold text-slate-900" htmlFor="searchTerms">
                    Your own searches <span className="font-normal text-slate-600">(optional, one per line)</span>
                  </label>
                  <textarea
                    id="searchTerms"
                    rows={3}
                    value={form.searchTerms}
                    disabled={disabled}
                    onChange={(e) => update("searchTerms")(e.target.value)}
                    placeholder={"Territory Manager\nTechnical operator"}
                    className={inputClass(Boolean(errorFor("searchTerms")))}
                  />
                  {errorFor("searchTerms") && <p className="mt-1.5 text-sm text-rose-800">{errorFor("searchTerms")}</p>}

                  <div className={`mt-4 rounded-xl px-4 py-3 text-sm ring-1 ring-inset ${preview.overLimit || errorFor("targetRoles") ? "bg-rose-50 text-rose-900 ring-rose-200" : "bg-indigo-50/60 text-slate-800 ring-indigo-100"}`} aria-live="polite">
                    {preview.terms.length === 0 ? (
                      <>Nothing chosen yet. {saved ? "" : "Your agent will keep using the default software search."}</>
                    ) : (
                      <>
                        <span className="font-semibold">Your agent will search job sites for:</span>{" "}
                        {preview.terms.join(" · ")}
                        <span className="text-slate-600"> ({preview.terms.length} of {preview.limit})</span>
                        {preview.overLimit && <span className="mt-1 block font-medium">That&rsquo;s too many for one search — remove {preview.terms.length - preview.limit} to save.</span>}
                      </>
                    )}
                    {errorFor("targetRoles") && <span className="mt-1 block font-medium">{errorFor("targetRoles")}</span>}
                  </div>
                </Step>

                {/* 2. Where */}
                <Step number={2} title="Where would you like to work?">
                  <label className="block text-sm font-semibold text-slate-900" htmlFor="location">
                    Location <span className="font-normal text-slate-600">(a town, city or region)</span>
                  </label>
                  <input
                    id="location"
                    type="text"
                    value={form.location}
                    disabled={disabled}
                    onChange={(e) => update("location")(e.target.value)}
                    placeholder="London"
                    className={`${inputClass(Boolean(errorFor("location")))} max-w-md`}
                  />
                  {errorFor("location") && <p className="mt-1.5 text-sm text-rose-800">{errorFor("location")}</p>}
                </Step>

                {/* 3. Pay */}
                <Step number={3} title="How much would you like to earn?">
                  <label className="block text-sm font-semibold text-slate-900" htmlFor="minSalary">
                    Minimum salary <span className="font-normal text-slate-600">(optional, £ per year)</span>
                  </label>
                  <input
                    id="minSalary"
                    type="text"
                    inputMode="numeric"
                    value={form.minSalary}
                    disabled={disabled}
                    onChange={(e) => update("minSalary")(e.target.value)}
                    placeholder="30,000"
                    className={`${inputClass(Boolean(errorFor("minSalary")))} max-w-xs`}
                  />
                  {errorFor("minSalary") ? (
                    <p className="mt-1.5 text-sm text-rose-800">{errorFor("minSalary")}</p>
                  ) : (
                    <p className="mt-1.5 text-sm text-slate-600">
                      Jobs with no salary, an estimated salary or a day rate are always kept.
                    </p>
                  )}
                </Step>

                {/* 4. Benefits */}
                <Step
                  number={4}
                  title="Are there any benefits that matter to you?"
                  hint="Optional. Your agent shows a benefit on a job only when the advert says the employer provides it — never because the job needs a car or travel."
                >
                  <div className="divide-y divide-slate-100 rounded-xl ring-1 ring-slate-200/80">
                    {PREFERABLE_BENEFITS.map((id) => {
                      const benefit = BENEFITS.find((b) => b.id === id)!;
                      const current = form.benefits[id as BenefitId] ?? null;
                      return (
                        <fieldset key={id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                          <legend className="sr-only">{benefit.label}</legend>
                          <span className="text-sm font-medium text-slate-900" aria-hidden="true">{benefit.label}</span>
                          <div className="inline-grid grid-cols-3 gap-1 rounded-lg bg-slate-100 p-1">
                            {BENEFIT_LEVELS.map((level) => (
                              <label
                                key={level.label}
                                className={`flex min-h-9 cursor-pointer items-center justify-center rounded-md px-3 text-sm font-medium transition focus-within:outline focus-within:outline-2 focus-within:outline-indigo-600 ${
                                  current === level.value ? (level.value === "important" ? "bg-indigo-600 text-white shadow-sm" : "bg-white text-slate-900 shadow-sm") : "text-slate-600 hover:text-slate-900"
                                }`}
                              >
                                <input
                                  type="radio"
                                  name={`benefit-${id}`}
                                  className="sr-only"
                                  checked={current === level.value}
                                  disabled={disabled}
                                  onChange={() => {
                                    setForm((prev) => setBenefit(prev, id as BenefitId, level.value));
                                    clearError("benefits");
                                  }}
                                />
                                {level.label}
                              </label>
                            ))}
                          </div>
                        </fieldset>
                      );
                    })}
                  </div>
                  {errorFor("benefits") && <p className="mt-1.5 text-sm text-rose-800">{errorFor("benefits")}</p>}
                </Step>

                {/* More options */}
                <details className="rounded-xl bg-slate-50 px-4 py-3 ring-1 ring-inset ring-slate-200/70" open={Boolean(form.excludeKeywords) || Boolean(errorFor("excludeKeywords"))}>
                  <summary className="min-h-8 cursor-pointer text-sm font-semibold text-slate-900">More options</summary>
                  <label className="mt-3 block text-sm font-semibold text-slate-900" htmlFor="excludeKeywords">
                    Skip jobs whose title contains <span className="font-normal text-slate-600">(optional, one per line, up to 20)</span>
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
                  {errorFor("excludeKeywords") && <p className="mt-1.5 text-sm text-rose-800">{errorFor("excludeKeywords")}</p>}
                </details>

                {message && (
                  <div role={message.kind === "error" ? "alert" : "status"} className={`rounded-xl px-4 py-3 text-sm ring-1 ring-inset ${MESSAGE_STYLES[message.kind]}`}>
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

                <div className="flex flex-col gap-2 border-t border-slate-100 pt-6 sm:flex-row">
                  <button
                    onClick={save}
                    disabled={disabled || preview.overLimit}
                    className="min-h-11 rounded-lg bg-indigo-600 px-6 font-semibold text-white shadow-sm hover:bg-indigo-500 disabled:opacity-50"
                  >
                    {busy === "saving" ? "Saving…" : "Save preferences"}
                  </button>
                  <button
                    onClick={clear}
                    disabled={disabled || saved === null}
                    className="min-h-11 rounded-lg px-5 font-semibold text-slate-800 ring-1 ring-inset ring-slate-300 hover:bg-slate-50 disabled:opacity-50"
                  >
                    {busy === "clearing" ? "Clearing…" : "Clear preferences"}
                  </button>
                </div>
              </div>
            )}
          </div>

          <aside className="space-y-4 lg:sticky lg:top-24 lg:mt-[9.5rem]" aria-label="About your preferences">
            <div className={`p-5 ${CARD}`}>
              <h2 className="text-base font-semibold text-slate-900">Your current search</h2>
              {saved ? (
                <dl className="mt-3 space-y-2 text-sm">
                  <div><dt className="text-slate-600">Kinds of work</dt><dd className="font-medium text-slate-900">{[...savedRoles, ...saved.searchTerms].join(", ") || "—"}</dd></div>
                  <div><dt className="text-slate-600">Location</dt><dd className="font-medium text-slate-900">{saved.location}</dd></div>
                  <div><dt className="text-slate-600">Minimum salary</dt><dd className="font-medium text-slate-900">{saved.minSalary === null ? "Any" : `£${saved.minSalary.toLocaleString("en-GB")}`}</dd></div>
                  <div>
                    <dt className="text-slate-600">Benefits</dt>
                    <dd className="font-medium text-slate-900">
                      {Object.keys(saved.benefits ?? {}).length === 0
                        ? "None chosen"
                        : Object.entries(saved.benefits).map(([id, level]) => `${BENEFITS.find((b) => b.id === id)?.label} (${level === "important" ? "important" : "nice to have"})`).join(", ")}
                    </dd>
                  </div>
                </dl>
              ) : (
                <p className="mt-2 text-sm text-slate-600">The default software search in London.</p>
              )}
            </div>
            <div className={`p-5 ${CARD}`}>
              <h2 className="text-base font-semibold text-slate-900">Tips</h2>
              <ul className="mt-3 space-y-3 text-sm text-slate-700">
                <li><span className="font-semibold text-slate-900">Changing direction?</span> Just pick different kinds of work — no need to upload a new CV.</li>
                <li><span className="font-semibold text-slate-900">Your own searches:</span> use job titles you would type into a job site, such as &ldquo;Territory Manager&rdquo;.</li>
                <li><span className="font-semibold text-slate-900">When it applies:</span> your next <Link href="/#search" className="font-medium text-indigo-700 hover:underline">Find Suitable Jobs</Link> search uses what you save here.</li>
              </ul>
            </div>
          </aside>
        </div>
      </div>
    </main>
  );
}
