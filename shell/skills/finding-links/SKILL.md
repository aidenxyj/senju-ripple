---
name: finding-links
description: How to find and pick the right link, button, field or icon on a web page through senju, especially on big pages where senju look shows only the start.
revision: 3
updated: 2026-11-14
---

`senju look` shows only the first part of a page (about 6000 characters). On a big site (a store, a news front page, a long article) the link you need is often not in it. Do not page through look to hunt for it. Search for it.

How to get to the right element:
1. `senju find "words from the goal"`. It searches every element on the page, and also icons and menu items that look does not show (a trash can, a "more" button). It prints the best 8 with ids you can click, best first. Example: `senju find "order history"`, `senju find "trash Tiffanie"`, `senju find "more @quis"`.
2. Pick the result whose name AND link path fit the goal. For "my orders", `-> /account/orders` is right and `-> /help/orders` is not. An element with no name still shows its link path, so `link -> /cart` is the cart link.
3. When several results have the same name (five "Delete" buttons, one per row), the `(in: ...)` text says which row or card each one is in. Pick the one whose row names your item.
4. `senju click <id>`. Icon ids look like i3 and work the same way as e12.

Getting to the right site or page:
- Never make up a web address. A guessed address (calculator.google.com, /orders) usually does not exist and wastes the try. If you are not sure of the exact address, run `senju search "words"` first and click the right result, then `senju find` on that page.
- A path you have SEEN on this site, in a link's `-> /path` or in the goal, can be opened directly: `senju open /messenger?with=Bob`. A path that starts with / opens on the current site.
- `senju click "Order history"` clicks by visible label when the label is unique.

Picking the tool's own controls, not the site's search box:
- A textbox named "Search", or one with no name near the top of a site, is the site's search box, not the tool. Never type the task into it (do not type "10+10=" into a calculator site's search box).
- Use the tool's own buttons, one per step: for 10+10 on a calculator, click "1", "0", "plus", "1", "0", "equals". `senju find "plus"` or `senju find "equals"` gets their ids.
- If the tool's keys show up only as text (for example "7 8 9 +" in the text part of look) and find lists no buttons or icons for them, that site cannot be used through senju. Go to a known-good address instead: Chrome's calculator is https://calculator.apps.chrome/ (buttons named "0".."9", "plus", "minus", "times", "divide", "equals"), Google's widgets are at https://www.google.com/search?q=calculator, ?q=timer, ?q=weather+<city>; maps at https://www.google.com/maps, translate at https://translate.google.com. For anything else, `senju search` and click the real tool.

Menus:
- A result marked `[in a closed menu: click i12 first]` is inside a menu that is not open yet. Click the opener it names (often a "more" or "..." icon), then click the entry.

After the page changes:
- After a click that loads a new page (the output shows `url: ... -> ...`), the old ids are gone. Run `senju find` again for the next step. Do not reuse an id from the old page.
- Ids from find stay valid while you stay on the same page.

When find says "no element matches":
- Try other words: a synonym (cart or basket, sign in or log in, delete or remove), one shorter word, or a word from the link's address.
- The thing may be behind a menu: `senju find "more"` or `senju find "menu"` shows the openers.
- If it lists "Close words on this page", try one of them.
- If you still cannot find it, `senju search` for the page you need, or report what you looked for and what the page shows.

Reading long pages: `senju look --page 2` shows the next part of the page (then --page 3 ...). Use it to read text, not to hunt for a link.
