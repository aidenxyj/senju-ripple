---
name: google-fact-lookup
description: Use when asked to find a statistic, fact, "who is X" person lookup, or someone's website/profile page on google. For a website or page, open it on screen by clicking the result.
revision: 5
updated: 2026-11-14
---

Plan: one browser worker is enough; no sign-in or user involvement needed. Spawn it with the browser server only. Pass this skill in its skills list. Goal under 80 words.

Method that worked (four times):
- Go to google.com, type the query into textarea[name=q] with browser_type (submit). No cookie banner or login appeared.
- Read results with browser_evaluate on document.body.innerText; faster than snapshots or screenshots. Two calls total is typical. Read the AI Overview, top results, "People also ask" and related searches.
- Prefer the official source (institution's own facts page, Common Data Set, official people/profile page, the person's own site) over aggregators. Ask the worker to report figure/role, year, definition, and source URL.

Statistic lookups:
- Google often shows no single headcount; sources disagree on year/definition. Have the worker give a table of sources, pick the most reliable, and label self-computed numbers (percent x enrollment) as calculations.
- If an exact count is required, tell the worker up front to open the official dataset (e.g. Common Data Set PDF) rather than stopping at search results.

Person / website lookups ("who is <common name> at <institution>", "find <name> <institution> website"):
- Common names have several matches. Ask the worker to return the top 2-4 distinct people with role, department, and source URL, and to flag a likely different namesake that appears in related searches but isn't tied to the institution.
- Spelling variants get mixed in the results (e.g. Chen vs Cheng, Cheng vs Chang). Google may auto-correct, and the AI Overview can mix up people. Tell the worker to check claims against result snippets and report which spelling each hit has. If the top hit has a different spelling than the user typed, still open it, but state the spelling difference up front and list the exact-spelling match as the alternative, so the user can redirect.
- A personal site (own domain) is often the top hit while there is no institutional profile page; say so explicitly rather than implying one exists. Newly announced faculty may only be "incoming".
- When the goal is to find a website or page, the person wants to see it open. After reading the results, use browser_find to get the ref of the matching title link, then browser_click it (don't type the address into browser_navigate). Confirm the page that loads is the right person's and leave it open on screen. Report its URL too.
- For a plain fact or "who is X" question, the first results page alone is usually enough; say in the final answer that only the first results page was read.

Final answer to the user: lead with the most reliable figure/person/URL, then 2-3 alternatives with a one-line reason each. Keep short.
