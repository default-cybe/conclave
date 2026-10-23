package dev.conclave.app

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.SystemClock
import android.view.WindowManager
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.core.content.ContextCompat
import androidx.core.content.IntentCompat
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import dev.conclave.app.data.SharePayload
import dev.conclave.app.ui.AppRoot
import dev.conclave.app.ui.LockScreen
import dev.conclave.app.ui.common.LocalAppContainer
import dev.conclave.app.ui.theme.ConclaveTheme
import dev.conclave.app.ui.theme.ThemeMode
import dev.conclave.app.ui.theme.isDarkScheme
import dev.conclave.client.logic.DeepLink
import dev.conclave.client.logic.TextSize
import dev.conclave.client.model.Attachment
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.launch

/** Process-wide unlock state for the optional biometric lock. */
object AppLock {
    /** Lock again after this long in the background. */
    const val RELOCK_AFTER_MS = 60_000L
    val unlocked = MutableStateFlow(false)
    var backgroundedAt = 0L
}

// The scrims enableEdgeToEdge uses by default for three button navigation.
private val LIGHT_NAV_SCRIM = 0xE6FFFFFF.toInt()
private val DARK_NAV_SCRIM = 0x801B1B1B.toInt()

/** The single activity. Compose renders everything; navigation lives in [AppRoot]. */
class MainActivity : FragmentActivity() {
    private var releaseLive: (() -> Unit)? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        val container = container
        if (savedInstanceState == null) handleIntent(intent)

        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                container.settings.state.filterNotNull().collect { s ->
                    if (s.secureScreen) {
                        window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
                    } else {
                        window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
                    }
                }
            }
        }

        setContent {
            val settings by container.settings.state.collectAsStateWithLifecycle()
            val unlocked by AppLock.unlocked.collectAsStateWithLifecycle()
            val s = settings
            ConclaveTheme(mode = s?.theme ?: ThemeMode.SYSTEM, textSize = s?.textSize ?: TextSize.DEFAULT) {
                // System bar icons follow the app theme, not only the system one.
                val dark = isDarkScheme()
                LaunchedEffect(dark) {
                    enableEdgeToEdge(
                        statusBarStyle = SystemBarStyle.auto(android.graphics.Color.TRANSPARENT, android.graphics.Color.TRANSPARENT) { dark },
                        navigationBarStyle = SystemBarStyle.auto(LIGHT_NAV_SCRIM, DARK_NAV_SCRIM) { dark },
                    )
                }
                CompositionLocalProvider(LocalAppContainer provides container) {
                    Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                        when {
                            s == null -> Unit
                            s.biometricLock && !unlocked -> LockScreen(onUnlock = { authenticate() })
                            else -> AppRoot()
                        }
                    }
                }
            }
        }
    }

    override fun onStart() {
        super.onStart()
        val hub = container.hub
        hub.visible.value = true
        if (releaseLive == null) releaseLive = hub.acquireLive()
        val away = SystemClock.elapsedRealtime() - AppLock.backgroundedAt
        if (AppLock.backgroundedAt > 0 && away > AppLock.RELOCK_AFTER_MS) AppLock.unlocked.value = false
        // the background connection runs while it should (paired, Notify this device on, notifications allowed);
        // starting it from here works on every Android version because the app is in the foreground
        lifecycleScope.launch { (application as ConclaveApp).syncBackground() }
        // the app's own update: a look at the newest release once a day (update/AppUpdater.kt)
        container.updates.checkIfDue()
    }

    override fun onStop() {
        container.hub.visible.value = false
        releaseLive?.invoke()
        releaseLive = null
        AppLock.backgroundedAt = SystemClock.elapsedRealtime()
        super.onStop()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIntent(intent)
    }

    private fun handleIntent(intent: Intent?) {
        if (intent == null) return
        val hub = container.hub
        when (intent.action) {
            Intent.ACTION_VIEW -> DeepLink.parse(intent.dataString)?.let { hub.pendingLink.value = it }
            Intent.ACTION_SEND -> {
                val text = listOfNotNull(
                    intent.getStringExtra(Intent.EXTRA_SUBJECT),
                    intent.getStringExtra(Intent.EXTRA_TEXT),
                ).joinToString("\n").trim()
                val stream: Uri? = IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri::class.java)
                lifecycleScope.launch {
                    val attachments = mutableListOf<Attachment>()
                    if (stream != null) {
                        runCatching { dev.conclave.app.data.Attachments.fromUri(this@MainActivity, stream) }
                            .onSuccess { attachments += it }
                    }
                    if (text.isNotEmpty() || attachments.isNotEmpty()) {
                        hub.pendingShare.value = SharePayload(text, attachments)
                        hub.pendingLink.value = DeepLink.NewChat
                    }
                }
            }
        }
    }

    /** Biometric or device credential prompt for the app lock. */
    fun authenticate() {
        val authenticators = BiometricManager.Authenticators.BIOMETRIC_WEAK or BiometricManager.Authenticators.DEVICE_CREDENTIAL
        val can = BiometricManager.from(this).canAuthenticate(authenticators)
        if (can != BiometricManager.BIOMETRIC_SUCCESS) {
            // No screen lock on this device: the app lock cannot be stronger than the device.
            AppLock.unlocked.value = true
            return
        }
        val prompt = BiometricPrompt(
            this,
            ContextCompat.getMainExecutor(this),
            object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                    AppLock.unlocked.value = true
                }
            },
        )
        val info = BiometricPrompt.PromptInfo.Builder()
            .setTitle("Unlock Conclave")
            .setAllowedAuthenticators(authenticators)
            .build()
        prompt.authenticate(info)
    }
}
