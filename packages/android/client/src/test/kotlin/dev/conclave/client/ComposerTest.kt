package dev.conclave.client

import dev.conclave.client.logic.ContextUse
import dev.conclave.client.logic.Effort
import dev.conclave.client.logic.EffortFollow
import dev.conclave.client.logic.Panel
import dev.conclave.client.logic.Start
import dev.conclave.client.logic.StartMode
import dev.conclave.client.model.AgentDef
import dev.conclave.client.model.CommandDef
import dev.conclave.client.model.Device
import dev.conclave.client.model.MachineInfo
import dev.conclave.client.model.Message
import dev.conclave.client.model.ModelEffort
import dev.conclave.client.model.ModelInfo
import dev.conclave.client.model.Role
import dev.conclave.client.model.Session
import dev.conclave.client.model.SessionKind
import dev.conclave.client.model.SessionMode
import dev.conclave.client.model.SessionStats
import dev.conclave.client.model.SessionStatus
import dev.conclave.client.model.ThinkingLevel
import dev.conclave.client.model.Usage
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The composer's quiet row and Home's three choices (docs/DESIGN.md 15, 37
 * and 40): the model with its effort as one label, the context ring's
 * numbers, where Code starts, the panel's recents per mode and "/".
 */
class ComposerTest {
    private val opus55 = ModelEffort(levels = listOf("low", "medium", "high", "xhigh", "max"), off = false, defaultLevel = "medium")
    private val opus46 = ModelEffort(levels = listOf("low", "medium", "high", "max"), off = true, defaultLevel = "high")
    private val glm = ModelEffort(levels = listOf("high"), off = true)

    // ---------------------------------------------------------------- the model and its effort

    @Test
    fun theModelAndItsEffortAreOneLabel() {
        assertEquals("Opus 5.5 Medium", Effort.words("anthropic/claude-opus-5-5", null, opus55))
        assertEquals("Opus 5.5 Extra high", Effort.words("anthropic/claude-opus-5-5", ThinkingLevel.XHIGH, opus55))
        // a level the model lacks shows as the nearest one it has
        assertEquals("Opus 4.6 High", Effort.words("anthropic/claude-opus-4-6", ThinkingLevel.XHIGH, opus46))
        // Off, a model without Effort, and a lone level (a switch) say the name only
        assertEquals("Opus 4.6", Effort.words("anthropic/claude-opus-4-6", ThinkingLevel.OFF, opus46))
        assertEquals("Haiku 4.5", Effort.words("anthropic/claude-haiku-4-5", ThinkingLevel.HIGH, null))
        assertEquals("GLM-5", Effort.words("zai/glm-5", ThinkingLevel.HIGH, glm))
        assertEquals("Choose a model", Effort.words(null, null, null))
    }

    @Test
    fun unsetRunsAtTheAgentsLevel() {
        val coder = Effort.follow("coder", null, "anthropic/claude-opus-5-5")
        assertEquals(EffortFollow("the coder agent", ThinkingLevel.MEDIUM), coder)
        // the agent's own level wins; the assistant and a model without levels follow the model
        assertEquals(ThinkingLevel.HIGH, Effort.follow("coder", "high", "anthropic/claude-opus-5-5").level)
        assertNull(Effort.follow("assistant", null, "anthropic/claude-opus-5-5").level)
        assertNull(Effort.follow("coder", null, "openai/gpt-5.5").level)
        assertEquals("the assistant agent", Effort.follow("assistant", null, null).label)
        assertTrue(Effort.takesEffort("claude-max/claude-sonnet-4-7-20260101"))
        assertFalse(Effort.takesEffort("anthropic/claude-haiku-4-5"))

        assertEquals("Opus 4.6 Medium", Effort.words("anthropic/claude-opus-4-6", null, opus46, coder))
        // picked beats the agent's; Off picked is Off
        assertEquals(ThinkingLevel.LOW, Effort.running(ThinkingLevel.LOW, opus46, coder))
        assertEquals(ThinkingLevel.OFF, Effort.running(ThinkingLevel.OFF, opus46, coder))
        // nothing picked, nothing from the agent: the model's default
        assertEquals(ThinkingLevel.HIGH, Effort.running(null, opus46, EffortFollow("the assistant agent", null)))
        assertNull(Effort.running(ThinkingLevel.HIGH, null, coder))
    }

    // ---------------------------------------------------------------- the context ring

    private fun reply(id: String, input: Long, read: Long? = null, write: Long? = null) =
        Message(id, role = Role.ASSISTANT, usage = Usage(inputTokens = input, outputTokens = 10, cacheReadTokens = read, cacheWriteTokens = write))

    @Test
    fun theRingIsTheLastRepliesContextAgainstTheWindow() {
        val info = ModelInfo("claude-opus-5-5", ref = "anthropic/claude-opus-5-5", contextWindow = 200_000, inputPrice = 5.0, outputPrice = 25.0)
        val s = Session("s1", model = "anthropic/claude-opus-5-5", stats = SessionStats(inputTokens = 30_000, outputTokens = 4_200, cacheReadTokens = 90_000, costUsd = 0.42))
        val msgs = listOf(reply("a", 1_000), reply("b", 2_000, read = 40_000, write = 8_000), Message("u", role = Role.USER))
        val u = ContextUse.of(msgs, s, info)
        assertEquals(50_000, u.used)
        assertEquals(25, u.percent)
        assertEquals("Context, 25% used", u.label)
        assertEquals("50K of 200K, 25%", u.contextLine)
        assertEquals("120K in, 4.2K out", u.tokensLine)
        assertEquals("$0.42", u.costLine)
        assertFalse(u.high)
        assertTrue(u.session)

        assertTrue(ContextUse.of(listOf(reply("c", 190_000)), s, info).high)
        assertEquals(1.0, ContextUse.of(listOf(reply("c", 400_000)), s, info).share)
    }

    @Test
    fun aNewConversationHasNothingUsedAndAPlanCostsNothing() {
        val info = ModelInfo("claude-opus-5-5", contextWindow = 1_000_000)
        val fresh = ContextUse.of(emptyList(), null, info)
        assertEquals("Context, nothing used yet", fresh.label)
        assertEquals("0 of 1M", fresh.contextLine)
        assertFalse(fresh.session)
        assertEquals("Nothing used yet", ContextUse.of(emptyList(), null, null).contextLine)
        assertEquals("12K", ContextUse.of(listOf(reply("a", 12_000)), null, null).contextLine)

        val harness = Session("h", model = "claude-code/opus")
        assertEquals("plan", ContextUse.of(emptyList(), harness, null).costLine)
        val paid = Session("p", model = "anthropic/claude-opus-5-5")
        assertEquals("$0", ContextUse.of(emptyList(), paid, ModelInfo("claude-opus-5-5", inputPrice = 5.0, outputPrice = 25.0)).costLine)
    }

    @Test
    fun countsAreShortAsOnTheWeb() {
        assertEquals("950", ContextUse.compact(950))
        assertEquals("1.2K", ContextUse.compact(1_234))
        assertEquals("1K", ContextUse.compact(1_000))
        assertEquals("12K", ContextUse.compact(12_400))
        assertEquals("200K", ContextUse.compact(200_000))
        assertEquals("1M", ContextUse.compact(999_950))
        assertEquals("1.5M", ContextUse.compact(1_500_000))
        assertEquals("2B", ContextUse.compact(2_000_000_000))
    }

    // ---------------------------------------------------------------- Chat, Assistant, Code

    private val mac = Device("mac", name = "MacBook", online = true)
    private val pc = Device("pc", name = "Desktop", online = false)
    private val hub = Device("local", name = "Hub", online = true)
    private val phone = Device("phone", name = "Pixel", online = true, info = MachineInfo(platform = "android"))
    private val agents = listOf(
        AgentDef("coder", model = "anthropic/claude-opus-5-5", source = "builtin"),
        AgentDef("assistant", model = "anthropic/claude-sonnet-5-5", source = "builtin"),
        AgentDef("chat", source = "builtin"),
        AgentDef("explore", source = "builtin", subagent = true, primary = false),
        AgentDef("researcher", model = "openai/gpt-5.5"),
    )

    private fun code(id: String, updated: Long, device: String = "mac", cwd: String = "/Users/sam/app", model: String = "anthropic/claude-sonnet-5-5", agent: String = "coder") =
        Session(id, agent = agent, model = model, device = device, cwd = cwd, updatedAt = updated)

    @Test
    fun aConversationsModeIsItsSwitch() {
        assertEquals(StartMode.CHAT, Start.modeOf(Session("c", kind = SessionKind.CHAT)))
        assertEquals(StartMode.ASSISTANT, Start.modeOf(Session("a", agent = "assistant")))
        assertEquals(StartMode.CODE, Start.modeOf(Session("x", agent = "researcher")))
        assertEquals(StartMode.CODE, StartMode.from("code"))
        assertNull(StartMode.from("session"))
        assertEquals("New assistant chat", StartMode.ASSISTANT.newWords)
        assertEquals("Type / for commands", Start.placeholder(StartMode.CODE))
        assertEquals("Ask anything", Start.placeholder(StartMode.CHAT))
    }

    @Test
    fun newStartsTheModeOfWhereYouAre() {
        // an open conversation's own mode
        assertEquals(StartMode.ASSISTANT, Start.newMode(StartMode.CHAT, open = Session("a", agent = "assistant")))
        assertEquals(StartMode.CODE, Start.newMode(StartMode.CHAT, open = Session("x", agent = "coder")))
        assertEquals(StartMode.CHAT, Start.newMode(StartMode.CODE, open = Session("c", kind = SessionKind.CHAT)))
        // a chat on its way and the lists
        assertEquals(StartMode.CHAT, Start.newMode(StartMode.CODE, inChats = true))
        assertEquals(StartMode.CODE, Start.newMode(StartMode.ASSISTANT, inCodeList = true))
        // anywhere else: the switch
        assertEquals(StartMode.ASSISTANT, Start.newMode(StartMode.ASSISTANT))
    }

    @Test
    fun theComputerShowsOnlyWhenThereIsAChoice() {
        // the hub is always one of the places, so one computer is already a choice
        assertTrue(Start.showsComputer(listOf(mac, phone)))
        assertTrue(Start.showsComputer(listOf(hub, mac, pc, phone)))
        assertFalse(Start.showsComputer(listOf(hub, phone)))
        assertFalse(Start.showsComputer(emptyList()))
        assertFalse(Start.showsComputer(listOf(mac, pc), repo = true))
    }

    @Test
    fun aPhoneNeverRunsCode() {
        // a computer that is away gives way to the hub, never to the phone
        val away = Start.code(Start.CodeInput(device = "pc", last = code("s", 10, device = "pc"), agents = agents, devices = listOf(phone, pc, mac)))
        assertEquals("local", away.device)
        assertNull(away.cwd)
        // a phone picked or set as the default is passed over
        assertEquals("local", Start.code(Start.CodeInput(device = "phone", agents = agents, devices = listOf(hub, phone, mac))).device)
        assertEquals("local", Start.code(Start.CodeInput(agents = agents, devices = listOf(hub, phone, mac), hubDefault = "phone")).device)
        assertEquals("local", Start.startDevice("phone", devices = listOf(phone)))
        // the pickers list the hub first and no phone
        assertEquals(listOf("local", "mac", "pc"), Start.computers(listOf(pc, phone, mac, hub)).map { it.id })
        // the hub is listed before the device list is in
        assertEquals(listOf("local"), Start.computers(emptyList()).map { it.id })
    }

    @Test
    fun codeStartsOnTheHubUnlessADeviceWasPickedOrSetAsTheDefault() {
        // the last computer used does not decide: the hub, with no folder (Code asks)
        val last = code("s1", 10)
        val setup = Start.code(Start.CodeInput(last = last, agents = agents, devices = listOf(hub, mac, pc), defaultModel = "anthropic/claude-opus-5-5"))
        assertEquals(Start.Setup("coder", "anthropic/claude-sonnet-5-5", "local", null), setup)

        // a device picked on this phone wins, and its folder belongs to it
        val picked = Start.code(Start.CodeInput(device = "mac", cwd = "~", last = code("s3", 10, device = "local"), agents = agents, devices = listOf(hub, mac)))
        assertEquals("mac", picked.device)
        assertEquals("~", picked.cwd)
        // the default device from Settings comes next, and the last session's folder there carries over
        val byDefault = Start.code(Start.CodeInput(last = last, agents = agents, devices = listOf(hub, mac, pc), hubDefault = "mac"))
        assertEquals("mac", byDefault.device)
        assertEquals("/Users/sam/app", byDefault.cwd)
        // a pick beats the default
        assertEquals("pc", Start.startDevice("pc", hubDefault = "mac"))
        // the agent's own device comes before the default
        assertEquals("box", Start.startDevice(null, agent = "box", hubDefault = "mac"))
        // the last session on the hub keeps its folder
        assertEquals("/srv/app", Start.code(Start.CodeInput(last = code("s5", 10, device = "local", cwd = "/srv/app"), agents = agents, devices = listOf(hub, mac))).cwd)
        // the home folder of the last session is not carried over: Code asks
        assertNull(Start.code(Start.CodeInput(last = code("s4", 10, device = "local", cwd = "~"), agents = agents, devices = listOf(hub))).cwd)
        // nothing used yet: the hub, no folder
        assertEquals(Start.Setup("coder", "anthropic/claude-opus-5-5", "local", null), Start.code(Start.CodeInput(agents = agents, devices = listOf(hub))))
    }

    @Test
    fun aFolderPickIsNotADevicePick() {
        // a folder picked on the Mac keeps to the Mac, and Code still starts on the hub
        val folder = Start.code(Start.CodeInput(cwd = "/Users/sam/app", cwdDevice = "mac", agents = agents, devices = listOf(hub, mac)))
        assertEquals("local", folder.device)
        assertNull(folder.cwd)
        // once the Mac is where Code runs (picked, or the default in Settings), the folder comes with it
        assertEquals("/Users/sam/app", Start.code(Start.CodeInput(cwd = "/Users/sam/app", cwdDevice = "mac", agents = agents, devices = listOf(hub, mac), hubDefault = "mac")).cwd)
        // a folder on the hub
        assertEquals("/srv/app", Start.code(Start.CodeInput(cwd = "/srv/app", cwdDevice = "local", agents = agents, devices = listOf(hub, mac))).cwd)
        // picks saved before: a saved device with a folder was the folder's, not a pick
        assertEquals(null to "mac", Start.savedPlace("mac", "/Users/sam/app", null, null))
        assertEquals("mac" to null, Start.savedPlace("mac", null, null, null))
        assertEquals("pc" to "mac", Start.savedPlace("pc", "/Users/sam/app", "mac", Start.PICKS_VERSION))
    }

    @Test
    fun theHubReadsAsItsNameAndHub() {
        assertEquals("Hub (hub)", Start.placeName("local", listOf(hub, mac)))
        assertEquals("homelab (hub)", Start.placeName("local", listOf(mac), hubName = "homelab"))
        assertEquals("conclave (hub)", Start.placeName("local", emptyList()))
        assertEquals("MacBook", Start.placeName("mac", listOf(hub, mac)))
        assertEquals("gone", Start.placeName("gone", listOf(hub)))
    }

    @Test
    fun aRepoSessionsWorktreeAndAnOffProviderAreNotCarriedOver() {
        val meta = buildJsonObject { putJsonObject("repo") { put("repo", "sam/app"); put("branch", "conclave/fix") } }
        val repo = code("r", 10, cwd = "/Users/sam/.conclave/worktrees/fix").copy(meta = meta)
        // on the device it ran on, its worktree is still not where the next session starts
        assertNull(Start.code(Start.CodeInput(last = repo, agents = agents, devices = listOf(mac), hubDefault = "mac")).cwd)

        val onHarness = code("h", 10, model = "claude-code/opus")
        val setup = Start.code(Start.CodeInput(last = onHarness, agents = agents, devices = listOf(mac), offProviders = setOf("claude-code")))
        assertEquals("anthropic/claude-opus-5-5", setup.model)
        // another agent's model is not the coder's
        assertEquals("anthropic/claude-opus-5-5", Start.code(Start.CodeInput(last = code("o", 10, agent = "researcher", model = "openai/gpt-5.5"), agents = agents)).model)
    }

    @Test
    fun aCustomAgentIsPickedUnderPlusOnly() {
        assertEquals(listOf("researcher"), Start.customAgents(agents).map { it.name })
        assertEquals(listOf("explore", "researcher"), Start.customAgents(agents, picked = "explore").map { it.name })
        val custom = Start.code(Start.CodeInput(agent = "researcher", agents = agents, devices = listOf(mac)))
        assertEquals("researcher", custom.agent)
        assertEquals("openai/gpt-5.5", custom.model)
        // the assistant is never Code's agent; a removed one gives way
        assertEquals("coder", Start.code(Start.CodeInput(agent = "assistant", agents = agents)).agent)
        assertEquals("coder", Start.code(Start.CodeInput(agent = "gone", agents = agents)).agent)
        assertEquals(listOf("local", "mac", "pc"), Start.computers(listOf(pc, mac, phone, hub)).map { it.id })
    }

    @Test
    fun theAssistantsModelIsItsOwnUnlessPicked() {
        assertEquals("anthropic/claude-sonnet-5-5", Start.assistantModel(null, agents, "anthropic/claude-opus-5-5"))
        assertEquals("openai/gpt-5.5", Start.assistantModel("openai/gpt-5.5", agents, null))
        assertEquals("anthropic/claude-sonnet-5-5", Start.assistantModel("claude-code/opus", agents, null, setOf("claude-code")))
        assertEquals("anthropic/claude-opus-5-5", Start.assistantModel(null, emptyList(), "anthropic/claude-opus-5-5"))
    }

    @Test
    fun theLastOwnSessionSkipsWhatTheOwnerDidNotStart() {
        val list = listOf(
            code("old", 1),
            code("newer", 5),
            Session("chat", kind = SessionKind.CHAT, updatedAt = 50),
            code("routine", 40).copy(routineId = "r1"),
            code("sub", 40).copy(parentId = "newer"),
            code("jury", 40).copy(mode = SessionMode.JURY),
            Session("asst", agent = "assistant", updatedAt = 30),
            code("busy", 20).copy(status = SessionStatus.RUNNING),
        )
        assertEquals("asst", Start.lastOwn(list)?.id)
        assertEquals("busy", Start.lastOwn(list, StartMode.CODE)?.id)
        assertEquals("newer", Start.lastOwn(list, StartMode.CODE, settled = true)?.id)
        assertEquals("asst", Start.lastOwn(list, StartMode.ASSISTANT)?.id)
    }

    @Test
    fun thePanelListsTheRecentsOfTheMode() {
        val list = listOf(
            Session("c1", title = "Dinner", kind = SessionKind.CHAT, updatedAt = 9),
            Session("a1", title = "My week", agent = "assistant", updatedAt = 8),
            code("k1", 7).copy(title = "Fix the build"),
            code("k2", 6).copy(title = "", archived = true),
        )
        assertEquals(listOf("c1"), Panel.recents(list, mode = StartMode.CHAT).map { it.id })
        assertEquals(listOf("a1"), Panel.recents(list, mode = StartMode.ASSISTANT).map { it.id })
        assertEquals(listOf("k1"), Panel.recents(list, mode = StartMode.CODE).map { it.id })
        assertEquals(3, Panel.recents(list).size)
    }

    // ---------------------------------------------------------------- "/"

    private val commands = listOf(CommandDef("compact"), CommandDef("model"), CommandDef("review"), CommandDef("commit-push"))

    @Test
    fun slashListsTheHubsCommands() {
        assertEquals(listOf("compact", "commit-push"), Start.slashMatches("/co", commands).map { it.name })
        assertEquals(4, Start.slashMatches("/", commands).size)
        // "mi" is in commit-push only
        assertEquals(listOf("commit-push"), Start.slashMatches("/mi", commands).map { it.name })
        assertTrue(Start.slashMatches("/compact now", commands).isEmpty())
        assertTrue(Start.slashMatches("hello", commands).isEmpty())
        assertEquals("", Start.slashQuery("/"))
        assertNull(Start.slashQuery("a /b"))

        assertEquals("compact", Start.commandOf(" /compact keep the plan", commands))
        assertNull(Start.commandOf("/nope", commands))
        assertNull(Start.commandOf("compact", commands))
    }
}
