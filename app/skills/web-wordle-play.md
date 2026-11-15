---
name: web-wordle-play
description: Use when asked to play Wordle (an unofficial free clone, not NYT) in Chrome via a browser worker, alone or alongside other web games.
revision: 11
updated: 2026-11-15
---

# web-wordle-play
Use when asked to play Wordle (an unofficial free clone, not NYT) in Chrome via a browser worker, alone or alongside other web games.

Plan shape: one browser worker (browser server only) per game, spawned in the same turn as the other games (e.g. with Minesweeper, see web-minesweeper-play). No sign-in or user help is needed. Put the probe rule below in the worker goal explicitly, in a sentence, not only via the skill.

Site that worked: wordleunlimited.org (unofficial clone, no account).
- The game is on the home page, https://wordleunlimited.org/. There is no /game page (it is a 404). Open the home page once and start playing.
- Start clicking SLATE straight away. Do not inspect or explore the page first: no snapshots, link lists or console reads before the first guess.
- The board and keyboard live inside the `game-app` shadow root. `document.querySelectorAll('button[data-key]')` finds nothing, and that is expected: browser_click with `button[data-key="s"]` still works, because the click looks inside shadow roots. Read rows only with the result script below.
- The help dialog on first load is closed when the page opens. If one is still there, click `.close-icon`.
- The person wants to watch. For every guess, click each letter on the on-screen keyboard (browser_click, target `button[data-key="s"]`, one key per call), then the Enter key (`button[data-key="↵"]`).
- Use the plain ancestor selector `button[data-key="x"]` for keys. Numeric snapshot references shift on every page re-render and can land on the wrong key (an A click landed on Enter; a T click landed on U). Fix a stray key by backspacing (`button[data-key="←"]`, one press per character) and re-reading the row's `letters` attribute before continuing.
- After each click, re-check the row's `letters` attribute with a read-only browser_evaluate; if the letter did not register, re-issue that click before moving on, and confirm the full 5-letter row is queued before pressing Enter.
- Read the result after each row with one read-only browser_evaluate: `() => [...document.querySelector('game-app').shadowRoot.querySelectorAll('game-row')].map(r => r.getAttribute('letters') + ':' + [...r.shadowRoot.querySelectorAll('game-tile')].map(t => t.getAttribute('evaluation')).join(','))`. Print the letter and the evaluation per tile together, in tile order, so they cannot misalign. Tiles are correct / present / absent. Put browser_wait_for time 2 before it, as the last calls of the same reply as the row's clicks.

Method:
- Guess 1: SLATE. Guess 2: five other common letters (e.g. CRONY/POINT-style) to test as many new letters as possible, even if not a candidate. This exact SLATE → CRONY opening was used end-to-end twice and solved the board; SLATE surfaced S and T present, CRONY surfaced R (green) and Y present with L/A/E/C/O/N all absent. Do not play guess 2 as a near-repeat of guess 1 (EARLY after SLATE reused A, L, E and learned little).
- Before each later guess, list 3 to 5 likely words that fit the feedback (greens, yellows not in tried spot, grays absent, repeats) in one short line. Keep reasoning brief: a long list stalls the turn.
- If more than 2 likely words remain, NEVER guess them one at a time. Build a probe word (need not be a candidate) that contains the distinguishing letters of the candidates, placed in non-green positions, and filler letters that are known-gray are fine. Examples: _AUNT (D,G,H,J,T,V) -> probe like "JIHAD"/"VOMIT"; _E_AL (candidates DECAL, MEDAL, LEGAL, PENAL, METAL, FERAL...) -> probe using D, M, G, C, F together, e.g. "FUDGY"/"MUCID"-style words. After the probe, guess the answer. Worked example: with the pattern _R___ plus S,T,Y and a repeated letter, the probe FUDGE came back fully absent and ruled out F, U, D, G in one move, collapsing the answer to TRYST and solving in 4 guesses. Confirmed working probes: FUDGE (established G present, F/U/D/E absent), MILKY (established I present, ruled out GRAAL; M/K/Y absent).
- With 1-2 candidates left, guess the likelier, more common word. In practice a good letter probe often collapses candidates to 1-2, and then the likelier word finishes it.
- Hard-mode is not enforced on this clone, so probes are legal.

Pitfalls:
- Probes must be REAL dictionary words. A non-word probe ("BDHKW") is rejected by the clone and leaves the row stuck with the letters still queued. Clear a stuck row with repeated backspace presses (`button[data-key="←"]`, one per character) before re-entering. A padded row (e.g. "midhu") is invalid for the same reason and must be cleared and re-entered as a clean 5-letter word.
- A Google ad vignette can briefly overlay the page (URL fragment `#google_vignette`) and swallow a click. It auto-dismisses; if a click seems lost, wait a moment and retry the key.

Report the answer and guess count.
