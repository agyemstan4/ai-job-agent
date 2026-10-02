import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { OllamaOutputError, parseOllamaJson } from "../lib/ollama-json.ts";

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof OllamaOutputError ? error.code : "OTHER";
  }
  return undefined;
}

describe("parseOllamaJson", () => {
  test("parses a complete response", () => {
    assert.deepEqual(parseOllamaJson({ response: '{"a":1}', done_reason: "stop" }, 3584), { a: 1 });
  });

  // Regression: a real CV upload produced exactly num_predict (1400) tokens
  // and a cut-off JSON document, reported only as "invalid JSON".
  test("reports output cut off by the token limit as TRUNCATED", () => {
    const cutOff = { response: '{"analysis": {"summary": "Built VibeNSync', done_reason: "length", eval_count: 1400 };
    assert.equal(codeOf(() => parseOllamaJson(cutOff, 1400)), "TRUNCATED");
  });

  test("detects truncation from eval_count when done_reason is absent", () => {
    assert.equal(codeOf(() => parseOllamaJson({ response: '{"a":', eval_count: 1400 }, 1400)), "TRUNCATED");
    assert.deepEqual(parseOllamaJson({ response: '{"a":1}', eval_count: 12 }, 1400), { a: 1 });
  });

  test("reports malformed but complete output as INVALID_JSON", () => {
    assert.equal(codeOf(() => parseOllamaJson({ response: "not json", done_reason: "stop" }, 3584)), "INVALID_JSON");
  });
});
