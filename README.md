# Gradescope Grid Grader

A Chrome extension that shows every student's answer to one Gradescope question side by side in a
grid, so you can scan, compare and batch-grade them instead of clicking through submissions one at
a time. It runs in your browser on your own Gradescope login. It has **no AI/LLM** and no build
step.

## Get started

### 1. Install

1. Get the code: `git clone https://github.com/huangworld/gradescope-grid-view.git`
   (or **Code → Download ZIP** on GitHub and unzip).
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick the `extension/` folder (the one containing `manifest.json`),
   not the repo root.
4. Optional: pin **Gradescope Grid Grader** from the puzzle-piece menu.

### 2. Open the grid

1. Log in to [gradescope.com](https://www.gradescope.com).
2. Go to course → assignment → **Grade Submissions** → click a question. The URL looks like
   `https://www.gradescope.com/courses/<cid>/questions/<qid>/submissions`.
3. Click the **Grid view (N)** button (top right). Each cell is one student's pages for that
   question. Cells load as you scroll; `⋯` → **Load all submissions** loads the rest.

### 3. Grade

1. Page through answers with `←` / `→` (moves every cell at once). Resize cells with the slider.
2. Select students: click a cell (or its tick), shift-click for a range. **Clear selection** resets.
3. Click **Grade selected**, tick rubric items (number keys `1`–`9` work), optionally add a point
   adjustment or comment, check the projected score, and apply.
4. Or click **Open in tabs** to open the native grader for each selected student.
5. The first time, open one graded submission in the native grader to confirm the save went through.

### Updating

After `git pull`, click the reload icon on the extension card in `chrome://extensions`, **then
reload the Gradescope page**. A stale page loses its link to the extension and buttons like
*Open in tabs* stop working.

## Features

- one cell per student showing that student's tagged pages for the question
- `◀ ▶` / arrow keys page **every** cell at once (cells with fewer pages stay put)
- cell size slider, remembered between visits
- **Pages: tagged / all** switch, **Crop** (dim outside the question region, fixed-template
  assignments), filter (all / ungraded / graded), sort (name / score)
- `⋯` menu: load all submissions, reset all to page 1, dump props (debug)
- graded / ungraded marker per cell, `graded k/N` counter, filter + sort
- multiselect (click image or tick, shift-click range) →
  - **Open in tabs**: native grader for each selected student
  - **Grade selected**: pick rubric items (+ optional point adjustment / comment), see projected
    score, apply to all selected in one click (replace semantics: unchosen items get unchecked)

## Keyboard

| Key | Action |
|-----|--------|
| `←` / `→` | Previous / next page in every cell |
| `Esc` | Close the grid |
| `1`–`9` | Toggle rubric items in the grading panel |

## No AI / LLM

The extension makes **no LLM or AI calls** and never interprets student work. All grading
decisions are made by the human grader. Its only network requests go to `www.gradescope.com` with
your own login session:

- fetch each submission's grade page (to show the page images and rubric)
- post the grades **you** choose

`extension/manifest.json` grants host access to `https://www.gradescope.com/*` only. No data is
sent to any other server.

## How it uses gradescope-mcp

This repo is a fork of [Yuanpeng-Li/gradescope-mcp](https://github.com/Yuanpeng-Li/gradescope-mcp)
(MIT). Gradescope has no public API; that project had already worked out its internal endpoints
and payloads. The extension reuses that knowledge only:

- where a submission's grade page lives and how its data (pages, rubric, score) is embedded
- how the `save_grade` request is shaped

The extension does **not** run, import or call the MCP server, and needs no Python or MCP client.
The upstream server code is still in this repo (`src/`, `tests/`), unchanged and optional; its docs
are in [`MCP_SERVER.md`](MCP_SERVER.md).

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

## Caveats

- Uses Gradescope's internal, undocumented endpoints. They can change without notice.
- Batch grading **replaces** the rubric selection on each selected submission. Blank point
  adjustment / comment keeps each submission's existing values.

## Repo layout

```text
extension/      Chrome extension (manifest.json, background.js, content/)
MCP_SERVER.md   docs for the upstream MCP server (optional, not used by the extension)
src/, tests/    upstream MCP server code (unchanged)
```

## License

MIT. The extension is © Zhicheng Huang (`extension/LICENSE`); the upstream MCP server is
© Yuanpeng Li (`LICENSE`).
