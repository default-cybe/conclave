package dev.conclave.app.ui.pairing

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
import androidx.compose.material.icons.outlined.Security
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.conclave.app.data.NewSignIn
import dev.conclave.app.ui.theme.CodeStyle
import dev.conclave.app.ui.theme.Conclave
import dev.conclave.app.ui.theme.ConclaveType
import dev.conclave.client.HubKeys
import dev.conclave.client.logic.HubAddresses

/**
 * The address in use answered with another key or a bad signature, so
 * nothing with the token went there (HUB-LOGIN-AND-IDENTITY.md section 2).
 * Try another address lists the saved ones; Pair again scans a new code.
 * Full screen over everything, until an address proves the key.
 */
@Composable
fun IdentityScreen(address: String, saved: List<String>, onUse: (String) -> Unit, onPairAgain: () -> Unit) {
    val c = Conclave.colors
    var choosing by remember { mutableStateOf(false) }
    val others = remember(address, saved) { saved.filterNot { HubAddresses.same(it, address) } }
    Surface(Modifier.fillMaxSize(), color = c.bg) {
        Column(
            Modifier.fillMaxSize().systemBarsPadding().verticalScroll(rememberScrollState()).padding(horizontal = 24.dp, vertical = 32.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Spacer(Modifier.height(24.dp))
            Icon(Icons.Outlined.Security, contentDescription = null, tint = c.fault, modifier = Modifier.size(40.dp))
            Text(
                "This address is not your hub.",
                style = ConclaveType.greeting.copy(fontSize = 28.sp, lineHeight = 34.sp, fontWeight = FontWeight.SemiBold),
                color = c.fg,
            )
            Text("Conclave did not send your sign-in.", style = ConclaveType.body.copy(fontSize = 16.sp, lineHeight = 23.sp), color = c.fg2)
            Text(HubAddresses.host(address).ifBlank { address }, style = CodeStyle, color = c.fg3, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(
                "Another machine answers at this address, perhaps on a network that reuses it. Use another address of your hub, or pair again.",
                style = ConclaveType.body,
                color = c.fg3,
            )
            Spacer(Modifier.height(8.dp))
            if (!choosing) {
                Button(onClick = { choosing = true }, modifier = Modifier.fillMaxWidth().height(52.dp)) { Text("Try another address") }
            } else if (others.isEmpty()) {
                Text("No other address is saved for your hub.", style = ConclaveType.body, color = c.fg2)
            } else {
                Column {
                    others.forEach { url ->
                        Row(
                            Modifier.fillMaxWidth().clickable { onUse(url) }.heightIn(min = 56.dp).padding(vertical = 8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(url, style = CodeStyle.copy(fontSize = 14.sp), color = c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                            Spacer(Modifier.width(8.dp))
                            Icon(Icons.AutoMirrored.Outlined.KeyboardArrowRight, contentDescription = null, tint = c.fg3)
                        }
                        HorizontalDivider(thickness = 1.dp, color = c.rule)
                    }
                }
            }
            OutlinedButton(onClick = onPairAgain, modifier = Modifier.fillMaxWidth().height(52.dp)) { Text("Pair again") }
        }
    }
}

/**
 * After a password login, once: the hub's fingerprint in groups of four, to
 * compare with Settings on the hub. There was no code to check it against.
 */
@Composable
fun FingerprintDialog(signIn: NewSignIn, onDone: () -> Unit) {
    val c = Conclave.colors
    AlertDialog(
        onDismissRequest = onDone,
        title = { Text(signIn.hubName?.let { "Signed in to $it" } ?: "Signed in") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text("Your hub's fingerprint", style = ConclaveType.meta, color = c.fg3)
                Text(HubKeys.groups(signIn.fingerprint), style = CodeStyle.copy(fontSize = 16.sp, lineHeight = 24.sp), color = c.fg)
                Text("Compare it with Settings on your hub.", style = ConclaveType.body, color = c.fg2)
            }
        },
        confirmButton = { TextButton(onClick = onDone) { Text("Done") } },
    )
}
