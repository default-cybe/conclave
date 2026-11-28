package dev.conclave.app.ui.chat

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import dev.conclave.app.ui.common.ModelPickerSheet
import dev.conclave.app.ui.common.Segmented
import dev.conclave.app.ui.common.solidButtonColors
import dev.conclave.app.ui.conversation.ChoiceRow
import dev.conclave.app.ui.conversation.OptionLabel
import dev.conclave.app.ui.conversation.OptionRow
import dev.conclave.app.ui.conversation.OptionsSheet
import dev.conclave.app.ui.conversation.SwitchRow
import dev.conclave.app.ui.theme.CodeStyle
import dev.conclave.client.logic.SessionModes
import dev.conclave.client.model.ModeConfig
import dev.conclave.client.model.ModelGroup
import dev.conclave.client.model.SessionMode

/**
 * The setup of Jury, Debate and Loop (web chat/pickers.tsx JurorsPicker,
 * DebatersPicker, Loop): the jurors and how the judge decides, the two
 * debaters and the rounds, or the check command and the most runs. Save
 * sends it as the session's modeConfig.
 */
@Composable
internal fun ModeSetupSheet(mode: SessionMode, cfg: ModeConfig?, groups: List<ModelGroup>, onSave: (ModeConfig) -> Unit, onDismiss: () -> Unit) {
    var now by remember { mutableStateOf(SessionModes.config(mode, cfg)) }
    // which model is being picked: "juror" (adds one), "a" or "b" (a debater)
    var picking by remember { mutableStateOf<String?>(null) }
    val names = remember(groups) { groups.flatMap { it.models }.filter { it.ref.isNotBlank() }.associate { it.ref to it.name.ifBlank { it.id } } }
    fun name(ref: String) = names[ref] ?: ref

    OptionsSheet("${SessionModes.label(mode)} setup", onDismiss = onDismiss) {
        val jury = now.jury
        val debate = now.debate
        val loop = now.loop
        when {
            mode == SessionMode.JURY && jury != null -> {
                OptionLabel("Jurors. Tap one to take it out.")
                jury.jurors.forEach { ref ->
                    ChoiceRow(name(ref), selected = true, onClick = {
                        // a jury keeps at least one juror
                        if (jury.jurors.size > 1) now = now.copy(jury = jury.copy(jurors = jury.jurors - ref))
                    })
                }
                OptionRow("Add a juror", null, onClick = { picking = "juror" })
                OptionLabel("How the judge decides")
                Segmented(
                    value = jury.strategy,
                    options = listOf("synthesize" to "Merge", "vote" to "Vote", "rank" to "Rank"),
                    onChange = { now = now.copy(jury = jury.copy(strategy = it)) },
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp),
                )
                // web JurorsPicker: the judge (the session's model while none is picked), anonymize, juror tools
                OptionRow("Judge", jury.judge?.let(::name) ?: "The chat's model", onClick = { picking = "judge" })
                SwitchRow("Hide model names from the judge", null, jury.anonymize) { now = now.copy(jury = jury.copy(anonymize = it)) }
                SwitchRow("Jurors may read files", null, jury.jurorTools == "readonly") { now = now.copy(jury = jury.copy(jurorTools = if (it) "readonly" else "none")) }
            }
            mode == SessionMode.DEBATE && debate != null -> {
                OptionRow("First side", name(debate.a), onClick = { picking = "a" })
                OptionRow("Second side", name(debate.b), onClick = { picking = "b" })
                OptionLabel("Rounds")
                Segmented(
                    value = debate.rounds,
                    options = listOf(1, 2, 3, 4).map { it to it.toString() },
                    onChange = { now = now.copy(debate = debate.copy(rounds = it)) },
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp),
                )
                OptionRow("Judge", debate.judge?.let(::name) ?: "The chat's model", onClick = { picking = "djudge" })
            }
            mode == SessionMode.LOOP && loop != null -> {
                OptionLabel("Repeat until this command passes")
                OutlinedTextField(
                    value = loop.untilCommand.orEmpty(),
                    onValueChange = { now = now.copy(loop = loop.copy(untilCommand = it.ifEmpty { null })) },
                    placeholder = { Text("bun test", style = CodeStyle) },
                    textStyle = CodeStyle,
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(autoCorrectEnabled = false),
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 4.dp),
                )
                OptionLabel("Most runs")
                Segmented(
                    value = loop.maxIterations,
                    options = listOf(4, 8, 16, 32).map { it to "$it runs" },
                    onChange = { now = now.copy(loop = loop.copy(maxIterations = it)) },
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp),
                )
            }
        }
        Button(
            onClick = { onSave(now) },
            colors = solidButtonColors(),
            modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 12.dp).height(52.dp),
        ) { Text("Save") }
    }

    picking?.let { what ->
        ModelPickerSheet(
            title = when (what) {
                "juror" -> "Add a juror"
                "judge", "djudge" -> "Judge"
                else -> "Pick a debater"
            },
            groups = groups,
            current = when (what) {
                "a" -> now.debate?.a
                "b" -> now.debate?.b
                "judge" -> now.jury?.judge
                "djudge" -> now.debate?.judge
                else -> null
            },
            onPick = { ref ->
                picking = null
                val jury = now.jury
                val debate = now.debate
                now = when {
                    what == "juror" && jury != null -> now.copy(jury = jury.copy(jurors = (jury.jurors + ref).distinct()))
                    what == "a" && debate != null -> now.copy(debate = debate.copy(a = ref))
                    what == "b" && debate != null -> now.copy(debate = debate.copy(b = ref))
                    what == "judge" && jury != null -> now.copy(jury = jury.copy(judge = ref))
                    what == "djudge" && debate != null -> now.copy(debate = debate.copy(judge = ref))
                    else -> now
                }
            },
            onDismiss = { picking = null },
        )
    }
}
