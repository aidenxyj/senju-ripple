---
name: web-minesweeper-play
description: Use when asked to play one or several Minesweeper games (e.g. simultaneously) in Chrome via browser workers.
revision: 15
updated: 2026-11-15
---

# web-minesweeper-play
Use when asked to play one or several Minesweeper games (e.g. simultaneously) in Chrome via browser workers.

Plan shape: one browser worker per game (browser server only), all spawned in one turn so they run in parallel (also alongside other web games like Wordle). Each worker gets its own Chrome window. No sign-in or user help needed. The person wants to watch, so every move is its own click. Goal text can be identical for every worker; list this skill. A short goal is enough ("Play one Beginner game at minesweeper.online until win or loss, each move its own click, flag certain mines, report result, leave board open").

Site that worked: minesweeper.online.
- On the home page, use browser_find for the "Beginner" link (href /start/1) and click it. The URL /game/start/1 is a 404, so do not navigate to it. A pop-up on load may be closed automatically by the tool.
- Cells have ids `cell_X_Y` (X is the column, Y the row, from 0). Classes: `hd_closed`, `hd_flag`, `hd_typeN` (N is the number shown, hd_type0 is empty).
- A flagged cell has BOTH `hd_closed` and `hd_flag`, so check `hd_flag` first when reading.
- The face `#top_area_face` gets class `hd_top-area-face-win` on a win (a class ending in `lose` on a loss). On a win the site auto-flags the remaining mines (the last mine need not be clicked).

Method (fast: one model step per move batch):
1. Board reader, browser_evaluate, read only: `() => { let s=''; for (let y=0;y<9;y++){ for (let x=0;x<9;x++){ const c=document.getElementById('cell_'+x+'_'+y).className; s += /hd_flag/.test(c)?'F':/hd_closed/.test(c)?'#':/hd_type0\b/.test(c)?'.':(c.match(/hd_type(\d)/)||[,'?'])[1]; } s+='\n'; } return s + document.getElementById('top_area_face').className; }`
2. Work out every cell that is certainly a mine and every cell that is certainly safe, including chain constraints (a+b+c=1 and b+c+d=1) and the total of 10 mines. Do the reasoning briefly; do not re-derive the whole board each time. Read rows/columns carefully (x = column, y = row); a misread of an opened cell as closed has happened, and the next board output catches it. If you suspect a cell was misread, re-query that single cell's classList instead of re-parsing the whole grid.
3. In ONE reply, make all of this batch's clicks and end it with the board reader: right-clicks first (browser_click target "#cell_X_Y", button "right") to flag each certain mine, then left-clicks to reveal each certain safe cell, then the board-reader browser_evaluate as the last call of the same reply. The calls run in order, so you see the new board without spending an extra step on reading it. Re-verify chain deductions against the freshly displayed numbers: an over-flag from a miscount was caught when the next opened cell showed "3" already accounted for by known mines; un-flagging is cheap and undoing it keeps the person watching a correct board.
4. Repeat until the face class ends in win or lose.

Opening guesses (the first click is always safe on this site, later ones are not):
- Start with corner (0,0). It often opens a large area (then everything is deduction). If it opens only a "1", the next click is a real gamble (~1/8 to 1/3 risk). Corner (8,8) is a reasonable second try and has opened large regions that made the rest clean deduction; if that also opens only a "1" there is still nothing certain. Do NOT just click a third corner: a corner next to a "1" is risky, and a lost run did exactly this (lost on click 3). Instead, count the mines the constraints force and pick the cell with the lowest mine probability: a cell far from every number (probability about remaining mines / unknown cells, ~10/70) is usually safer than a neighbour of a "1" (about 1/3 for 3 candidates; 1/2 for 2). A middle/edge cell far from the "1"s can also open a larger area. A further fallback that worked twice: after corners leave only "1"s, clicking (4,4) and then (2,2) opened a large region and the rest was pure deduction (a recent winning run used (0,0)=1, (8,8)=1, (4,4)=1, then (2,2), after which the game was solved by constraints alone).
- Flag every certain mine as you go; the person wants to see flags. Do not flag a cell you are not sure of.
- Never run a script that clicks cells or solves the game.

Pitfall: a board can end in a true 50/50 (two unopened cells with identical neighbours, e.g. top-edge pair). It cannot be deduced; just guess and report honestly. A loss on a forced guess is acceptable. Leave the finished board open on screen.

On a win, the face class `hd_top-area-face-win` is definitive. Do not try to verify the mine count cell-by-cell: the site auto-flags the remaining mines on win, so a manual flag recount can show one short of 10 and mislead you. Trust the win class.
