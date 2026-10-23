@file:OptIn(ExperimentalMaterial3Api::class)

package dev.conclave.app.ui.pairing

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material.icons.outlined.VisibilityOff
import androidx.compose.material.icons.outlined.Warning
import androidx.compose.material.icons.outlined.Wifi
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.conclave.app.ui.common.LocalAppContainer
import dev.conclave.app.ui.common.LocalNetwork
import dev.conclave.app.ui.common.Mark
import dev.conclave.app.ui.common.Segmented
import dev.conclave.app.ui.common.errorText
import dev.conclave.app.ui.common.rememberLocalNetworkAsk
import dev.conclave.app.ui.common.solidButtonColors
import dev.conclave.app.ui.motion.KnotRopeLine
import dev.conclave.app.ui.theme.Conclave
import dev.conclave.app.ui.theme.ConclaveType
import dev.conclave.app.ui.theme.LocalExtraColors
import dev.conclave.client.ConclaveApiException
import dev.conclave.client.PasswordRule
import dev.conclave.client.logic.DeepLink
import dev.conclave.client.logic.HubAddress
import dev.conclave.client.logic.NetworkKind
import dev.conclave.client.motion.RopeMoment
import kotlinx.coroutines.launch

/** How the address form signs in: the hub's password, or a pairing code typed by hand. */
private enum class Way { PASSWORD, CODE }

/**
 * Connect this phone to a hub. The scanner comes first: the QR code carries
 * the hub's best address, the others as fallbacks, and its fingerprint, which
 * the address must prove before the code goes there. Use address and password
 * opens the form: the address with the hub's password, or with a pairing
 * code. After a password login the hub's fingerprint shows once (AppRoot).
 *
 * With [onDone] the phone is paired already and pairs again, for example
 * after the hub's quick tunnel got a new address while the phone was away.
 * The stored token is never sent to an address from a code or a link: a code
 * someone else made must not get it. The new pairing replaces the current one
 * only once it worked.
 */
@Composable
fun PairingScreen(onDone: (() -> Unit)? = null) {
    val hub = LocalAppContainer.current.hub
    val pendingLink by hub.pendingLink.collectAsStateWithLifecycle()
    // the form survives a rotation or a light/dark switch; the password is typed again
    var url by rememberSaveable { mutableStateOf("") }
    var code by rememberSaveable { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    // whose password, by sign-in name or email, on a hub with several people (docs/design/ACCOUNTS.md); empty is the owner's
    var account by rememberSaveable { mutableStateOf("") }
    var showPassword by remember { mutableStateOf(false) }
    var alts by rememberSaveable { mutableStateOf(arrayListOf<String>()) }
    var fingerprint by rememberSaveable { mutableStateOf<String?>(null) }
    var acceptedPlainHttp by rememberSaveable { mutableStateOf(false) }
    var form by rememberSaveable { mutableStateOf(false) }
    var scanning by rememberSaveable { mutableStateOf(false) }
    var way by rememberSaveable { mutableStateOf(Way.PASSWORD) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    // a new key scans again after a code that did not work
    var scanRound by remember { mutableIntStateOf(0) }
    val scope = rememberCoroutineScope()
    val c = Conclave.colors

    // conclave://pair links (QR scanned by another app, or a tapped link) prefill the form
    LaunchedEffect(pendingLink) {
        val link = pendingLink as? DeepLink.Pair ?: return@LaunchedEffect
        url = link.url
        code = link.code
        alts = ArrayList(link.alts)
        fingerprint = link.fp
        way = Way.CODE
        form = true
        scanning = false
        hub.pendingLink.value = null
    }

    val address = remember(url) { HubAddress.parse(url) }
    val localNetwork = rememberLocalNetworkAsk()

    fun pair(a: HubAddress, pairingCode: String, others: List<String>, fp: String?) = localNetwork(a, { error = LocalNetwork.DENIED }) {
        busy = true
        error = null
        scope.launch {
            try {
                hub.pair(a, pairingCode, others, fp)
                onDone?.invoke()
            } catch (e: Exception) {
                error = errorText(e)
                scanRound++
            } finally {
                busy = false
            }
        }
    }

    fun login(a: HubAddress, secret: String) = localNetwork(a, { error = LocalNetwork.DENIED }) {
        busy = true
        error = null
        scope.launch {
            try {
                hub.login(a, secret, account.trim().ifEmpty { null })
                password = ""
                onDone?.invoke()
            } catch (e: Exception) {
                error = when {
                    // the hub's one message for a wrong password or none set
                    e is ConclaveApiException && e.status == 404 -> "This hub has no password login. Update the hub, or use a pairing code."
                    e is ConclaveApiException && e.status in 400..403 -> e.message?.ifBlank { null } ?: "Wrong name or password."
                    else -> errorText(e)
                }
            } finally {
                busy = false
            }
        }
    }

    // Scan QR code: the camera fills the screen until a code is read or Close
    if (scanning) {
        BackHandler { scanning = false }
        Box(Modifier.fillMaxSize().background(Color.Black).systemBarsPadding()) {
            key(scanRound) {
                QrFrame(
                    onResult = { value ->
                        scanning = false
                        val link = DeepLink.parse(value)
                        if (link is DeepLink.Pair) {
                            url = link.url
                            code = link.code
                            alts = ArrayList(link.alts)
                            fingerprint = link.fp
                            val parsed = HubAddress.parse(link.url)
                            if (parsed != null && !parsed.needsWarning) {
                                pair(parsed, link.code, link.alts, link.fp)
                            } else {
                                // plain http to a public address: the form asks first
                                way = Way.CODE
                                form = true
                            }
                        } else {
                            error = "That QR code is not a Conclave pairing code."
                            scanRound++
                        }
                    },
                    modifier = Modifier.align(Alignment.Center).padding(24.dp).widthIn(max = 420.dp).fillMaxWidth().aspectRatio(1f),
                )
            }
            IconButton(onClick = { scanning = false }, modifier = Modifier.align(Alignment.TopStart).padding(4.dp).size(48.dp)) {
                Icon(Icons.Outlined.Close, contentDescription = "Close camera", tint = Color.White)
            }
            Text(
                "Point at the code under Devices on your hub.",
                style = ConclaveType.body,
                color = Color.White,
                textAlign = TextAlign.Center,
                modifier = Modifier.align(Alignment.BottomCenter).fillMaxWidth().padding(24.dp),
            )
        }
        return
    }

    Column(
        Modifier
            .fillMaxSize()
            .systemBarsPadding()
            .imePadding()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 24.dp, vertical = 16.dp),
        verticalArrangement = Arrangement.spacedBy(24.dp),
    ) {
        if (onDone != null) {
            TextButton(onClick = onDone) { Text("Cancel") }
        } else {
            Spacer(Modifier.height(24.dp))
        }
        Mark(height = 28.dp, label = "Conclave")
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(
                if (onDone != null) "Connect again" else "Connect to your hub",
                style = ConclaveType.greeting.copy(fontSize = 30.sp, lineHeight = 36.sp, fontWeight = FontWeight.SemiBold),
                color = c.fg,
            )
            Text(
                if (onDone != null) {
                    "Scan a new code from Devices on your hub. It replaces this pairing once it works."
                } else {
                    "Open Devices on your hub and scan the code."
                },
                style = ConclaveType.body.copy(fontSize = 16.sp, lineHeight = 23.sp),
                color = c.fg2,
            )
        }

        if (!form) {
            error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = ConclaveType.body) }
            // Working state is a word, not a spinner (spec 10.4); the strip shows the wait.
            if (busy) KnotRopeLine(RopeMoment.RUN, "Checking the hub")
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(
                    onClick = {
                        error = null
                        scanning = true
                    },
                    enabled = !busy,
                    colors = solidButtonColors(),
                    modifier = Modifier.fillMaxWidth().height(52.dp),
                ) { Text("Scan QR code", style = ConclaveType.button.copy(fontSize = 16.sp)) }
                TextButton(onClick = { form = true; error = null }, modifier = Modifier.fillMaxWidth().height(52.dp)) {
                    Text("Use address and password", style = ConclaveType.button.copy(fontSize = 16.sp), color = c.fg)
                }
            }
        } else {
            AddressForm(
                url = url,
                onUrl = {
                    url = it
                    alts = arrayListOf()
                    acceptedPlainHttp = false
                },
                address = address,
                way = way,
                onWay = {
                    way = it
                    error = null
                },
                account = account,
                onAccount = { account = it },
                password = password,
                onPassword = { password = it },
                showPassword = showPassword,
                onShowPassword = { showPassword = it },
                code = code,
                onCode = {
                    code = it.trim()
                    // a typed code is not the one the QR code's fingerprint came with
                    fingerprint = null
                },
                acceptedPlainHttp = acceptedPlainHttp,
                onAcceptPlainHttp = { acceptedPlainHttp = it },
                error = error,
                busy = busy,
                onLogin = { a -> login(a, password) },
                onPair = { a -> pair(a, code, alts, fingerprint) },
            )
            TextButton(
                onClick = {
                    form = false
                    error = null
                },
                modifier = Modifier.align(Alignment.CenterHorizontally),
            ) {
                Text("Scan a code instead", color = c.fg2)
            }
        }
    }
}

/** Address with the hub's password, or with a pairing code typed by hand. */
@Composable
private fun AddressForm(
    url: String,
    onUrl: (String) -> Unit,
    address: HubAddress?,
    way: Way,
    onWay: (Way) -> Unit,
    account: String,
    onAccount: (String) -> Unit,
    password: String,
    onPassword: (String) -> Unit,
    showPassword: Boolean,
    onShowPassword: (Boolean) -> Unit,
    code: String,
    onCode: (String) -> Unit,
    acceptedPlainHttp: Boolean,
    onAcceptPlainHttp: (Boolean) -> Unit,
    error: String?,
    busy: Boolean,
    onLogin: (HubAddress) -> Unit,
    onPair: (HubAddress) -> Unit,
) {
    val c = Conclave.colors
    Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
        OutlinedTextField(
            value = url,
            onValueChange = onUrl,
            label = { Text("Hub address") },
            placeholder = { Text("https://hub.example.com") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Next),
            modifier = Modifier.fillMaxWidth(),
        )
        if (address != null) AddressHint(address)
        // two ways in: the segmented control, not chips (DESIGN.md 13)
        Segmented(
            value = way,
            options = listOf(Way.PASSWORD to "Password", Way.CODE to "Pairing code"),
            onChange = onWay,
            modifier = Modifier.fillMaxWidth(),
        )
        when (way) {
            Way.PASSWORD -> {
                OutlinedTextField(
                    value = account,
                    onValueChange = onAccount,
                    label = { Text("Sign-in name or email") },
                    placeholder = { Text("Leave empty if you are the owner") },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Text, imeAction = ImeAction.Next),
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = password,
                    onValueChange = onPassword,
                    label = { Text("Password") },
                    singleLine = true,
                    visualTransformation = if (showPassword) VisualTransformation.None else PasswordVisualTransformation(),
                    trailingIcon = {
                        IconButton(onClick = { onShowPassword(!showPassword) }) {
                            Icon(
                                if (showPassword) Icons.Outlined.VisibilityOff else Icons.Outlined.Visibility,
                                contentDescription = if (showPassword) "Hide password" else "Show password",
                            )
                        }
                    },
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Done),
                    modifier = Modifier.fillMaxWidth(),
                )
                // a password goes only over https, or to this device or a private network
                val refused = address != null && !PasswordRule.allowed(address.url)
                if (refused) Text(PasswordRule.REFUSED, color = MaterialTheme.colorScheme.error, style = ConclaveType.body)
                Text("Off until the owner sets a password on the hub (conclave password set).", style = ConclaveType.meta, color = c.fg3)
                if (error != null) Text(error, color = MaterialTheme.colorScheme.error, style = ConclaveType.body)
                val can = !busy && address != null && password.isNotEmpty() && !refused
                Button(onClick = { if (address != null) onLogin(address) }, enabled = can, colors = solidButtonColors(), modifier = Modifier.fillMaxWidth().height(52.dp)) {
                    Text(if (busy) "Signing in" else "Sign in")
                }
            }
            Way.CODE -> {
                OutlinedTextField(
                    value = code,
                    onValueChange = onCode,
                    label = { Text("Pairing code") },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Ascii, imeAction = ImeAction.Done),
                    modifier = Modifier.fillMaxWidth(),
                )
                Text("Make one under Devices on a paired device, or run conclave pair-phone on the hub.", style = ConclaveType.meta, color = c.fg3)
                if (address != null && address.needsWarning) {
                    PlainHttpWarning(address, acceptedPlainHttp, onAcceptPlainHttp)
                }
                if (error != null) Text(error, color = MaterialTheme.colorScheme.error, style = ConclaveType.body)
                val can = !busy && address != null && code.isNotBlank() && (!address.needsWarning || acceptedPlainHttp)
                Button(onClick = { if (address != null) onPair(address) }, enabled = can, colors = solidButtonColors(), modifier = Modifier.fillMaxWidth().height(52.dp)) {
                    Text(if (busy) "Pairing" else "Pair")
                }
            }
        }
        // Working state is a word, not a spinner (spec 10.4); the strip shows the wait.
        if (busy) KnotRopeLine(RopeMoment.RUN, "Waiting for the hub")
    }
}

@Composable
private fun AddressHint(address: HubAddress) {
    val extra = LocalExtraColors.current
    val (icon, text, color) = when {
        address.isHttps -> Triple(Icons.Outlined.Lock, "Encrypted (https)", extra.success)
        address.kind == NetworkKind.VPN -> Triple(Icons.Outlined.Wifi, "Plain http on a private network", extra.warning)
        address.kind == NetworkKind.LAN -> Triple(Icons.Outlined.Wifi, "Plain http on your local network", extra.warning)
        address.kind == NetworkKind.LOCALHOST -> Triple(Icons.Outlined.Wifi, "Plain http to this device", extra.warning)
        else -> Triple(Icons.Outlined.Warning, "Plain http over the internet", MaterialTheme.colorScheme.error)
    }
    Row(verticalAlignment = Alignment.CenterVertically) {
        Icon(icon, contentDescription = null, tint = color, modifier = Modifier.size(16.dp))
        Spacer(Modifier.width(6.dp))
        Text(text, style = MaterialTheme.typography.bodySmall, color = color)
    }
}

@Composable
private fun PlainHttpWarning(address: HubAddress, accepted: Boolean, onAccept: (Boolean) -> Unit) {
    Surface(
        color = MaterialTheme.colorScheme.errorContainer,
        contentColor = MaterialTheme.colorScheme.onErrorContainer,
        shape = RoundedCornerShape(12.dp),
    ) {
        Column(Modifier.padding(14.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Outlined.Warning, contentDescription = null)
                Spacer(Modifier.width(8.dp))
                Text("Unencrypted connection", style = MaterialTheme.typography.titleSmall)
            }
            Spacer(Modifier.height(6.dp))
            Text(
                "${address.host} is a public address and the URL uses plain http. Your token, prompts and code would " +
                    "travel unencrypted. Use https: on the hub, turn on the quick tunnel in Settings, Remote access.",
                style = MaterialTheme.typography.bodyMedium,
            )
            Row(verticalAlignment = Alignment.CenterVertically) {
                Checkbox(checked = accepted, onCheckedChange = onAccept)
                Text("Allow plain http for ${address.host} anyway", style = MaterialTheme.typography.bodyMedium)
            }
        }
    }
}
