---
name: outlook-send-email-mac
description: Use when asked to send an email from the native Outlook Mac app (optionally alongside a web task such as opening a YouTube video) via desktop and browser workers.
revision: 2
updated: 2026-11-14
---

Plan shape: two independent workers in parallel, one turn.
1. Outlook worker (desktop server, needs_user=true).
2. Any web side task (e.g. open a YouTube video) as a browser worker. No dependency between them.

Outlook method (worked first try):
- launch_app Outlook with urls ["mailto:<addr>?subject=<s>&body=<b>"]. This opens a pre-filled compose window straight away. Launching Outlook with no URL leaves no usable window.
- list_windows to get the compose window id, then get_window_state to verify To, Subject and body.
- Ask the user once for send approval, quoting the exact To, subject and body. Mention that Outlook may append a "Get Outlook for Mac" signature line and which account it sends from. Ask before sending, not after.
- Sending: clicking Send via accessibility only marks it pressed and the window stays open. Use hotkey cmd+return with delivery_mode "foreground" (briefly brings the window to the front). Confirm that the compose window closed.
- Verify in the Sent folder with get_window_state and a query for the subject. Report the sending account and the time.
- If the user declines, leave the draft and report "not sent".

YouTube / "open this video" method (browser worker, took ~1 minute, no user needed):
- browser_navigate straight to https://www.youtube.com/results?search_query=<terms>. No sign-in or cookie banner got in the way.
- browser_find with a regex for the result title gives the link ref (and shows the Official Artist Channel badge). browser_click on that ref opens the video on screen.
- Confirm playback with browser_evaluate reading the video element's paused and currentTime. Report title, URL and whether it is playing. For Rick Astley, pick the official artist channel result.

Needs user: only the email send approval. Do not ask for anything else.

User interruptions: if the user says "do nothing" / stops mid-job (seen twice with this goal, while the Outlook worker waited on send approval), stop the Outlook worker, do not send, tell the user the email was not sent and that the draft may remain open. Do not respawn unless asked.
