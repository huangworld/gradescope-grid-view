# Gradescope Grid Grader

A Chrome extension that shows every student's answer to one Gradescope question side by side in a
grid, so you can scan, compare and batch-grade them instead of clicking through submissions one at
a time. It runs in your browser on your own Gradescope login. It has **no AI/LLM** and no build
step. A **find** box filters the grid by text (typed answers, or local OCR of the page images).

## Get started

### 1. Install

1. Get the code: `git clone https://github.com/huangworld/gradescope-grid-view.git`
   (or **Code → Download ZIP** on GitHub and unzip).
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Optional, for OCR in the find box: run `scripts/fetch-vendor.sh` once (needs `curl`). It
   downloads tesseract.js and the English model (~10 MB) into `extension/vendor/`. Without it the
   extension still works; only **OCR: on** fails.
4. Click **Load unpacked** and pick the `extension/` folder (the one containing `manifest.json`),
   not the repo root.
5. Optional: pin **Gradescope Grid Grader** from the puzzle-piece menu.

### 2. Open the grid

1. Log in to [gradescope.com](https://www.gradescope.com).
2. Go to course → assignment → **Grade Submissions** → click a question. The URL looks like
   `https://www.gradescope.com/courses/<cid>/questions/<qid>/submissions`.
3. Click the **Grid view (N)** button (top right). Each cell is one student's pages for that
   question. Cells load as you scroll; `⋯` → **Load all submissions** loads the rest.

### 3. Grade

1. Page through answers with `←` / `→` (moves every cell at once). Resize cells with the slider.
2. Select students: click a cell (or its tick), shift-click for a range. **Select all** selects
   every cell passing the current filter + find; **Clear selection** resets.
3. Click **Grade selected**, tick rubric items (number keys `1`–`9` work), optionally add a point
   adjustment or comment, check the projected score, and apply. The panel opens blank every time
   (nothing carries over from the previous batch). Once every save succeeds the panel closes and the
   selection clears; if any save fails it stays open listing the failures.
4. Or click **Open in tabs** to open the native grader for each selected student.
   **Clear comments** blanks the comment on each selected *graded* submission, re-sending its
   current rubric items and point adjustment so the score is unchanged. Ungraded submissions are
   skipped (saving would grade them), as are ones with no comment.
5. The first time, open one graded submission in the native grader to confirm the save went through.

### 4. Find

Type in the **find** box (or `Ctrl`/`Cmd`+`F`) to keep only the cells whose text matches:

| Query | Matches |
|-------|---------|
| `foo bar` | both words (implicit AND; case-insensitive) |
| `foo OR bar`, `foo \| bar` | either |
| `NOT foo`, `-foo`, `!foo` | exclude |
| `"a phrase"` | the exact phrase |
| `/re+gex/i` | a JavaScript regex (`i` added when no flags given) |
| `foo AND (bar OR /ba+z/) NOT qux` | grouping; precedence NOT > AND > OR |

What counts as a cell's text:

- **typed answers** of online assignments, if the grade page carries them (heuristic; see
  Troubleshooting if nothing matches);
- with **OCR: on**, the text tesseract.js reads off the pages currently shown in each cell
  (respects **Pages: tagged / all** and **Crop**). OCR runs locally in the extension, a few seconds
  per page, results are cached while the grid is open. It reads printed/typed text; **handwriting
  is mostly missed**.

Matches are **grounded on the image**: with OCR on, the words on the shown page that satisfy the
query's positive terms (anything not under `NOT`) get a yellow box, so you can see at a glance where
the hit is and whether OCR read it right. Boxes are stored with the index. A matching cell without
boxes means the hit is on another page of that student, or came from the typed answer.

**Index pages** does all the work up front: it loads every submission and OCRs every page shown
(for the current **Pages** / **Crop** setting), with a progress bar and a **✕ Cancel index** button
(pages already done are kept). The index is stored per question in extension storage, so after
closing the grid or reloading the page find is instant; the button reads **Indexed ✓ N** when
nothing is missing. Changing **Pages** or **Crop** needs a re-index (the button shows how many pages
are still missing). Without indexing, OCR runs lazily for whatever the current query needs.

Cells whose text isn't known yet (still loading, OCR pending) stay visible but dimmed, so the grid
doesn't flicker; the status line shows `find k/N (p pending) · OCR d/t`. A query with a syntax
error turns the box red and keeps the previous filter. `Esc` clears the box, a second `Esc` leaves
it. Find stacks with the graded/ungraded filter, and the usual selection tools work on the result
(e.g. select all matches → **Grade selected**).

### Updating

After `git pull`, click the reload icon on the extension card in `chrome://extensions`, **then
reload the Gradescope page**. A stale page loses its link to the extension and buttons like
*Open in tabs* stop working.

## Features

- one cell per student showing that student's tagged pages for the question
- `◀ ▶` / arrow keys page **every** cell at once (cells with fewer pages stay put)
- cell size slider, remembered between visits
- **Pages: tagged / all** switch, **Crop** (dim outside the question region, fixed-template
  assignments), filter (all / ungraded / graded), sort (name / score / recently graded — newest
  first; times come from grades saved in this extension, persisted per question, plus any
  timestamp the grade page exposes; graded-but-unknown-time cells follow, ungraded last)
- **find** box: boolean query (`AND` / `OR` / `NOT`, `"phrases"`, `/regex/`, parentheses) over
  typed answers and, with **OCR: on**, locally OCR'd page text; pending cells dimmed
- **Index pages**: OCR every page of every student once (progress bar, cancel), stored per
  question so later finds are instant
- matched words highlighted on the page image (word boxes from OCR)
- `⋯` menu: load all submissions, reset all to page 1, dump props (debug)
- graded / ungraded marker per cell, `graded k/N` counter, filter + sort
- multiselect (click image or tick, shift-click range, **Select all** visible) →
  - **Open in tabs**: native grader for each selected student
  - **Clear comments**: blank the comment on selected graded submissions, grade untouched
  - **Grade selected**: pick rubric items (+ optional point adjustment / comment), see projected
    score, apply to all selected in one click (replace semantics: unchosen items get unchecked)

## Keyboard

| Key | Action |
|-----|--------|
| `←` / `→` | Previous / next page in every cell |
| `Ctrl`/`Cmd` + `F` | Focus the find box |
| `Esc` (in find box) | Clear the box, then leave it |
| `Esc` | Close the grid |
| `1`–`9` | Toggle rubric items in the grading panel |

## No AI / LLM

The extension makes **no LLM or AI calls** and never interprets student work. All grading
decisions are made by the human grader. Its network requests, all with your own login session:

- fetch each submission's grade page from `www.gradescope.com` (to show the page images and rubric)
- post the grades **you** choose to `www.gradescope.com`
- load the page images themselves, which Gradescope serves from signed Amazon S3 links (the same
  images the page shows)

OCR is [tesseract.js](https://github.com/naptha/tesseract.js) (classic Tesseract compiled to
WebAssembly), bundled by `scripts/fetch-vendor.sh` and run inside the extension in your browser.
It is off by default, loads nothing from a CDN, and no image or text leaves your machine.
`extension/manifest.json` grants host access to `https://www.gradescope.com/*` and
`https://*.amazonaws.com/*` (image fetch for OCR) only. The OCR index (text + word boxes per page)
lives in the extension's local storage (`unlimitedStorage`); it never leaves the browser.

## How it uses gradescope-mcp

[Yuanpeng-Li/gradescope-mcp](https://github.com/Yuanpeng-Li/gradescope-mcp) (MIT) is a Python
MCP server for Gradescope. Gradescope has no public API; that project had already worked out its
internal endpoints and payloads. The extension reuses that knowledge only:

- where a submission's grade page lives and how its data (pages, rubric, score) is embedded
- how the `save_grade` request is shaped

The extension does **not** run, import or call the MCP server, and needs no Python or MCP client.
The upstream project is included as a git submodule at `gradescope-mcp/`, pinned to the version the
endpoint details came from, for reference only. A plain clone leaves it empty, which is fine for
using the extension. To fetch it:

```sh
git submodule update --init
```

## Troubleshooting

- **No Grid view button.** Make sure you are on a single question's submissions page (URL ends in
  `/questions/<qid>/submissions`) and reload the page after installing or updating.
- **Cells show too many/few pages.** Which pages are "tagged" for a question is detected
  heuristically. Try the toolbar **Pages: tagged / all** switch. To fix it, open the toolbar `⋯` menu →
  **Dump props** (logs + copies the first loaded submission's data) and adjust `pickTaggedPages`
  in `extension/content/gradescope.js`.
- **Grid shows 0 students but the table has rows.** Rows come from
  `<a href=".../submissions/<sid>/grade">` links in the native table; see `collectRows` in
  `extension/content/rows.js`.
- **Broken image.** Page images are signed links that expire; a broken image is refetched once
  automatically. Reload the page if it persists.
- **Find matches nothing on an online assignment.** Typed answers are pulled from the grade page
  heuristically (`answerText` in `extension/content/gradescope.js`). `⋯` → **Dump props** on a
  loaded cell and look for the answer text in the JSON; add its key to `answerText`.
- **Highlight boxes slightly off / missing.** Boxes come from OCR word positions; a misread word has
  no box even if the cell matched via another word. If boxes are consistently shifted, the page
  image size differs from what Gradescope reports; `⋯` → **Dump props** and file an issue.
- **OCR never finishes / "OCR document did not answer".** Run `scripts/fetch-vendor.sh`, then
  reload the extension and the page. For details open `chrome://extensions` → the extension's
  **Inspect views** → `offscreen.html` (console shows worker errors). OCR only reads printed or
  typed text; for handwriting expect few or no matches. If the image host is not
  `*.amazonaws.com` on your Gradescope, OCR fetches fail with an HTTP/CORS error: check a page URL
  in **Dump props** and adjust `host_permissions` in `extension/manifest.json`.

## Caveats

- Uses Gradescope's internal, undocumented endpoints. They can change without notice.
- Batch grading **replaces** the rubric selection on each selected submission. Blank point
  adjustment / comment keeps each submission's existing values.

## Repo layout

```text
extension/        Chrome extension (manifest.json, background.js, offscreen.{html,js}, content/)
extension/vendor/ tesseract.js runtime, created by scripts/fetch-vendor.sh (gitignored)
tests/            node --test 'tests/*.test.mjs' (unit, no deps); tests/e2e/ browser harness (see its README)
gradescope-mcp/   upstream MCP server, git submodule (reference only, not used by the extension)
```

## License

MIT © Zhicheng Huang (`LICENSE`). The `gradescope-mcp` submodule is MIT © Yuanpeng Li, under
its own license.
