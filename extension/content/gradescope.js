// Gradescope internal surface: fetch a submission's grade page, read the
// SubmissionGrader React props, and POST grades back.

const MISSING_PDF = "missing_pdf";

export function makeLimiter(n) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= n || !queue.length) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => {
      active--;
      next();
    });
  };
  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
}

function absolute(url) {
  if (!url) return null;
  return url.startsWith("/") ? location.origin + url : url;
}

export async function fetchGradeCtx(gradeUrl) {
  const res = await fetch(gradeUrl, { credentials: "same-origin", headers: { Accept: "text/html" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (/\/login\b/.test(new URL(res.url).pathname)) throw new Error("Not logged in");
  const html = await res.text();
  const doc = new DOMParser().parseFromString(html, "text/html");
  const csrf = doc.querySelector('meta[name="csrf-token"]')?.getAttribute("content") || "";
  const el = doc.querySelector('[data-react-class="SubmissionGrader"]');
  if (!el) throw new Error("SubmissionGrader not found on grade page");
  let props;
  try {
    props = JSON.parse(el.getAttribute("data-react-props") || "{}");
  } catch (e) {
    throw new Error("SubmissionGrader props not JSON");
  }
  return normalize(props, csrf, gradeUrl);
}

function normalize(props, csrf, gradeUrl) {
  const question = props.question || {};
  const submission = props.submission || {};
  const allPages = (props.pages || [])
    .filter((p) => p && typeof p.url === "string" && p.url && !p.url.includes(MISSING_PDF))
    .slice()
    .sort((a, b) => (Number(a.number) || 0) - (Number(b.number) || 0));
  const { pages: taggedPages, source: taggedSource } = pickTaggedPages(props, allPages);
  const cropRects = props.crop_rects || question.parameters?.crop_rect_list || [];
  const rubricItems = props.rubric_items || question.rubric || [];
  const checked = new Set(
    (props.rubric_item_evaluations || []).filter((e) => e && e.present).map((e) => String(e.rubric_item_id))
  );
  const score = submission.score ?? null;
  const graded = typeof submission.graded === "boolean" ? submission.graded : score != null;
  const saveUrl = absolute(props.urls?.save_grade) || gradeUrl.replace(/\/grade$/, "/save_grade");
  // Never write through a save URL that belongs to another submission.
  const want = gradeUrl.match(/\/submissions\/(\d+)\//)?.[1];
  const got = saveUrl.match(/\/submissions\/(\d+)\//)?.[1];
  if (want && got && want !== got) throw new Error(`save URL targets submission ${got}, expected ${want}`);
  return {
    gradeUrl,
    saveUrl,
    csrf,
    props,
    question,
    submission,
    allPages,
    taggedPages,
    taggedSource,
    cropRects,
    rubricItems,
    checked,
    evaluation: props.evaluation || {},
    score,
    graded,
    fetchedAt: Date.now(),
  };
}

// Heuristic: find which of allPages are the student's tagged pages for this
// question. Gradescope's exact prop name is not known in advance, so look for
// any array under a /page/ key whose values resolve to existing page ids or
// numbers. Prefer keys that smell like a per-question selection.
export function pickTaggedPages(props, allPages) {
  if (!allPages.length) return { pages: [], source: "none" };
  const byId = new Map(allPages.map((p) => [String(p.id), p]));
  const byNum = new Map(allPages.map((p) => [String(p.number), p]));
  const candidates = [];

  const visit = (obj, path, depth) => {
    if (!obj || typeof obj !== "object" || depth > 4) return;
    for (const [k, v] of Object.entries(obj)) {
      const here = path.concat(k);
      if (path.length === 0 && k === "pages") continue; // the full list itself
      if (Array.isArray(v)) {
        if (/page/i.test(k) && v.length) candidates.push({ key: here.join("."), values: v });
      } else if (v && typeof v === "object") {
        visit(v, here, depth + 1);
      }
    }
  };
  visit(props, [], 0);

  const rank = (key) => (/select|tagged|question_submission|chosen/i.test(key) ? 0 : /crop/i.test(key) ? 2 : 1);
  candidates.sort((a, b) => rank(a.key) - rank(b.key));

  for (const c of candidates) {
    const picked = new Set();
    for (const v of c.values) {
      let p = null;
      if (Number.isInteger(v) || typeof v === "string") p = byId.get(String(v)) || byNum.get(String(v));
      else if (v && typeof v === "object") {
        p =
          (v.id != null && byId.get(String(v.id))) ||
          (v.page_id != null && byId.get(String(v.page_id))) ||
          (v.page_number != null && byNum.get(String(v.page_number))) ||
          (v.number != null && byNum.get(String(v.number))) ||
          null;
      }
      if (p) picked.add(p);
    }
    if (picked.size && picked.size < allPages.length) {
      return { pages: allPages.filter((p) => picked.has(p)), source: c.key };
    }
    if (picked.size === allPages.length && picked.size) {
      return { pages: allPages, source: c.key };
    }
  }
  return { pages: allPages, source: "all" };
}

export function scoringType(ctx) {
  const t = ctx.question?.scoring_type;
  return typeof t === "string" && t.trim() ? t.trim() : null; // null → assume negative
}

// Mirrors Gradescope scoring: negative = full − Σ checked weights; positive = Σ weights.
export function projectScore(ctx, checkedIds, pointAdj) {
  const q = ctx.question || {};
  const weight = parseFloat(q.weight);
  if (!Number.isFinite(weight)) return null;
  const floor = q.floor == null ? true : !!q.floor;
  const ceiling = q.ceiling == null ? true : !!q.ceiling;
  const w = new Map(ctx.rubricItems.map((ri) => [String(ri.id), parseFloat(ri.weight) || 0]));
  let sum = 0;
  for (const id of checkedIds) sum += w.get(String(id)) || 0;
  const pa = pointAdj == null || pointAdj === "" ? 0 : parseFloat(pointAdj) || 0;
  let score = (scoringType(ctx) || "negative") === "positive" ? sum + pa : weight - sum + pa;
  if (floor && score < 0) score = 0;
  if (ceiling && score > weight) score = weight;
  return score;
}

// Replace semantics: every rubric id is sent, chosen ones "true", rest "false".
// points/comments undefined → keep the submission's existing values.
export async function saveGrade(ctx, { checkedIds, points, comments }) {
  const chosen = new Set([...checkedIds].map(String));
  const rubric_items = {};
  for (const ri of ctx.rubricItems) rubric_items[String(ri.id)] = { score: chosen.has(String(ri.id)) ? "true" : "false" };
  const body = {
    rubric_items,
    question_submission_evaluation: {
      points: points === undefined ? ctx.evaluation.points ?? null : points,
      comments: comments === undefined ? ctx.evaluation.comments ?? null : comments,
    },
  };
  const res = await fetch(ctx.saveUrl, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "X-CSRF-Token": ctx.csrf,
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-Requested-With": "XMLHttpRequest",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`save_grade HTTP ${res.status}`);
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("text/html")) throw new Error("save_grade returned HTML (session expired?)");
  return ct.includes("json") ? res.json().catch(() => ({})) : {};
}
