// Scrape an assignment's "Regrade Requests" list page (/courses/:cid/assignments/:aid/regrade_requests).
// Live layout seen: Sections | Question | Grader | Completed | Review; some courses also lead with a
// Student column and drop Sections. Columns are found by header text, never by position. Each row's
// Review link is a normal grade URL, so the grid can treat a request like any submission.
import { splitUser } from "./rows.js";

const DONE = new Set(["yes", "y", "true", "✓", "✔", "✅", "done", "complete", "completed", "closed", "resolved", "decided", "answered", "reviewed"]);
const PENDING = new Set(["", "-", "—", "–", "no", "n", "false", "open", "pending", "incomplete", "unresolved", "awaiting", "in progress", "not completed"]);
const PENDING_RE = /\b(?:not|pending|open|awaiting|incomplete|unresolved|in progress)\b/;
const MONTHS = "(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?";
const DATE_RE = new RegExp(`\\d{4}-\\d{1,2}-\\d{1,2}|\\b\\d{1,2}/\\d{1,2}/\\d{2,4}\\b|\\b${MONTHS}\\s+\\d{1,2}\\b|\\b\\d{1,2}\\s+${MONTHS}|\\b\\d{1,2}:\\d{2}\\b|\\bago\\b`, "i");
const CHECK_ICON_RE = /(^|\s)(fa-check\S*|icon-check\S*|glyphicon-ok\S*|bi-check\S*|checkmark\S*)(\s|$)/i;

// Completed cell → true (done) | false (open) | null (unreadable; the grid treats null as open so a
// request we cannot read is never hidden). Positive evidence only, like the MCP server's parser.
export function classifyCompleted(text, { hasCheckIcon = false } = {}) {
  const t = (text || "").replace(/\s+/g, " ").trim().toLowerCase();
  if (DONE.has(t)) return true;
  if (!t && hasCheckIcon) return true; // icon-only cell
  if (PENDING.has(t)) return false;
  if (PENDING_RE.test(t)) return false;
  if (DATE_RE.test(t)) return true;
  if (hasCheckIcon) return true;
  return null;
}

const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
// Resolution order matters: "Question" is claimed before the student/name heuristics so a header
// like "Question Name" can never be taken for the student column. Each header is claimed once.
const COLS = [
  ["question", ["question"]],
  ["grader", ["grader", "graded by", "last graded by", "assigned grader", "assigned to"]],
  ["completed", ["completed", "complete", "decided", "resolved", "closed", "status"]],
  ["section", ["section", "sections"]],
  ["student", ["student", "user", "name", "student name"]],
];
export function headerIndices(table) {
  let headers = [];
  const thead = table.querySelector("thead tr");
  if (thead) headers = [...thead.children].map((c) => norm(c.textContent));
  if (!headers.length) {
    const first = table.querySelector("tr");
    if (first && first.querySelector("th")) headers = [...first.children].map((c) => norm(c.textContent));
  }
  const out = { student: null, section: null, question: null, grader: null, completed: null };
  const taken = new Set();
  for (const [role, names] of COLS) {
    let i = headers.findIndex((h, idx) => !taken.has(idx) && names.includes(h));
    if (i === -1) i = headers.findIndex((h, idx) => !taken.has(idx) && h && names.some((n) => h.includes(n)));
    if (i !== -1) (out[role] = i), taken.add(i);
  }
  return out;
}

const NO_GRADER = new Set(["", "-", "--", "—", "–", "n/a", "none", "(none)", "unassigned", "(unassigned)"]);

// → { rows, tables }. Row: { sid, subId, qid, name, nameSource, question, grader, completed, section, gradeUrl, tr }.
// sid is `${qid}-${subId}`: the grade URL's submission id is probably shared across a student's
// questions, and the grid needs one cell per request.
export function collectRegradeRows(route) {
  const re = new RegExp(`/courses/${route.cid}/questions/(\\d+)/submissions/(\\d+)/grade`);
  const seen = new Set();
  const rows = [];
  const tables = new Set();
  const cols = new Map();
  for (const a of document.querySelectorAll("a[href]")) {
    const m = a.getAttribute("href").match(re);
    if (!m) continue;
    const [, qid, subId] = m;
    const sid = `${qid}-${subId}`;
    if (seen.has(sid)) continue;
    const tr = a.closest("tr");
    const table = tr?.closest("table");
    if (!tr || !table) continue;
    seen.add(sid);
    tables.add(table);
    if (!cols.has(table)) cols.set(table, headerIndices(table));
    const c = cols.get(table);
    const tds = [...tr.children];
    const text = (i) => (i == null || !tds[i] ? null : tds[i].textContent.replace(/\s+/g, " ").trim());
    const student = text(c.student);
    const name = student ? splitUser(student) : "";
    let grader = text(c.grader) || "";
    if (NO_GRADER.has(grader.toLowerCase())) grader = "";
    const compCell = c.completed != null ? tds[c.completed] : null;
    const hasCheckIcon = !!compCell && [...compCell.querySelectorAll("*")].some((el) => CHECK_ICON_RE.test(el.getAttribute("class") || "") || /#check/i.test(el.getAttribute("href") || el.getAttribute("xlink:href") || ""));
    const completed = compCell ? classifyCompleted(compCell.textContent, { hasCheckIcon }) : null;
    rows.push({
      sid,
      subId,
      qid,
      name: name || `#${subId}`,
      nameSource: name ? "table" : "fallback",
      question: text(c.question) || `Question ${qid}`,
      grader,
      completed,
      section: text(c.section) || "",
      gradeUrl: new URL(a.getAttribute("href"), location.origin).href,
      tr,
    });
  }
  return { rows, tables: [...tables] };
}
