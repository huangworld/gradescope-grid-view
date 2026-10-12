# Gradescope Grid Grader

Chrome extension (MV3, no build step). On a question's **Grade Submissions** page
(`/courses/<cid>/questions/<qid>/submissions`) it adds a **Grid view** toggle:

- one cell per student showing that student's tagged pages for the question
- `◀ ▶` / arrow keys page **every** cell at once (cells with fewer pages stay put)
- cell size slider + quick column presets, persisted
- graded / ungraded marker per cell, `graded k/N` counter, filter + sort
- multiselect (click image, shift-click range, select all) →
  - **Open in tabs**: native grader for each selected student
  - **Grade selected**: pick rubric items (+ optional point adjustment / comment), see projected
    score, apply to all selected in one click (replace semantics: unchosen items get unchecked)

## Install

1. Get the code: `git clone https://github.com/huangworld/gradescope-grid-view.git`
   (or **Code → Download ZIP** on GitHub and unzip).
2. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → pick the `extension/`
   folder (the one containing `manifest.json`), not the repo root.
3. In Gradescope: course → assignment → **Grade Submissions** → click a question. The URL looks like
   `.../courses/<cid>/questions/<qid>/submissions`. A **Grid view** button appears top-right.
4. After updating the code: click the reload icon on the extension card, **then reload the page**
   (a stale page loses its connection to the extension and buttons like *Open in tabs* stop working).

## Usage

- Click a cell (or its tick) to select; shift-click for a range; **Clear selection** resets.
- `←` / `→` or the toolbar page buttons move every cell one page; `Esc` closes the grid.
- In the grading panel, number keys `1`–`9` toggle rubric items.

## First-run checks (unknowns from reverse engineering)

- **Tagged pages vs all pages.** The grader page embeds all page images; which of them are the
  student's *tagged* pages for this question is detected heuristically. If a cell shows too
  many/few pages, open the toolbar `⋯` menu → **Dump props** (logs + copies the first loaded
  submission's React props) and adjust `pickTaggedPages` in `content/gradescope.js`.
  The toolbar also has a **Tagged / All** pages switch.
- **Row scraping.** Rows come from `<a href=".../submissions/<sid>/grade">` links in the native
  table. If the grid shows 0 students but the table has rows, see `collectRows` in `content/rows.js`.

## No AI / LLM

The extension makes **no LLM or AI calls** and never sends student work anywhere but Gradescope.
Its only network requests go to `www.gradescope.com` with your own login session: fetching each
submission's grade page (to show the images) and posting the grades *you* pick. All grading
decisions are made by the human grader. `manifest.json` grants host access to
`https://www.gradescope.com/*` only.

## Relationship to gradescope-mcp

This repo is a fork of [Yuanpeng-Li/gradescope-mcp](https://github.com/Yuanpeng-Li/gradescope-mcp)
(MIT), a Python MCP server for Gradescope. The extension builds on what that project documents
about Gradescope's internal endpoints and payloads (grade page props, `save_grade`). It does
**not** run, import or call the MCP server: it is plain JavaScript in the browser, and you can use
it without installing Python or any MCP client.

## Caveats

- Uses Gradescope's internal, undocumented endpoints (`/grade` page props and `save_grade` POST).
  They can change without notice. Verify the first batch save in the native grader.
- Page images are signed S3 URLs that expire; a broken image triggers one automatic refetch.
- Batch grading **replaces** the rubric selection on each selected submission. Blank point
  adjustment / comment keeps each submission's existing values.
