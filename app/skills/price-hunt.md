---
name: price-hunt
description: Use when the person wants to buy something and wants the cheapest option across online stores. One worker per store browses in parallel; the lead compares total prices. Also covers pairing it with an Outlook email side task.
revision: 3
updated: 2026-11-14
---

Lead plan:
1. Pick 4 to 6 well-known stores that sell this kind of item (electronics: Amazon, Best Buy, Walmart, Target, GameStop/Newegg/B&H). Spawn one browser worker per store in the same turn, so they browse at the same time. Run any unrelated side task (e.g. an email) as its own desktop worker in parallel.
2. Each worker's goal: "Find the cheapest NEW <exact item> at <store>. Search, click the store's own result, open the product page of the exact item (right model, size, sold new), read price, sale, shipping. Don't sign in, add to cart, or buy. Report store, product, price, shipping, link. If blocked, report that."
3. Wait until every worker has reported. Answer with a table sorted by total price (price plus shipping), cheapest first, links, and a recommendation. Note which prices are unconfirmed (blocked pages) and mention cheaper non-new options (open-box, pre-owned) separately. Separate "cheapest overall" from "cheapest that ships to home".

Worker method / pitfalls (learned):
- The browser window starts tiny (mobile layout, hidden filters). First call browser_resize to 1280x900.
- Use browser_evaluate with document.body.innerText.slice(...) (or a regex) to pull titles+prices in one call. Snapshots are huge and often omit prices. Best Buy's li.sku-item selector no longer works; innerText does. Amazon: query [data-component-type="s-search-result"] for titles, prices, ASINs.
- Search URLs that load directly with no bot check: Best Buy (/site/searchpage.jsp?st=...), Walmart (/search?q=), Target (/s?searchTerm=). Click result links (text link, not image link). Direct /dp/ or /ip/ product URLs often trigger a bot check.
- Bot checks (Target "Press & hold", Walmart, Amazon "I am human"): agents can't pass them and users usually decline. Hand off once at most. If it fails, report partial results from the search-results text, marked unconfirmed. Don't retry. Target's search results text already gives price and shipping.
- Amazon: official listings often show "Click to see price", and the product page can default to a used "Like New" buy box, so check the condition. Cart trick only if the price is otherwise hidden.
- GameStop: results mix New, Pre-Owned, Refurbished. Tick the "Consoles & Hardware" filter and then the "New" condition checkbox, then read innerText. Open the product page to check Condition and "Ship to Home". A low price with Ship to Home "Not Available" is store pickup or same-day only, so flag it. Bundles can be cheaper than the bare console.
- Shipping fees are usually hidden for signed-out visitors; report delivery dates and free-shipping notes.

Outlook email side task (desktop worker, needs_user):
- launch_app Outlook alone leaves no usable window. Launch with urls: ["mailto:<addr>?subject=<s>&body=<b>"] to get a pre-filled compose window. Verify the fields with get_window_state, then ask the user once before sending. If they decline, leave the draft and report not sent.
- If the user says "do nothing" mid-job, stop the running workers and summarise the partial results.

Needs user: only for bot checks and email send approval. Don't re-ask repeatedly; partial results are fine.
