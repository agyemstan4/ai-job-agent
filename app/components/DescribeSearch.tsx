"use client";

import { useState } from "react";
import type { SearchPreferences } from "@/lib/pipeline/preferences";
import { intentItems, intentToPreferences, parseSearchIntent, savedPreferenceItems } from "@/lib/pipeline/search-intent";
import type { IntentPreferences, SearchIntent } from "@/lib/pipeline/search-intent";
import { EMPTY_PREFERENCES_FORM, searchPreview } from "@/lib/preferences-client";

// "Tell your agent what you're looking for": a request in normal language is
// interpreted locally (lib/pipeline/search-intent.ts — no network request) and
// shown back in two groups: what you asked for, and the saved preferences the
// search will also use because the request didn't mention them. Either can be
// trimmed for this search. Only then is it applied to the page. This component
// never searches and never saves: the page's own Find Suitable Jobs / Save
// button does that, after the user has reviewed it.

const EXAMPLES = [
  "Territory manager jobs around London with a company car",
  "Driving jobs where they provide the van",
  "Graduate software jobs in Manchester, at least £28k",
];

const KIND_ICON: Record<string, string> = { role: "◆", own: "◆", location: "⌖", salary: "£", benefit: "★" };

export default function DescribeSearch({
  saved,
  applyLabel,
  onApply,
}: {
  saved: SearchPreferences | null;
  applyLabel: string;
  onApply: (preferences: IntentPreferences["preferences"]) => void;
}) {
  const [text, setText] = useState("");
  const [intent, setIntent] = useState<SearchIntent | null>(null);
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [applied, setApplied] = useState(false);

  function understand(value = text) {
    setIntent(parseSearchIntent(value));
    setRemoved(new Set());
    setApplied(false);
  }
  const remove = (key: string) => {
    setRemoved((prev) => new Set(prev).add(key));
    setApplied(false);
  };

  const result = intent ? intentToPreferences(intent, saved, removed) : null;
  const asked = intent ? intentItems(intent).filter((item) => !removed.has(item.key)) : [];
  const fromSaved = intent ? savedPreferenceItems(intent, saved, removed) : [];
  const preview = result
    ? searchPreview({ ...EMPTY_PREFERENCES_FORM, targetRoles: result.preferences.targetRoles, searchTerms: result.preferences.searchTerms.join("\n") })
    : null;
  const noWork = Boolean(result && preview && preview.terms.length === 0);
  // The "what kind of work?" question is moot when saved kinds of work will be used.
  const questions = (intent?.clarifications ?? []).filter((q) => !(q.startsWith("What kind of work") && fromSaved.some((s) => s.key === "saved:roles")));

  return (
    <div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          understand();
        }}
      >
        <label htmlFor="describe-search" className="block text-lg font-semibold text-slate-900">
          Tell your agent what you&rsquo;re looking for
        </label>
        <p className="mt-1 text-sm text-slate-600">In your own words — the kind of work, where, pay and any benefits that matter. Nothing is searched until you say so.</p>
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <input
            id="describe-search"
            type="text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="e.g. Territory manager jobs around London with a company car"
            className="min-h-14 w-full flex-1 rounded-xl border-0 bg-white px-4 text-base text-slate-900 shadow-sm ring-1 ring-inset ring-slate-300 placeholder:text-slate-500 focus:ring-2 focus:ring-indigo-500"
          />
          <button type="submit" className="min-h-14 rounded-xl bg-indigo-600 px-6 text-base font-semibold text-white shadow-sm hover:bg-indigo-500">
            Understand my request
          </button>
        </div>
        <div className="mt-2 flex flex-wrap gap-2 text-sm">
          <span className="self-center text-slate-600">Try:</span>
          {EXAMPLES.map((example) => (
            <button
              key={example}
              type="button"
              onClick={() => {
                setText(example);
                understand(example);
              }}
              className="min-h-9 rounded-full bg-white px-3 text-slate-700 ring-1 ring-inset ring-slate-300 hover:bg-slate-50"
            >
              {example}
            </button>
          ))}
        </div>
      </form>

      {intent && result && preview && (
        <div className="mt-5 rounded-xl bg-white p-4 ring-1 ring-inset ring-slate-200 sm:p-5" aria-live="polite">
          <div className="grid gap-5 lg:grid-cols-2">
            {/* What the request said */}
            <section aria-labelledby="asked-heading">
              <h3 id="asked-heading" className="text-sm font-semibold text-slate-900">What you asked for</h3>
              {asked.length > 0 ? (
                <ul className="mt-2 flex flex-wrap gap-2" aria-label="What you asked for">
                  {asked.map((item) => (
                    <li key={item.key} className="inline-flex min-h-9 max-w-full items-center gap-1.5 rounded-full bg-indigo-50 pl-3 pr-1 text-sm font-medium text-indigo-950 ring-1 ring-inset ring-indigo-200">
                      <span aria-hidden="true" className="text-indigo-600">{KIND_ICON[item.kind]}</span>
                      <span className="min-w-0 break-words">{item.text}</span>
                      <button
                        type="button"
                        onClick={() => remove(item.key)}
                        aria-label={`Remove ${item.text}`}
                        className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-indigo-700 hover:bg-indigo-100 hover:text-indigo-950"
                      >
                        <span aria-hidden="true">×</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-1 text-sm text-slate-600">Nothing specific yet.</p>
              )}
            </section>

            {/* Saved preferences also used because the request didn't mention them */}
            <section aria-labelledby="saved-heading">
              <h3 id="saved-heading" className="text-sm font-semibold text-slate-900">Your saved preferences</h3>
              {fromSaved.length > 0 ? (
                <>
                  <p className="mt-0.5 text-sm text-slate-600">Also used, because your request didn&rsquo;t mention them.</p>
                  <ul className="mt-2 divide-y divide-slate-100 rounded-lg ring-1 ring-slate-200" aria-label="Saved preferences this search will also use">
                    {fromSaved.map((item) => (
                      <li key={item.key} className="flex min-h-10 flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 py-1.5 text-sm">
                        <span className="min-w-0">
                          <span className="text-slate-600">{item.label}: </span>
                          <span className="font-medium text-slate-900">{item.value}</span>
                        </span>
                        {item.removable && (
                          <button
                            type="button"
                            onClick={() => remove(item.key)}
                            className="min-h-8 rounded-md px-2 text-sm font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                          >
                            Don&rsquo;t use<span className="sr-only"> {item.value} for this search</span>
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <p className="mt-1 text-sm text-slate-600">None — this search uses only what you asked for.</p>
              )}
            </section>
          </div>

          {intent.notes.map((note) => (
            <p key={note.text} className="mt-3 flex gap-2 text-sm text-slate-700">
              <span aria-hidden="true" className="w-3 shrink-0 text-center font-semibold text-sky-700">i</span>
              <span><span className="sr-only">Note: </span>{note.text}</span>
            </p>
          ))}
          {questions.map((q) => (
            <p key={q} className="mt-3 flex gap-2 text-sm font-medium text-amber-900">
              <span aria-hidden="true" className="w-3 shrink-0 text-center">?</span>
              <span><span className="sr-only">Question: </span>{q}</span>
            </p>
          ))}

          <div className="mt-4 flex flex-col gap-3 border-t border-slate-100 pt-4 sm:flex-row sm:items-center sm:justify-between">
            <p className={`text-sm ${preview.overLimit ? "font-medium text-rose-800" : "text-slate-700"}`}>
              {preview.terms.length > 0 ? (
                <>
                  <span className="font-medium">Your agent will look for:</span> {preview.terms.join(" · ")} in {result.preferences.location}
                  {preview.overLimit && <> — that&rsquo;s too many for one search; remove {preview.terms.length - preview.limit}.</>}
                </>
              ) : (
                "Add a kind of work to search for."
              )}
            </p>
            <div className="flex shrink-0 items-center gap-3">
              {applied && <span className="text-sm font-medium text-emerald-800" role="status">✓ Ready</span>}
              <button
                type="button"
                disabled={noWork || preview.overLimit}
                onClick={() => {
                  onApply(result.preferences);
                  setApplied(true);
                }}
                className="min-h-11 rounded-lg bg-slate-900 px-5 text-sm font-semibold text-white hover:bg-slate-700 disabled:opacity-50"
              >
                {applyLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
