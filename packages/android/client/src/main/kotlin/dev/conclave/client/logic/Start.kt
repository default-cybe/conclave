package dev.conclave.client.logic

import dev.conclave.client.model.AgentDef
import dev.conclave.client.model.CommandDef
import dev.conclave.client.model.Device
import dev.conclave.client.model.Session
import dev.conclave.client.model.SessionMode
import dev.conclave.client.model.SessionStatus
import dev.conclave.client.model.repo

/*
 * What a new conversation starts, by the switch at the top (docs/DESIGN.md
 * 15 and 40, web features/home/start.ts): Chat (a plain chat with the chat
 * agent), Assistant (the assistant agent on the hub, no device or folder) or
 * Code (the default coding agent in a folder on a computer). Kept here so
 * the rules are tested without a device.
 */

/** Chat, Assistant or Code, in the switch's order. */
enum class StartMode(val label: String, val wire: String) {
    CHAT("Chat", "chat"),
    ASSISTANT("Assistant", "assistant"),
    CODE("Code", "code"),
    ;

    /** What New says in this mode. */
    val newWords: String
        get() = when (this) {
            CHAT -> "New chat"
            ASSISTANT -> "New assistant chat"
            CODE -> "New session"
        }

    companion object {
        fun from(wire: String?): StartMode? = entries.firstOrNull { it.wire == wire }
    }
}

object Start {
    /** The agents the switch starts. Code starts a custom agent only when one was picked under "+". */
    const val ASSISTANT_AGENT = "assistant"
    const val CODE_AGENT = "coder"
    const val CHAT_AGENT = "chat"

    /** The box's words: commands for the assistant and Code, a question for a chat. */
    fun placeholder(mode: StartMode): String = if (mode == StartMode.CHAT) "Ask anything" else "Type / for commands"

    /** Which switch a conversation belongs to: a chat, the assistant's, or Code. */
    fun modeOf(s: Session): StartMode = when {
        s.isChat -> StartMode.CHAT
        s.agent == ASSISTANT_AGENT -> StartMode.ASSISTANT
        else -> StartMode.CODE
    }

    /**
     * What New starts from where you are (web PhoneFrame's bar): an open
     * conversation's own mode, a chat on its way or the Chats list a chat,
     * the Code list Code, anywhere else the switch's [remembered] mode.
     */
    fun newMode(remembered: StartMode, open: Session? = null, inChats: Boolean = false, inCodeList: Boolean = false): StartMode = when {
        open != null -> modeOf(open)
        inChats -> StartMode.CHAT
        inCodeList -> StartMode.CODE
        else -> remembered
    }

    /**
     * Whether Code's quiet row names the computer (docs/DESIGN.md 40): only
     * when there is more than one to choose from, and never for a repository
     * (its worktree is made where the hub puts it).
     */
    fun showsComputer(devices: List<Device>, repo: Boolean = false): Boolean = !repo && computers(devices).size > 1

    /** An agent Code may start in place of its own: not the chat or the assistant agent. */
    fun customAgent(name: String?): Boolean = !name.isNullOrBlank() && name != CHAT_AGENT && name != ASSISTANT_AGENT

    /**
     * The agents "+" offers next to the default coding agent: custom ones
     * (not shipped, not a subagent, not the chat or assistant agent), and the
     * one picked even when it is not. Empty: "+" has no Agent group.
     */
    fun customAgents(agents: List<AgentDef>, picked: String? = null): List<AgentDef> = agents.filter { a ->
        a.name != CODE_AGENT && customAgent(a.name) &&
            ((a.primary != false && a.subagent != true && a.source != "builtin") || a.name == picked)
    }

    /** The hub's own device id: Code runs there unless told otherwise. */
    const val HUB = "local"

    /** A phone pairs to use the hub; it never runs code itself. */
    fun isPhone(d: Device?): Boolean = d?.info?.platform == "ios" || d?.info?.platform == "android"

    /**
     * Places Code can run, as the pickers list them: the hub first (always,
     * even before the device list is in), then every other device but
     * phones, online ones first.
     */
    fun computers(devices: List<Device>): List<Device> {
        val hub = devices.firstOrNull { it.id == HUB } ?: Device(HUB, online = true)
        return listOf(hub) + devices.filter { it.id != HUB && !isPhone(it) }.sortedByDescending { it.online }
    }

    /** How a place to run Code reads in a picker: a computer by its name, the hub as "homelab (hub)". */
    fun placeName(id: String?, devices: List<Device>, hubName: String? = null): String {
        val d = devices.firstOrNull { it.id == id }
        if (id == HUB) return "${d?.name?.ifBlank { null } ?: hubName?.ifBlank { null } ?: "conclave"} (hub)"
        return d?.name?.ifBlank { null } ?: id.orEmpty()
    }

    /**
     * Where Code runs when nothing else decides (docs/DESIGN.md 40, web
     * startDevice for a phone): a device picked by hand on this phone, else
     * the agent's own device, else the default device set in Settings, else
     * the hub. The last computer used does not decide, and a phone is never
     * the answer.
     */
    fun startDevice(picked: String?, agent: String? = null, hubDefault: String? = null, devices: List<Device> = emptyList()): String {
        val phone = { id: String -> isPhone(devices.firstOrNull { it.id == id }) }
        return listOf(picked, agent, hubDefault).firstOrNull { !it.isNullOrBlank() && !phone(it) } ?: HUB
    }

    /**
     * The last session the owner worked in by hand, of [mode] when given:
     * not a chat, a routine run, a subagent, a jury or a debate. [settled]
     * skips one still running or waiting.
     */
    fun lastOwn(sessions: List<Session>, mode: StartMode? = null, settled: Boolean = false): Session? = sessions
        .filter { !it.archived && it.routineId == null && !Delegated.underParent(it) && !it.isChat && it.mode != SessionMode.JURY && it.mode != SessionMode.DEBATE }
        .filter { mode == null || modeOf(it) == mode }
        .filter { !settled || it.status == SessionStatus.IDLE || it.status == SessionStatus.ERROR }
        .maxByOrNull { it.updatedAt }

    /** Agent, model, device and folder of a new Code session. A null [cwd] means none is known yet: Code asks before it starts. */
    data class Setup(val agent: String, val model: String?, val device: String, val cwd: String?)

    /** What was picked for Code on this phone, and what the hub knows. */
    data class CodeInput(
        val agent: String? = null,
        val model: String? = null,
        val device: String? = null,
        val cwd: String? = null,
        /** The last Code session ([lastOwn]): the last computer used and its folder. */
        val last: Session? = null,
        val agents: List<AgentDef> = emptyList(),
        val defaultModel: String? = null,
        val devices: List<Device> = emptyList(),
        /** Providers turned off on the hub (a harness): a model of theirs is not carried over. */
        val offProviders: Set<String> = emptySet(),
        /** The default device set in Settings (config defaultDevice). */
        val hubDefault: String? = null,
        /** The device [cwd] was picked on; a folder pick is not a device pick. Null: [device]'s. */
        val cwdDevice: String? = null,
    )

    /** The format of Code's saved picks: from 2, a folder keeps the device it is on apart from a device picked by hand. */
    const val PICKS_VERSION = 2

    /**
     * Code's saved device pick and the device of its saved folder (web
     * readPicks). Picks saved before [PICKS_VERSION] kept the folder's device
     * as if picked by hand: with a folder, that device is the folder's.
     */
    fun savedPlace(device: String?, cwd: String?, cwdDevice: String?, version: Int?): Pair<String?, String?> = when {
        version == PICKS_VERSION -> device to cwdDevice
        cwd != null -> null to device
        else -> device to null
    }

    private fun usable(model: String?, off: Set<String>): String? =
        model?.takeIf { it.isNotBlank() && it.substringBefore('/') !in off }

    /**
     * Code's setup (web sessionSetup): the default coding agent, or a custom
     * one picked under "+". The model is the one picked, else the last Code
     * session's when it ran the same agent, else the agent's or the hub's.
     * The device is [startDevice]: the one picked, else the agent's, else the
     * default device from Settings, else the hub. It must be online: the hub,
     * else the first online computer, stands in (never a phone). A folder
     * carries over only on the device it belongs to, and a repo session's
     * worktree never does.
     */
    fun code(i: CodeInput): Setup {
        val known = { name: String? -> name?.takeIf { n -> n.isNotBlank() && (i.agents.isEmpty() || i.agents.any { it.name == n }) } }
        val picked = if (customAgent(i.agent)) known(i.agent) else null
        val agent = picked
            ?: known(CODE_AGENT)
            ?: i.agents.filter { it.primary != false }.map { it.name }.firstOrNull { customAgent(it) && known(it) != null }
            ?: CODE_AGENT
        val def = i.agents.firstOrNull { it.name == agent }
        val last = i.last
        val fromLast = last != null && last.agent == agent
        val model = usable(i.model, i.offProviders)
            ?: usable(if (fromLast) last?.model else def?.model, i.offProviders)
            ?: usable(def?.model, i.offProviders)
            ?: i.defaultModel?.ifBlank { null }
        val wanted = startDevice(i.device, def?.device, i.hubDefault, i.devices)
        val device = when {
            // the device list is not in yet, or the hub: the hub is always there
            i.devices.isEmpty() || wanted == HUB || i.devices.any { it.id == wanted && it.online } -> wanted
            // a phone never stands in: Code runs on a computer
            else -> computers(i.devices).firstOrNull { it.online }?.id ?: wanted
        }
        val cwd = when {
            i.cwd != null -> i.cwd.takeIf { (i.cwdDevice ?: i.device).let { on -> on == null || on == device } }
            last != null && last.device == device && last.repo == null -> last.cwd.takeIf { it.isNotBlank() && it != "~" }
            else -> null
        }
        return Setup(agent, model, device, cwd)
    }

    /** The assistant's model: the one picked for it, else its agent's, else the hub's. */
    fun assistantModel(picked: String?, agents: List<AgentDef>, defaultModel: String?, offProviders: Set<String> = emptySet()): String? =
        usable(picked, offProviders)
            ?: usable(agents.firstOrNull { it.name == ASSISTANT_AGENT }?.model, offProviders)
            ?: defaultModel?.ifBlank { null }

    private val SLASH = Regex("^/(\\S*)$")
    private val COMMAND = Regex("^/(\\S+)")

    /** The part of a command's name typed so far, while the message is "/" and one word. Null otherwise. */
    fun slashQuery(text: String): String? = SLASH.matchEntire(text)?.groupValues?.get(1)

    /**
     * The hub's commands the "/" menu offers for [text]: names that start
     * with what was typed first, then names that contain it. Empty when the
     * message is not a command being typed.
     */
    fun slashMatches(text: String, commands: List<CommandDef>, max: Int = 8): List<CommandDef> {
        val q = slashQuery(text)?.lowercase() ?: return emptyList()
        val all = commands.distinctBy { it.name }
        val starts = all.filter { it.name.lowercase().startsWith(q) }
        val contains = all.filter { q.isNotEmpty() && it !in starts && it.name.lowercase().contains(q) }
        return (starts + contains).take(max)
    }

    /** A message that is one of the hub's commands ("/compact keep the plan"): its name, else null. */
    fun commandOf(text: String, commands: List<CommandDef>): String? {
        val name = COMMAND.find(text.trim())?.groupValues?.get(1) ?: return null
        return name.takeIf { n -> commands.any { it.name == n } }
    }
}
