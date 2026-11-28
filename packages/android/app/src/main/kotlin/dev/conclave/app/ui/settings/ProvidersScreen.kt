package dev.conclave.app.ui.settings

import android.net.Uri
import androidx.browser.customtabs.CustomTabsIntent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.conclave.app.ui.common.ConfirmDialog
import dev.conclave.app.ui.common.LocalAppContainer
import dev.conclave.app.ui.common.SectionHeader
import dev.conclave.app.ui.common.TopBar
import dev.conclave.app.ui.common.errorText
import dev.conclave.app.ui.common.outlineButtonBorder
import dev.conclave.app.ui.common.outlineButtonColors
import dev.conclave.app.ui.common.solidButtonColors
import dev.conclave.app.ui.motion.ToastHost
import dev.conclave.app.ui.motion.rememberToasts
import dev.conclave.app.ui.theme.CodeStyle
import dev.conclave.app.ui.theme.Conclave
import dev.conclave.app.ui.theme.ConclaveType
import dev.conclave.client.cancelSignIn
import dev.conclave.client.finishSignIn
import dev.conclave.client.logic.Format
import dev.conclave.client.logic.Providers
import dev.conclave.client.model.SignInStart
import dev.conclave.client.model.SubscriptionsStatus
import dev.conclave.client.providersWithKeys
import dev.conclave.client.refreshSubscriptionAccount
import dev.conclave.client.removeSubscriptionAccount
import dev.conclave.client.setProviderKey
import dev.conclave.client.signInStatus
import dev.conclave.client.startBuiltinSubscriptions
import dev.conclave.client.startSignIn
import dev.conclave.client.subscriptions
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject

/**
 * Settings, Providers (web settings/providers.tsx; a member's is people.tsx
 * MemberProvidersSection): add, replace or remove an API key per provider,
 * each tested with a list of models. Keys go to the hub and never come back.
 * The owner's keys are the hub's; a member's stay in their own file.
 */
@Composable
fun ProvidersScreen(onBack: () -> Unit, onOpenSubscriptions: () -> Unit) {
    val hub = LocalAppContainer.current.hub
    val me by hub.me.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    val snackbar = rememberToasts()
    val c = Conclave.colors
    val isOwner = me?.isOwner != false
    var withKeys by remember { mutableStateOf<Set<String>>(emptySet()) }
    var configured by remember { mutableStateOf<Set<String>>(emptySet()) }
    var added by remember { mutableStateOf<List<String>>(emptyList()) }
    val tests = remember { mutableStateMapOf<String, Pair<String, Boolean>>() }
    var editing by remember { mutableStateOf<String?>(null) }
    var removing by remember { mutableStateOf<String?>(null) }
    var adding by remember { mutableStateOf(false) }

    fun say(t: String) {
        scope.launch { snackbar.showSnackbar(t) }
    }

    suspend fun load() {
        if (!isOwner) return hub.refreshCatalog()
        val r = hub.api { it.config() }
        withKeys = providersWithKeys(r.secrets)
        configured = ((r.config["providers"] as? JsonObject)?.filter { (_, v) -> (v as? JsonObject)?.get("type")?.toString()?.trim('"') != "acp" }?.keys).orEmpty()
    }

    suspend fun test(id: String) {
        tests[id] = "Testing" to true
        tests[id] = runCatching { Providers.testWords(hub.api { it.testProvider(id) }) }.getOrElse { errorText(it) to false }
    }

    fun saveKey(id: String, key: String?) {
        scope.launch {
            try {
                hub.api { it.setProviderKey(id, key) }
                load()
                if (key != null && isOwner) test(id) else tests.remove(id)
                hub.refreshCatalog()
                say(if (key == null) "Key removed." else "Key saved.")
            } catch (e: Exception) {
                say("Could not save. ${errorText(e)}")
            }
        }
    }

    LaunchedEffect(isOwner) {
        runCatching { load() }.onFailure { say(errorText(it)) }
        if (isOwner) withKeys.forEach { id -> launch { test(id) } }
    }

    Scaffold(topBar = { TopBar("Providers", onBack = onBack) }, snackbarHost = { ToastHost(snackbar) }, containerColor = c.bg) { padding ->
        Column(Modifier.padding(padding).fillMaxSize().verticalScroll(rememberScrollState()).padding(bottom = 32.dp)) {
            NavRow("Sign in to an AI plan", "Claude, ChatGPT or Gemini, with your plan instead of a key", onClick = onOpenSubscriptions)
            if (isOwner) {
                val rows = Providers.keyedRows(withKeys, configured) + added.filter { it !in Providers.keyedRows(withKeys, configured) }
                SectionHeader("API keys")
                if (rows.isEmpty()) Note("No keys yet. Add one below, or sign in to an AI plan above.")
                rows.forEach { id ->
                    val name = Providers.info(id)?.name ?: id
                    val words = tests[id] ?: if (id in withKeys) "Key saved" to true else "Not set" to false
                    NavRow(name, words.first, onClick = { editing = id })
                }
                NavRow("Add a provider", null, onClick = { adding = true })
                Note("Keys live on the hub only, encrypted with the hub key. Phones and other computers never receive them. Each key is checked when this page opens: a list of models, never a paid request.")
            } else {
                SectionHeader("Providers")
                Note("Your keys stay on the hub in your own file. Nobody else's calls use them.")
                me?.providers.orEmpty().forEach { p ->
                    val (word, _, detail) = Providers.accessWords(p) { Format.relative(it) }
                    NavRow(Providers.info(p.provider)?.name ?: p.name, "$word. $detail", onClick = { editing = p.provider })
                }
            }
        }
    }

    if (adding) {
        val rows = Providers.keyedRows(withKeys, configured) + added
        androidx.compose.material3.AlertDialog(
            onDismissRequest = { adding = false },
            title = { Text("Add a provider") },
            text = {
                Column(Modifier.verticalScroll(rememberScrollState())) {
                    Providers.addable(rows).forEach { p ->
                        NavRow(p.name, p.description, chevron = false, onClick = {
                            adding = false
                            added = added + p.id
                            editing = p.id
                        })
                    }
                    Note("Custom providers (any OpenAI or Anthropic compatible endpoint) are added in the web app: Settings, Providers.")
                }
            },
            confirmButton = { TextButton(onClick = { adding = false }) { Text("Close") } },
        )
    }

    editing?.let { id ->
        val name = Providers.info(id)?.name ?: id
        val own = if (isOwner) id in withKeys else me?.providers?.firstOrNull { it.provider == id }?.ownKey == true
        var key by remember(id) { mutableStateOf("") }
        androidx.compose.material3.AlertDialog(
            onDismissRequest = { editing = null },
            title = { Text(if (isOwner) "$name API key" else "Your $name key") },
            text = {
                Column {
                    Text(if (own) "A key is saved. Paste a new one to replace it." else "Paste the key from the provider's console.", style = ConclaveType.meta, color = c.fg3)
                    OutlinedTextField(
                        value = key,
                        onValueChange = { key = it },
                        placeholder = { Text(if (isOwner) Providers.placeholder(id) else "Your key") },
                        singleLine = true,
                        textStyle = CodeStyle,
                        visualTransformation = PasswordVisualTransformation(),
                        modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
                    )
                    if (own) {
                        TextButton(onClick = {
                            editing = null
                            removing = id
                        }) { Text(if (isOwner) "Remove key" else "Remove my key", color = c.fault) }
                    }
                }
            },
            confirmButton = {
                TextButton(enabled = key.isNotBlank(), onClick = {
                    editing = null
                    saveKey(id, key.trim())
                }) { Text("Save") }
            },
            dismissButton = { TextButton(onClick = { editing = null }) { Text("Cancel") } },
        )
    }

    removing?.let { id ->
        val name = Providers.info(id)?.name ?: id
        ConfirmDialog(
            title = "Remove the $name key?",
            text = "Sessions on $name models stop until you add a key again.",
            confirmLabel = "Remove key",
            destructive = true,
            onConfirm = {
                removing = null
                saveKey(id, null)
            },
            onDismiss = { removing = null },
        )
    }
}

/**
 * Settings, Subscriptions (web components/subscriptions/Subscriptions.tsx):
 * sign in to a Claude, ChatGPT or Gemini plan through the hub's CLIProxyAPI.
 * The provider's page opens in a Custom Tab; it ends on a localhost page the
 * phone cannot load, so its address is pasted back here. A member signs in
 * on their own CLIProxyAPI; how the hub reaches one is the owner's (web).
 */
@Composable
fun SubscriptionsScreen(onBack: () -> Unit) {
    val hub = LocalAppContainer.current.hub
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val snackbar = rememberToasts()
    val c = Conclave.colors
    var status by remember { mutableStateOf<SubscriptionsStatus?>(null) }
    var more by remember { mutableStateOf(false) }
    var flow by remember { mutableStateOf<SignInStart?>(null) }
    var flowName by remember { mutableStateOf("") }
    var pasted by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var removing by remember { mutableStateOf<String?>(null) }

    fun say(t: String) {
        scope.launch { snackbar.showSnackbar(t) }
    }

    fun open(url: String) {
        runCatching { CustomTabsIntent.Builder().build().launchUrl(context, Uri.parse(url)) }.onFailure { say("Could not open the browser.") }
    }

    fun done(ok: Boolean, error: String?) {
        flow = null
        pasted = ""
        scope.launch {
            status = runCatching { hub.api { it.subscriptions() } }.getOrNull() ?: status
            hub.refreshCatalog()
        }
        say(if (ok) "Signed in." else error ?: "Sign in did not finish.")
    }

    fun signIn(id: String, name: String) {
        scope.launch {
            busy = true
            try {
                val s = status
                if (s != null && Providers.needsStart(s)) status = hub.api { it.startBuiltinSubscriptions() }
                val start = hub.api { it.startSignIn(id) }
                flowName = name
                flow = start
                open(start.url)
            } catch (e: Exception) {
                say("Could not start. ${errorText(e)}")
            }
            busy = false
        }
    }

    LaunchedEffect(Unit) { status = runCatching { hub.api { it.subscriptions() } }.onFailure { say(errorText(it)) }.getOrNull() }
    // a device code or a caught redirect finishes on the hub: ask until it says so
    LaunchedEffect(flow?.state) {
        val f = flow ?: return@LaunchedEffect
        while (flow?.state == f.state) {
            delay(2_000)
            val st = runCatching { hub.api { it.signInStatus(f.state) } }.getOrNull() ?: continue
            if (st.status != "wait") return@LaunchedEffect done(st.status == "ok", st.error)
        }
    }

    Scaffold(topBar = { TopBar("Subscriptions", onBack = onBack) }, snackbarHost = { ToastHost(snackbar) }, containerColor = c.bg) { padding ->
        Column(Modifier.padding(padding).fillMaxSize().verticalScroll(rememberScrollState()).padding(bottom = 32.dp)) {
            val s = status
            if (s == null) {
                Note("Loading.")
                return@Column
            }
            val (word, rest) = Providers.statusLine(s)
            Note("$word $rest")
            if (!Providers.usable(s)) Note(s.managementNote ?: "Sign in needs the hub's CLIProxyAPI with its management key. Set it up in the web app: Settings, Subscriptions.", color = c.warn)

            val f = flow
            if (f != null) {
                SectionHeader("Signing in to $flowName")
                val paste = Providers.needsPaste(f, forced = true)
                Note(Providers.waitingLine(f, flowName, paste))
                f.userCode?.let { Text(it, style = CodeStyle, color = c.fg, modifier = Modifier.padding(horizontal = 20.dp, vertical = 6.dp)) }
                if (paste) {
                    OutlinedTextField(
                        value = pasted,
                        onValueChange = { pasted = it },
                        placeholder = { Text("http://localhost:.../callback?code=...", style = CodeStyle) },
                        singleLine = true,
                        textStyle = CodeStyle,
                        modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 6.dp),
                    )
                }
                Row(Modifier.padding(horizontal = 20.dp, vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                    if (paste) {
                        Button(enabled = pasted.isNotBlank() && !busy, colors = solidButtonColors(), modifier = Modifier.heightIn(min = 48.dp), onClick = {
                            scope.launch {
                                busy = true
                                try {
                                    val st = hub.api { it.finishSignIn(f.state, pasted.trim()) }
                                    if (st.status != "wait") done(st.status == "ok", st.error)
                                } catch (e: Exception) {
                                    say(errorText(e))
                                }
                                busy = false
                            }
                        }) { Text("Finish") }
                    }
                    OutlinedButton(onClick = { open(f.url) }, colors = outlineButtonColors(), border = outlineButtonBorder(), modifier = Modifier.heightIn(min = 48.dp)) { Text("Open again") }
                    TextButton(onClick = {
                        scope.launch { runCatching { hub.api { it.cancelSignIn(f.state) } } }
                        flow = null
                        pasted = ""
                    }) { Text("Cancel") }
                }
            }

            SectionHeader("Plans")
            Providers.rows(s, more).forEach { p ->
                NavRow(p.name, "${p.plan.ifBlank { p.name }}. ${Providers.who(s, p)}", chevron = false, onClick = {
                    if (!busy && flow == null && Providers.usable(s)) signIn(p.id, p.name)
                })
            }
            if (!more && s.providers.any { it.more }) NavRow("More plans", null, onClick = { more = true })
            Note("Tap a plan to sign in, or to add another account. Tokens stay on the hub.")

            if (s.accounts.isNotEmpty()) {
                SectionHeader("Accounts")
                s.accounts.forEach { a ->
                    val (w, _) = Providers.accountWord(a.state)
                    NavRow(Providers.accountLabel(a), listOfNotNull(a.providerName, w, a.detail).joinToString(". "), chevron = false, onClick = { removing = a.name })
                }
            }
        }
    }

    removing?.let { name ->
        val a = status?.accounts?.firstOrNull { it.name == name }
        ConfirmDialog(
            title = "Sign out ${a?.let { Providers.accountLabel(it) } ?: name}?",
            text = "Sessions on this plan stop using it. Sign in again any time.",
            confirmLabel = "Sign out",
            destructive = true,
            onConfirm = {
                removing = null
                scope.launch {
                    try {
                        status = hub.api { it.removeSubscriptionAccount(name) }
                        hub.refreshCatalog()
                    } catch (e: Exception) {
                        say(errorText(e))
                    }
                }
            },
            onDismiss = { removing = null },
            extra = if (a?.canRefresh == true) {
                {
                    TextButton(onClick = {
                        removing = null
                        scope.launch { runCatching { status = hub.api { it.refreshSubscriptionAccount(name) } }.onFailure { say(errorText(it)) } }
                    }) { Text("Refresh instead") }
                }
            } else {
                null
            },
        )
    }
}
