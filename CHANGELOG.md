## [0.4.29] - 2026-10-25

### Changed

- Background tasks tell workflows, subagents and delegated jobs apart (web and Android). Each row leads with a kind icon and word: "Workflow · deep-research" with its phase, "Subagent · builder" with an icon per agent type, "Delegate · Code on MadX Arch". Rows show the subagent's model and the running time, and the list groups them by kind, workflows first.

- A notification when the hub updated itself, rolled back or failed, with the old and new version (Settings > Notifications, Updates).
- Desktop app: updates install by themselves (Settings > Install updates automatically, on by default). The app checks at start and every 15 minutes, and installs once two checks in a row find the window not in use and the hub on this computer with no session running or waiting for an approval. A hub elsewhere does not hold the update back.
- Desktop app: an update that cannot install for lack of permission (a macOS app the user cannot write, a Windows install for all users) shows one notification, "Conclave X is ready. Click to update.", and keeps the tray item. A version that failed is not tried again by itself until a newer one comes out.
- Usage fallback (Settings > Models > Usage fallback, `models.limitFallback: { enabled, models }`): an ordered list of models, separate from Refusal fallback. When a model is at its limit on every account, the next model after it on the list takes over, on the first ready plan or key of its own account order. A model not on the list starts from the top. Chores use the same list.
- Off or empty, a limit falls back on the Refusal fallback list as before. An agent with the refusal fallback off still gets no other model.
- Window starter for the Z.ai Coding Plan: one tiny request on the cheapest GLM (Flash, then Air) right after each 5 hour reset, sent on the zai provider with its key, inside the owner's starter hours. Its quota is read again around the reset.