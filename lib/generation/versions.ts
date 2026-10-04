// Model and prompt versions for the application-preparation generators
// (tailored CV, cover letter, application-question answers).
//
// Bump a prompt version whenever that prompt's text or its generation
// settings change, so generated content can be traced to what produced it.
// (CV analysis and job matching keep their own constants in their routes:
// "analyse-and-extract/v1" and "match/v1".)

/** The local Ollama model used for preparation. */
export const GENERATION_MODEL = "llama3.2:3b";

// v2 (3d): the model writes only the summary and experience bullets; the rest of
// the CV is merged from the stored profile (65% fewer tokens, copied fields exact).
export const TAILOR_CV_PROMPT_VERSION = "tailor-cv/v2";
export const COVER_LETTER_PROMPT_VERSION = "cover-letter/v1";
export const APPLICATION_QUESTIONS_PROMPT_VERSION = "application-questions/v1";
