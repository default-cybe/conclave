package dev.conclave.app.notify

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import dev.conclave.app.ConclaveApp
import dev.conclave.app.container
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout

/**
 * After the phone restarts or the app updates, start the background
 * connection again when it was on, so notifications keep coming without
 * opening the app first.
 */
class StartReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED && intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
        val app = context.applicationContext as ConclaveApp
        val pending = goAsync()
        app.container.appScope.launch {
            try {
                withTimeout(8_000) { app.syncBackground() }
            } catch (_: Exception) {
                // the next app start tries again
            } finally {
                pending.finish()
            }
        }
    }
}
