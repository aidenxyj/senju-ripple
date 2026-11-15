---
name: mac-calculator-desktop
description: Use when asked to open the native Mac Calculator app (not a web one) and compute a simple expression, or to drive any simple native Mac app via the desktop server.
revision: 1
updated: 2026-11-14
---

Plan: one desktop worker, no dependencies, no user involvement needed (apps are already signed in).

Method that worked:
1. launch_app Calculator (it starts in the background; no need for bring_to_front).
2. The first get_window_state may show no accessibility elements, and a pixel click may be refused. Call get_window_state a second time. The button tree then appears.
3. Press buttons with click using the element_token, in order (e.g. 1, 0, +, 1, 0, =). This works without focusing the window.
4. Verify the result with get_window_state and query "AXStaticText", which returns the display text. Report the result and the expression line.

Pitfalls: don't fall back to pixel clicks before the second get_window_state. Don't open Chrome for this. The web version is covered by chrome-web-calculator.

Leave the app open unless asked to close it.
