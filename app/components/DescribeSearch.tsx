"use client";

import { useState } from "react";
import type { SearchPreferences } from "@/lib/pipeline/preferences";
import { intentItems, intentToPreferences, parseSearchIntent } from "@/lib/pipeline/search-intent";
import type { IntentPreferences, SearchIntent } from "@/lib/pipeline/search-intent";
import { EMPTY_PREFERENCES_FORM, searchPreview } from "@/lib/preferences-client";

// "Tell your agent what you're looking for": a request in normal language is
// interpreted locally (lib/pipeline/search-intent.ts — no network request),
// shown back as plain items the user can remove, and only then applied to the
// page. This component never searches and never saves: the page's own
// Find Suitable Jobs / Save button does that, after the user has reviewed it.

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

  const result = intent ? intentToPreferences(intent, saved, removed) : null;
  const items = intent ? intentItems(intent).filter((item) => !removed.has(item.key)) : [];
  const preview = result
    ? searchPreview({ ...EMPTY_PREFERENCES_FORM, targetRoles: result.preferences.targetRoles, searchTerms: result.preferences.searchTerms.join("\n") })
    : null;
  const noWork = Boolean(result && preview && preview.terms.length === 0);
  // The "what kind of work?" question is moot when saved kinds of work will be used.
  const questions = (intent?.clarifications ?? []).filter((q) => !(q.startsWith("What kind of work") && result?.kept.includes("the kinds of work you saved")));

  return (
    <div className="rounded-2xl bg-white p-5 ring-1 ring-slate-200/80 sm:p-6">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          understand();
        }}
      >
        <label htmlFor="describe-search" className="block text-base font-semibold text-slate-900">
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
            className="min-h-12 w-full flex-1 rounded-xl border-0 bg-slate-50 px-4 text-base text-slate-900 ring-1 ring-inset ring-slate-300 placeholder:text-slate-500 focus:bg-white focus:ring-2 focus:ring-indigo-500"
          />
          <button type="submit" className="min-h-12 rounded-xl bg-slate-900 px-6 text-sm font-semibold text-white hover:bg-slate-700">
            Understand
          </button>
        </div>
        <div className="mt-2 flex flex-wrap gap-2 text-sm">
          <span className="text-slate-600">Try:</span>
          {EXAMPLES.map((example) => (
            <button
              key={example}
              type="button"
              onClick={() => {
                setText(example);
                understand(example);
              }}
              className="min-h-8 rounded-full px-3 text-slate-700 ring-1 ring-inset ring-slate-300 hover:bg-slate-50"
            >
              {example}
            </button>
          ))}
        </div>
      </form>

      {intent && result && preview && (
        <div className="mt-5 rounded-xl bg-slate-50 p-4 ring-1 ring-inset ring-slate-200/80" aria-live="polite">
          <p className="text-sm font-semibold text-slate-900">I understood:</p>
          {items.length > 0 ? (
            <ul className="mt-2 flex flex-wrap gap-2" aria-label="What your agent understood">
              {items.map((item) => (
                <li key={item.key} className="inline-flex min-h-9 items-center gap-1.5 rounded-full bg-white pl-3 pr-1 text-sm font-medium text-slate-900 ring-1 ring-inset ring-slate-300">
                  <span aria-hidden="true" className="text-indigo-600">{KIND_ICON[item.kind]}</span>
                  {item.text}
                  <button
                    type="button"
                    onClick={() => {
                      setRemoved((prev) => new Set(prev).add(item.key));
                      setApplied(false);
                    }}
                    aria-label={`Remove ${item.text}`}
                    className="grid h-7 w-7 place-items-center rounded-full text-slate-500 hover:bg-slate-100 hover:text-slate-900"
                  >
                    <span aria-hidden="true">×</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-sm text-slate-600">Nothing specific yet.</p>
          )}

          {result.kept.length > 0 && (
            <p className="mt-3 text-sm text-slate-700">
              <span className="font-medium">Also using</span> {result.kept.join(", ")} — change these on the Preferences page.
            </p>
          )}
          {intent.notes.map((note) => (
            <p key={note.text} className="mt-2 flex gap-2 text-sm text-slate-700">
              <span aria-hidden="true" className="font-semibold text-sky-700">i</span>
              <span><span className="sr-only">Note: </span>{note.text}</span>
            </p>
          ))}
          {questions.map((q) => (
            <p key={q} className="mt-2 flex gap-2 text-sm font-medium text-amber-900">
              <span aria-hidden="true">?</span>
              <span><span className="sr-only">Question: </span>{q}</span>
            </p>
          ))}

          {preview.terms.length > 0 && (
            <p className={`mt-3 text-sm ${preview.overLimit ? "font-medium text-rose-800" : "text-slate-700"}`}>
              <span className="font-medium">Your agent will search job sites for:</span> {preview.terms.join(" · ")} in {result.preferences.location}
              {preview.overLimit && <> — that&rsquo;s too many for one search; remove {preview.terms.length - preview.limit}.</>}
            </p>
          )}

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button
              type="button"
              disabled={noWork || preview.overLimit}
              onClick={() => {
                onApply(result.preferences);
                setApplied(true);
              }}
              className="min-h-11 rounded-lg bg-indigo-600 px-5 text-sm font-semibold text-white shadow-sm hover:bg-indigo-500 disabled:opacity-50"
            >
              {applyLabel}
            </button>
            {applied && <span className="text-sm font-medium text-emerald-800" role="status">✓ Done</span>}
          </div>
        </div>
      )}
    </div>
  );
}
