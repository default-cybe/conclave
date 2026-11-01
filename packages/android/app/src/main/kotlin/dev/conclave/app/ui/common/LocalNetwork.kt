package dev.conclave.app.ui.common

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.ContextCompat
import dev.conclave.client.logic.HubAddress
import dev.conclave.client.logic.NetworkKind

/**
 * Android 17 blocks the home network for apps that target it until the person
 * allows it (ACCESS_LOCAL_NETWORK, in the Nearby devices group). A hub at a
 * 192.168.x.x or .local address needs it; this phone itself, a VPN range and
 * public addresses do not.
 */
object LocalNetwork {
    const val PERMISSION = "android.permission.ACCESS_LOCAL_NETWORK"
    const val DENIED = "Conclave needs Nearby devices to reach a hub on this network. Allow it in Android Settings, Apps, Conclave, Permissions."

    fun needed(address: HubAddress?): Boolean = address?.kind == NetworkKind.LAN

    fun missing(context: Context): Boolean =
        Build.VERSION.SDK_INT >= 37 &&
            ContextCompat.checkSelfPermission(context, PERMISSION) != PackageManager.PERMISSION_GRANTED
}

/**
 * Asks for the home network first when [address] is on it and the permission
 * is not given yet. [then] runs once it is allowed, or at once when nothing
 * needs asking; [onDenied] runs when the person says no.
 */
@Composable
fun rememberLocalNetworkAsk(): (address: HubAddress?, onDenied: () -> Unit, then: () -> Unit) -> Unit {
    val context = LocalContext.current
    var waiting by remember { mutableStateOf<Pair<() -> Unit, () -> Unit>?>(null) }
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        val (onDenied, then) = waiting ?: return@rememberLauncherForActivityResult
        waiting = null
        if (granted) then() else onDenied()
    }
    return { address, onDenied, then ->
        if (LocalNetwork.needed(address) && LocalNetwork.missing(context)) {
            waiting = onDenied to then
            launcher.launch(LocalNetwork.PERMISSION)
        } else {
            then()
        }
    }
}
