package dev.conclave.app.data

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Whether the phone has a network, and a tick each time it gets a new one.
 * The live connection waits while there is none instead of retrying into
 * nothing (battery), and tries at once when one comes back.
 */
class NetworkMonitor(context: Context) {
    private val cm = context.applicationContext.getSystemService(ConnectivityManager::class.java)

    private val _online = MutableStateFlow(initial())
    val online: StateFlow<Boolean> = _online.asStateFlow()

    /** Bumped when the default network changes (Wi-Fi to mobile data and back): addresses that failed may work now. */
    private val _changes = MutableStateFlow(0)
    val changes: StateFlow<Int> = _changes.asStateFlow()

    /** The default network now. The default network callback reports a switch as onAvailable of the new one. */
    @Volatile
    private var current: Network? = null

    private fun initial(): Boolean = try {
        val manager = cm
        if (manager == null) true else manager.getNetworkCapabilities(manager.activeNetwork)?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true
    } catch (_: Exception) {
        // no permission or no service: assume online, the socket finds out
        true
    }

    fun start() {
        val manager = cm ?: return
        try {
            manager.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) {
                    val before = current
                    current = network
                    _online.value = true
                    // a switch (Wi-Fi to mobile data): reconnect at once. The first report at start-up is the
                    // network the socket already uses, and coming back online already restarts it through [online].
                    if (before != null && before != network) _changes.value = _changes.value + 1
                }

                override fun onLost(network: Network) {
                    if (current == null || current == network) {
                        current = null
                        _online.value = false
                    }
                }
            })
        } catch (_: Exception) {
            _online.value = true
        }
    }
}
