package dev.conclave.app.notify

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import dev.conclave.app.container
import dev.conclave.client.ConclaveApiException
import dev.conclave.client.model.ApprovalResponse
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout

/**
 * Handles Approve and Deny on an approval notification: calls
 * POST /api/approvals/:id with the stored token ({"decision":"allow","scope":"once"}
 * or {"decision":"deny"}), then says how it went on the notification.
 */
class ApprovalActionReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION) return
        val approvalId = intent.getStringExtra(EXTRA_APPROVAL_ID) ?: return
        val decision = intent.getStringExtra(EXTRA_DECISION) ?: return
        val notificationId = intent.getIntExtra(EXTRA_NOTIFICATION_ID, Notifications.approvalNotificationId(approvalId))
        val appContext = context.applicationContext
        val container = appContext.container
        val pending = goAsync()
        container.appScope.launch {
            try {
                withTimeout(9_000) {
                    val client = container.hub.awaitClient() ?: error("Not paired")
                    val response = if (decision == DECISION_ALLOW) ApprovalResponse.allowOnce() else ApprovalResponse.deny()
                    client.resolveApproval(approvalId, response)
                }
                Notifications.showApprovalOutcome(appContext, notificationId, if (decision == DECISION_ALLOW) "Approved once" else "Denied")
            } catch (e: ConclaveApiException) {
                // 404: answered already, on another device or by the agent giving up
                val text = if (e.status == 404) "Already answered" else "${e.message?.trimEnd('.') ?: "Not sent"}. Open the app to decide."
                Notifications.showApprovalOutcome(appContext, notificationId, text)
            } catch (e: Exception) {
                Notifications.showApprovalOutcome(appContext, notificationId, "Could not reach the hub. Open the app to decide.")
            } finally {
                pending.finish()
            }
        }
    }

    companion object {
        const val ACTION = "dev.conclave.app.APPROVAL_ACTION"
        const val EXTRA_APPROVAL_ID = "approval_id"
        const val EXTRA_DECISION = "decision"
        const val EXTRA_NOTIFICATION_ID = "notification_id"
        const val DECISION_ALLOW = "allow"
        const val DECISION_DENY = "deny"
    }
}
