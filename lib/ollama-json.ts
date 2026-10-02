// Parsing of Ollama /api/generate responses that were asked for JSON.
// A response cut off by the num_predict limit is reported as such, rather
// than as a generic JSON error, so the cause is visible.

export type OllamaGenerateResponse = {
  response: string;
  done_reason?: string;
  eval_count?: number;
};

export class OllamaOutputError extends Error {
  readonly code: "TRUNCATED" | "INVALID_JSON";

  constructor(code: "TRUNCATED" | "INVALID_JSON", message: string) {
    super(message);
    this.name = "OllamaOutputError";
    this.code = code;
  }
}

export function parseOllamaJson(response: OllamaGenerateResponse, numPredict?: number): unknown {
  const hitLimit =
    response.done_reason === "length" ||
    (response.done_reason === undefined &&
      numPredict !== undefined &&
      response.eval_count !== undefined &&
      response.eval_count >= numPredict);
  if (hitLimit) {
    throw new OllamaOutputError(
      "TRUNCATED",
      `Ollama output was cut off at the ${numPredict ?? "num_predict"}-token limit before the JSON was complete`
    );
  }
  try {
    return JSON.parse(response.response);
  } catch {
    throw new OllamaOutputError("INVALID_JSON", "Ollama returned invalid JSON");
  }
}
