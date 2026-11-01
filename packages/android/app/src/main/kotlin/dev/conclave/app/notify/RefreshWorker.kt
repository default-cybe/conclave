package dev.conclave.app.notify

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import dev.conclave.app.container
import dev.conclave.client.logic.Asks
import dev.conclave.client.model.obj
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull

/**
 * Periodic safety net (every 15 minutes, when online): notifies about pending
 * approvals the background connection has not shown yet, for example after
 * Android stopped the service. Follows the owner's rule for approvals on the
 * hub and the Notify this device switch.
 */
class RefreshWorker(appContext: Context, params: WorkerParameters) : CoroutineWorker(appContext, params) {

    override suspend fun doWork(): Result {
        val c = applicationContext.container
        val client = c.hub.awaitClient() ?: return Result.success()
        return try {
            val approvals = client.approvals()
            c.hub.approvals.value = approvals
            val settings = c.settings.current()
            val wanted = settings.notifyDevice && approvalsWanted(client.config().config)
            val already = c.settings.notifiedApprovals()
            if (wanted && !c.hub.visible.value) {
                approvals.filter { it.id !in already }.forEach { a ->
                    // a subagent's approval opens the chat it shows in
                    Notifications.showApproval(applicationContext, a.id, "Approve ${a.tool}?", a.summary, Asks.home(a))
                }
            }
            c.settings.setNotifiedApprovals(approvals.map { it.id }.toSet())
            Result.success()
        } catch (e: Exception) {
            Result.retry()
        }
    }

    /** notifications.on.approvalNeeded on the hub (on unless the owner turned it off). */
    private fun approvalsWanted(config: kotlinx.serialization.json.JsonObject): Boolean =
        (config.obj("notifications")?.obj("on")?.get("approvalNeeded") as? JsonPrimitive)?.booleanOrNull ?: true

    companion object {
        const val NAME = "conclave-refresh"
    }
}
