---
name: chrome-web-calculator
description: Use when asked to open a calculator in Chrome and compute a simple arithmetic expression (or do any trivial one-page web widget task).
revision: 1
updated: 2026-11-14
---

Plan shape: one browser worker, no dependencies, no user involvement (no sign-in needed). Don't spawn more.

Method that worked:
1. browser_navigate to https://www.google.com/search?q=calculator (Google's built-in calculator widget). No consent page or block appeared.
2. browser_snapshot to get refs for each calculator button.
3. browser_click one button per key in order (e.g. 1, 0, +, 1, 0, =).
4. browser_take_screenshot to verify the result display, and report the result.
5. Leave the window open so the user can see it.

Fallback if Google blocks or shows a captcha: https://www.calculator.net/ and do the same clicks.

Notes: The browser worker opens its own fresh Chrome window, not the user's existing Chrome. That was acceptable for "open calculator in Chrome". Only use a desktop worker if the user explicitly wants their own already-open Chrome. Typing into the widget is not needed; clicking buttons matches the request. Whole job takes one worker run.
