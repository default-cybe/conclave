package dev.conclave.client

import dev.conclave.client.model.AlertAction
import dev.conclave.client.model.AlertItem
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

// Alerts (docs/DESIGN.md 28), the same calls as alerts and alertAction in
// packages/core/src/client/index.ts.

/** Open alerts, oldest first. */
suspend fun ConclaveClient.alerts(): List<AlertItem> = get(p("api", "alerts"), ListSerializer(AlertItem.serializer()))

/** Stop or Keep waiting on a stuck turn, Dismiss a file conflict. */
suspend fun ConclaveClient.alertAction(id: String, action: AlertAction) =
    sendUnit("POST", p("api", "alerts", id), buildJsonObject { put("action", action.wire) })
