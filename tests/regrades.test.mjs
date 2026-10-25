import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRoute } from "../extension/content/rows.js";
import { classifyCompleted } from "../extension/content/regrades.js";
import { regradeText, studentNameFrom, respondRegrade, canRespondRegrade } from "../extension/content/gradescope.js";
import { combineText } from "../extension/content/text.js";

const GS = "https://www.gradescope.com";

test("parseRoute: question list, regrade list, non-matches", () => {
  assert.deepEqual(parseRoute(`${GS}/courses/1403410/questions/55/submissions`), { kind: "question", cid: "1403410", qid: "55" });
  assert.deepEqual(parseRoute(`${GS}/courses/1403410/assignments/8813892/regrade_requests`), { kind: "regrade", cid: "1403410", aid: "8813892" });
  assert.deepEqual(parseRoute(`${GS}/courses/1/assignments/2/regrade_requests/?x=1`), { kind: "regrade", cid: "1", aid: "2" });
  assert.equal(parseRoute(`${GS}/courses/1/assignments/2/regrade_requests/5`), null);
  assert.equal(parseRoute(`${GS}/courses/1/questions/2/submissions/3/grade`), null);
  assert.equal(parseRoute(`${GS}/courses/1/assignments/2/submissions`), null);
});

test("classifyCompleted: open vs done vs unreadable", () => {
  for (const t of ["", "  ", "—", "-", "Pending", "Not completed", "in progress"]) assert.equal(classifyCompleted(t), false, JSON.stringify(t));
  for (const t of ["Oct 3, 2026", "10/03/2026", "2026-10-03", "2 days ago", "✓", "Completed", "14:05", "3 Oct"]) assert.equal(classifyCompleted(t), true, t);
  assert.equal(classifyCompleted("Review"), null);
  assert.equal(classifyCompleted("", { hasCheckIcon: true }), true);
  assert.equal(classifyCompleted("Pending", { hasCheckIcon: true }), false); // text wins over icon
});

test("regradeText: open then closed, student then staff, deduped", () => {
  const props = {
    open_request: { created_at: "2026-10-20", student_comment: "I think part b is right", staff_comment: "" },
    closed_requests: [
      { created_at: "2026-10-01", student_comment: "first try", staff_comment: "No change" },
      { created_at: "2026-10-02", student_comment: "first try" },
      "junk",
    ],
  };
  assert.equal(regradeText(props), "I think part b is right\nfirst try\nNo change");
  assert.equal(regradeText({}), "");
  assert.equal(regradeText({ open_request: {} }), "");
  assert.equal(regradeText({ open_request: { student_comment: 42 } }), "");
});

test("studentNameFrom: owners, nested user, first/last, none", () => {
  assert.equal(studentNameFrom({ submission: { owners: [{ name: "Ada Lovelace" }] } }), "Ada Lovelace");
  assert.equal(studentNameFrom({ submission: { user: { first_name: "Bob", last_name: "Ross" } } }), "Bob Ross");
  assert.equal(studentNameFrom({ student: { full_name: "  Cyd  " } }), "Cyd");
  assert.equal(studentNameFrom({ submission: { score: 3 } }), null);
  assert.equal(studentNameFrom({}), null);
});

test("combineText: regrade text searchable in both scopes, droppable", () => {
  const ctx = { answerText: "typed", regradeText: "please regrade" };
  const base = { ctx, jobs: [], ocrOn: false, ocr: new Map() };
  assert.equal(combineText(base).text, "typed\nplease regrade");
  assert.equal(combineText({ ...base, answer: false }).text, "please regrade");
  assert.equal(combineText({ ...base, regrade: false }).text, "typed");
});

test("respondRegrade: refuses while the endpoint is unconfigured (no fetch)", async () => {
  assert.equal(canRespondRegrade(), false);
  globalThis.fetch = () => assert.fail("fetch must not be called");
  await assert.rejects(respondRegrade({ openRequest: { id: 1 }, csrf: "x" }, { message: "hi", close: true }), /not configured/);
});
