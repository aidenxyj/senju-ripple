# OpenApps-style apps

`apps.mjs` serves three small apps on one local site, written from scratch for our evals. They're modeled on [OpenApps](https://github.com/facebookresearch/OpenApps), but OpenApps itself is CC BY-NC and Python, so none of its code or data is copied. Only the task goals and expected values in `config/tasks/original_tasks.yaml` (titles, dates, the to-do names, Bob's reply) are reused.

| App | Path | What you can do |
|---|---|---|
| Calendar | `/calendar` | See events, add one (Title, Date `YYYY-MM-DD` (other common formats accepted), Location, Description), delete one |
| To-do | `/todo` | Add an item, mark it done or not done, delete it |
| Messenger | `/messenger?with=<name>` | Chat with Alice, Bob, Carol or Dennis. Each contact replies right away (Bob: "Yes, let's play on Saturday!") |

Everything is a server-rendered page with labelled inputs and buttons and forms that POST and redirect. There's no canvas and no client-side JS, so a text-only agent can use them through the accessibility tree.

`startOpenApps()` returns `{ url, state, seed, close }`. `state` is a plain object `{ events, todos, contacts, threads }` that the checkers read directly. The starting state (`SEED`) includes a trap for the remove task: "WACV 2026 Paper Deadline" sits next to "WACV 2026 Abstract Deadline".

## Tasks (`evals/tasks/benchmarks/openapps-*.js`)

| Task id | OpenApps task (type) | Pass when |
|---|---|---|
| `openapps-add-meeting-with-dennis` | `add_meeting_with_dennis` (AddEventTask) | An event "Dennis-Bob" on 2026-04-01 exists, and no seeded event was deleted |
| `openapps-remove-wacv-abstract-deadline` | `remove_wacv_abstract_deadline` (RemoveEventTask) | The abstract deadline is gone, and every other event is still there |
| `openapps-add-call-mom-to-my-todo` | `add_call_mom_to_my_todo` (AddToDoTask) | An open "Call Mom" item exists, and the other items are unchanged |
| `openapps-mark-water-plants-as-done` | `mark_water_plants_as_done` (MarkToDoDoneTask) | "Water plants" is done and still listed, and the other items are unchanged |
| `openapps-message-bob-to-meet` | `message_bob_to_meet` (SendMessageTask) | You sent Bob "Let's meet", his reply is there, and nobody else was messaged |

Titles and names are compared trimmed and case-insensitively. Message text also ignores curly quotes and end punctuation.
