---
name: wechat-send-message
description: Use when asked to send a message to a contact in the native WeChat Mac app (or similar chat apps where the Send button ignores accessibility presses).
revision: 1
updated: 2026-11-14
---

Plan: one desktop worker, needs_user=true (sending in the user's name needs approval). No other workers needed.

Method that worked:
1. Worker uses get_window_state on WeChat (call it twice if the accessibility tree is empty). Open the existing chat with the contact from the chat list (or search).
2. The input field is the AXTextArea with id `chat_input_field`. Use type_text with its element_token to draft the text. This does not send.
3. Before sending, the worker must ask_user to confirm the exact text and recipient.
4. Send with press_key `return` targeting the input field's element_token. The Send button ignores AXPress and pixel clicks through the driver, so don't waste steps on it.
5. Verify with get_window_state using a query: the sent bubble should appear, the chat list preview should update, and the input box should be empty. Check that only one copy was sent.

Pitfalls: don't press Return before approval. Don't retry Send button clicks. If multiple contacts match the name, ask the user which one.

Tell workers this method up front in the goal (or via the skill) to save time.
