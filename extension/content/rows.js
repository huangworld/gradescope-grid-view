// Scrape the question's "Grade Submissions" list page for submission rows.

export function parseRoute(href = location.href) {
  const m = new URL(href).pathname.match(/^\/courses\/(\d+)\/questions\/(\d+)\/submissions\/?$/);
  return m ? { cid: m[1], qid: m[2] } : null;
}

export function gradeUrlFor({ cid, qid }, sid) {
  return `${location.origin}/courses/${cid}/questions/${qid}/submissions/${sid}/grade`;
}

const USER_HDR = /^(user|name|student|student name|full name)$/i;
const SCORE_HDR = /^(score|points|grade)$/i;
const GRADED_HDR = /graded/i;
const YES = new Set(["yes", "y", "true", "✓", "✔", "graded"]);
const NO = new Set(["no", "n", "false", "ungraded", "-", "—", ""]);

function headerIndices(table) {
  let headers = [];
  const thead = table.querySelector("thead tr");
  if (thead) headers = [...thead.children].map((c) => c.textContent.trim());
  if (!headers.length) {
    const first = table.querySelector("tr");
    if (first && first.querySelector("th")) headers = [...first.children].map((c) => c.textContent.trim());
  }
  const find = (re) => {
    const i = headers.findIndex((h) => re.test(h));
    return i === -1 ? null : i;
  };
  return { user: find(USER_HDR), score: find(SCORE_HDR), graded: find(GRADED_HDR) };
}

function splitUser(text) {
  // "Jane Doe jane@ucsd.edu" / "Jane Doe (jane@ucsd.edu)" → name only
  return text.replace(/[\s(]*[^\s()]+@[^\s()]+[)]?\s*$/, "").trim() || text.trim();
}

export function collectRows(route) {
  const { cid, qid } = route;
  const re = new RegExp(`/courses/${cid}/questions/${qid}/submissions/(\\d+)/grade`);
  const seen = new Set();
  const rows = [];
  const tables = new Set();
  const cols = new Map();

  for (const a of document.querySelectorAll("a[href]")) {
    const m = a.getAttribute("href").match(re);
    if (!m) continue;
    const sid = m[1];
    if (seen.has(sid)) continue;
    seen.add(sid);

    const tr = a.closest("tr");
    const table = tr?.closest("table");
    let name = a.textContent.trim();
    let score = null;
    let graded = null;

    if (tr && table) {
      tables.add(table);
      if (!cols.has(table)) cols.set(table, headerIndices(table));
      const c = cols.get(table);
      const cells = [...tr.children].map((td) => td.textContent.trim());
      if (c.user != null && cells[c.user]) name = splitUser(cells[c.user]);
      if (c.score != null && cells[c.score] !== undefined) {
        const t = cells[c.score];
        const num = parseFloat(t);
        score = Number.isFinite(num) ? t : null;
      }
      if (c.graded != null && cells[c.graded] !== undefined) {
        const f = cells[c.graded].toLowerCase();
        if (YES.has(f)) graded = true;
        else if (NO.has(f)) graded = false;
      }
      if (graded == null && c.score != null) graded = score != null;
      // link text may be an action label ("Grade") rather than the student
      if (/^(grade|view|open|regrade)$/i.test(name) || !name) {
        name = splitUser(cells.find((t) => t && t !== sid && !/^\d+(\.\d+)?(\s*\/\s*\d+(\.\d+)?)?$/.test(t) && !/^(yes|no|grade|view)$/i.test(t)) || "");
      }
    }
    rows.push({ sid, name: name || `#${sid}`, score, graded, gradeUrl: gradeUrlFor(route, sid), tr });
  }
  return { rows, tables: [...tables] };
}
