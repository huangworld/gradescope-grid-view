import { test } from "node:test";
import assert from "node:assert/strict";
import { cropRectFor, rectKey, ocrJobsFor, combineText } from "../extension/content/text.js";
import { answerText } from "../extension/content/gradescope.js";

const pages = [
  { id: 11, number: 1, url: "https://s3.example/p1.jpg" },
  { id: 12, number: 2, url: "https://s3.example/p2.jpg" },
];
const rects = [
  { page_number: 1, x1: 10, y1: 20, x2: 60, y2: 50 },
  { page_number: 1, x1: 5, y1: 55, x2: 40, y2: 70 },
];

test("cropRectFor: bounding box of the page's rects; null when off/none", () => {
  assert.deepEqual(cropRectFor(rects, pages[0], true), { x: 5, y: 20, w: 55, h: 50 });
  assert.equal(cropRectFor(rects, pages[1], true), null);
  assert.equal(cropRectFor(rects, pages[0], false), null);
  assert.equal(cropRectFor([{ page: 1, x1: "a", y1: 0, x2: 1, y2: 1 }], pages[0], true), null);
});

test("ocrJobsFor keys include sid, page id and crop", () => {
  const jobs = ocrJobsFor("s1", pages, rects, true);
  assert.deepEqual(
    jobs.map((j) => j.key),
    ["s1|11|5,20,55,50", "s1|12|full"]
  );
  assert.equal(jobs[0].url, pages[0].url);
  assert.equal(ocrJobsFor("s1", pages, rects, false)[0].key, "s1|11|full");
  assert.equal(rectKey({ x: 1.4, y: 2.6, w: 3, h: 4 }), "1,3,3,4");
});

test("combineText statuses", () => {
  const jobs = ocrJobsFor("s1", pages, [], false);
  assert.deepEqual(combineText({ ctx: null, jobs, ocrOn: true, ocr: new Map() }), { text: "", status: "unloaded" });
  const ctx = { answerText: "typed" };
  // OCR off → ready with typed text only
  assert.deepEqual(combineText({ ctx, jobs, ocrOn: false, ocr: new Map() }), { text: "typed", status: "ready" });
  // OCR on, nothing done → pending
  assert.equal(combineText({ ctx, jobs, ocrOn: true, ocr: new Map() }).status, "pending");
  // one page done → still pending
  const ocr = new Map([[jobs[0].key, { text: "page one" }]]);
  assert.equal(combineText({ ctx, jobs, ocrOn: true, ocr }).status, "pending");
  // failure counts as done
  ocr.set(jobs[1].key, { err: "boom" });
  assert.deepEqual(combineText({ ctx, jobs, ocrOn: true, ocr }), { text: "typed\npage one", status: "ready" });
  // no pages at all → ready
  assert.equal(combineText({ ctx: { answerText: "" }, jobs: [], ocrOn: true, ocr: new Map() }).status, "ready");
});

test("answerText: direct answer keys, file refs skipped, dedup", () => {
  assert.equal(answerText({ question_submission: { answers: { 0: "hello", 1: [{ text_file_id: 5 }], 2: "hello" } } }), "hello");
  assert.equal(answerText({ answers: { 0: ["a", "b"] } }), "a\nb");
  assert.equal(answerText({ submission: { answers: { 0: 42 } } }), "42");
});

test("answerText: fallback walk finds answer-like keys, skips question/rubric/ids/urls", () => {
  const props = {
    question: { text: "What is 2+2?" },
    rubric_items: [{ description: "correct", id: 1 }],
    pages: [{ url: "https://x/y.png" }],
    foo: { student_response: "four", image_url: "https://x/z.png", response_id: 9 },
  };
  assert.equal(answerText(props), "four");
  assert.equal(answerText({ question: { text: "q" } }), "");
});

import { pageHits, jobForPage } from "../extension/content/text.js";
import { parseQuery } from "../extension/content/query.js";

test("pageHits maps ranges back to word boxes using the join rule", () => {
  // two lines: "apple pie recipe" / "banana split"
  const words = [
    ["apple", 1, 2, 10, 5, 0],
    ["pie", 11, 2, 15, 5, 0],
    ["recipe", 16, 2, 25, 5, 0],
    ["banana", 1, 10, 12, 13, 1],
    ["split", 13, 10, 20, 13, 1],
  ];
  const entry = { text: "apple pie recipe\nbanana split", words };
  const h = (q) => pageHits(entry, parseQuery(q).highlight);
  assert.deepEqual(h("pie"), [{ x: 11, y: 2, w: 4, h: 3 }]);
  assert.deepEqual(h('"apple pie"').length, 2);
  assert.deepEqual(h("recipe banana").map((b) => b.y), [2, 10]);
  assert.deepEqual(h("NOT banana"), []);
  assert.deepEqual(h("/p\\w+/").length, 4); // apple (pple), pie, recipe (pe), split (plit)
  assert.deepEqual(h("zzz"), []);
  assert.deepEqual(pageHits({ text: "apple", words: [] }, parseQuery("apple").highlight), []); // legacy index
  assert.deepEqual(pageHits(undefined, parseQuery("apple").highlight), []);
});

test("jobForPage matches ocrJobsFor keys", () => {
  const p = { id: 11, number: 1, url: "u" };
  assert.equal(jobForPage("s1", p, [{ page_number: 1, x1: 10, y1: 20, x2: 60, y2: 50 }], true).key, "s1|11|10,20,50,30");
});

test("gradedAtFrom: evaluation/submission timestamps, seconds vs ms, null when absent", async () => {
  const { gradedAtFrom } = await import("../extension/content/gradescope.js");
  assert.equal(gradedAtFrom({ evaluation: { updated_at: "2026-10-17T10:00:00Z" } }), Date.parse("2026-10-17T10:00:00Z"));
  assert.equal(gradedAtFrom({ submission: { graded_at: 1760000000 } }), 1760000000000);
  assert.equal(gradedAtFrom({ submission: { updated_at: 1760000000123 } }), 1760000000123);
  // evaluation time wins over submission time
  assert.equal(gradedAtFrom({ evaluation: { updated_at: "2026-01-01T00:00:00Z" }, submission: { updated_at: "2026-02-01T00:00:00Z" } }), Date.parse("2026-01-01T00:00:00Z"));
  assert.equal(gradedAtFrom({ evaluation: { updated_at: "garbage" }, submission: {} }), null);
  assert.equal(gradedAtFrom({}), null);
});
