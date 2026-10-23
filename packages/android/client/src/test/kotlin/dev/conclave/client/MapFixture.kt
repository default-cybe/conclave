package dev.conclave.client

import dev.conclave.client.model.MapDevice
import dev.conclave.client.model.MapGroup
import dev.conclave.client.model.MapHub
import dev.conclave.client.model.MapNode
import dev.conclave.client.model.MapNodeKind
import dev.conclave.client.model.MapSnapshot
import dev.conclave.client.model.MapState
import dev.conclave.client.model.MapToday
import dev.conclave.client.model.MapTool
import dev.conclave.client.model.MapTotals
import dev.conclave.client.model.MapUsage

/*
 * The Map's mock hub, the same as packages/web/src/mock/map-data.ts: three
 * projects on three devices, the chats, about fifteen agents with
 * subagents and one workflow run. Six run, one waits on you, one failed,
 * one is paused on a limit.
 */
object MapFixture {
    const val MIN = 60_000L
    const val HOUR = 60 * MIN

    /** Ids shaped like a hub's own (prefix, time, random), so the labels show a real short id. */
    object I {
        const val auth = "ses_mgwk9p34y6n3wd25rq4"
        const val explore = "ses_mgwf5zr37e3p3e2z8iq"
        const val paths = "ses_mgw9y7jzb6cn6z43dvy"
        const val review = "ses_mgwrkttnjfbf5jxvlsi"
        const val bench = "ses_mgw47wqal9vq24zklmv"
        const val correct = "ses_mgwt45hu43jsiom1tma"
        const val security = "ses_mgw7v3di8fppv5aspzh"
        const val tests = "ses_mgw8rzhqmoe95b9ee0v"
        const val docs = "ses_mgwbgi09qynk8w3tzpp"
        const val refute = "ses_mgwpp6up3c4dsa7l360"
        const val login = "ses_mgw9y6n14do9gmnu77v"
        const val push = "ses_mgwtuuj596lguax1dxn"
        const val e2e = "ses_mgw9y1xj5gxnameyywl"
        const val bundle = "ses_mgwecfpecxvm11hugcm"
        const val backup = "ses_mgwsmn5e6eucldu0um5"
        const val certs = "ses_mgw7ocubrl5ptp5aa81"
        const val week = "ses_mgw9t9um9zz8106x8rc"
        const val proxy = "ses_mgwd1gdiwfkgyq83mtx"
        const val run = "wfr_mgwqw8y9xw1sb09b9u7"
    }

    private fun usage(i: Long, o: Long, cr: Long, cost: Double, cw: Long = Math.round(cr / 9.0)) = MapUsage(i, o, cr, cw, cost)

    private fun tool(now: Long, name: String, target: String, agoS: Long, durationMs: Long? = null, error: Boolean = false) = MapTool(
        id = "tu_${name}_${target}_$agoS".replace(Regex("""[^\w]"""), "_"),
        name = name,
        target = target,
        startedAt = now - agoS * 1000,
        durationMs = durationMs,
        error = error,
    )

    fun snapshot(now: Long): MapSnapshot {
        val conclave = "p:prj_conclave@arch-desktop"
        val fernway = "p:prj_fernway@macbook"
        val homelab = "p:prj_homelab@pve"
        fun n(x: MapNode, startedMin: Double, lastS: Long): MapNode = x.copy(startedAt = now - Math.round(startedMin * MIN), lastActivityAt = now - lastS * 1000)
        val nodes = ArrayList<MapNode>()
        nodes += n(
            MapNode(
                id = I.auth, kind = MapNodeKind.SESSION, title = "Move auth middleware to jose", state = MapState.RUNNING, agent = "coder",
                model = "anthropic/claude-sonnet-5-5", device = "arch-desktop", cwd = "~/code/conclave", group = conclave,
                tool = tool(now, "Bash", "bun test packages/server", 4),
                tools = listOf(tool(now, "Edit", "auth.ts", 41, 140), tool(now, "Read", "pair.ts", 63, 220), tool(now, "Grep", "jwtVerify", 95, 1_800), tool(now, "Edit", "auth.ts", 160, 120), tool(now, "Read", "auth.ts", 212, 310)),
                usage = usage(184_200, 9_400, 1_510_000, 0.71), tokensPerMin = 1_920.0, rate = 34.0,
            ),
            38.0, 2,
        )
        nodes += n(
            MapNode(
                id = I.explore, kind = MapNodeKind.SUBAGENT, title = "Find all JWT usages", state = MapState.DONE, agent = "explore",
                model = "anthropic/claude-haiku-5-5", device = "arch-desktop", cwd = "~/code/conclave", group = conclave, parentId = I.auth,
                tools = listOf(tool(now, "Grep", "jwtVerify|jose", 2_050, 900), tool(now, "Read", "routes.ts", 2_080, 240)),
                usage = usage(31_000, 900, 220_000, 0.02), endedAt = now - 34 * MIN,
            ),
            35.0, 34 * 60,
        )
        nodes += n(
            MapNode(
                id = I.paths, kind = MapNodeKind.SUBAGENT, title = "Check jose import paths", state = MapState.RUNNING, agent = "explore",
                model = "anthropic/claude-haiku-5-5", device = "arch-desktop", cwd = "~/code/conclave", group = conclave, parentId = I.auth,
                tool = tool(now, "Glob", "packages/**/package.json", 2), tools = listOf(tool(now, "Read", "tsconfig.base.json", 14, 90)),
                usage = usage(12_400, 1_100, 48_000, 0.01), tokensPerMin = 980.0, rate = 21.0,
            ),
            3.0, 2,
        )
        nodes += n(
            MapNode(
                id = I.review, kind = MapNodeKind.SESSION, title = "Review the jose diff", state = MapState.IDLE, agent = "reviewer",
                model = "openai/gpt-5.5", device = "arch-desktop", cwd = "~/code/conclave", group = conclave,
                tools = listOf(tool(now, "Read", "auth.ts", 52 * 60, 180)), usage = usage(41_000, 2_600, 0, 0.09), endedAt = now - 50 * MIN,
            ),
            55.0, 50 * 60,
        )
        nodes += n(
            MapNode(
                id = I.bench, kind = MapNodeKind.SESSION, title = "Benchmark the harness, run 5", state = MapState.PAUSED, agent = "tester",
                model = "claude-code/opus", device = "arch-desktop", cwd = "~/code/conclave", group = conclave, resumeAt = now + 83 * MIN,
                tools = listOf(tool(now, "Bash", "bun bench/run.ts --arm b", 40 * 60, 312_000)), usage = usage(96_000, 7_200, 640_000, 1.84),
            ),
            150.0, 37 * 60,
        )
        nodes += n(
            MapNode(
                id = "wf:${I.run}", kind = MapNodeKind.WORKFLOW, title = "review-changes", state = MapState.RUNNING, agent = "workflow",
                device = "arch-desktop", cwd = "~/code/conclave", group = conclave, runId = I.run,
                usage = usage(162_000, 14_900, 920_000, 0.88), tokensPerMin = 2_520.0,
            ),
            12.0, 1,
        )
        val lenses = listOf(
            listOf(I.correct, "correctness lens", "running", "Read", "auth.ts", 26, 1_440),
            listOf(I.security, "security lens", "running", "Grep", "alg.*none", 17, 1_080),
            listOf(I.tests, "tests lens", "done", "Bash", "bun test packages/server", 0, 0),
            listOf(I.docs, "docs lens", "done", "Read", "DESIGN.md", 0, 0),
            listOf(I.refute, "refuter, finding 2", "done", "Read", "pair.ts", 0, 0),
        )
        lenses.forEachIndexed { i, l ->
            val id = l[0] as String
            val running = l[2] == "running"
            val rate = (l[5] as Int).toDouble()
            nodes += n(
                MapNode(
                    id = id, kind = MapNodeKind.AGENT, title = l[1] as String, state = if (running) MapState.RUNNING else MapState.DONE,
                    agent = if (i == 4) "verifier" else "reviewer", model = if (i == 4) "anthropic/claude-opus-5-5" else "anthropic/claude-sonnet-5-5",
                    device = "arch-desktop", cwd = "~/code/conclave", group = conclave, parentId = "wf:${I.run}", runId = I.run,
                    tool = if (running) tool(now, l[3] as String, l[4] as String, 3L + i * 2) else null,
                    endedAt = if (running) null else now - (4L + i) * MIN,
                    tools = listOf(tool(now, l[3] as String, l[4] as String, 90L + i * 30, 400L + i * 120)),
                    usage = usage(30_000L + i * 4_000, 2_400L + i * 300, 160_000, 0.16 + i * 0.02),
                    tokensPerMin = (l[6] as Int).toDouble(), rate = rate,
                ),
                11.0 - i, if (running) 1 else (4L + i) * 60,
            )
        }
        nodes += n(
            MapNode(
                id = I.login, kind = MapNodeKind.SESSION, title = "Fix login redirect", state = MapState.RUNNING, agent = "coder",
                model = "anthropic/claude-opus-5-5", device = "macbook", cwd = "~/Developer/fernway-web", group = fernway,
                tool = tool(now, "Edit", "redirect.ts", 1),
                tools = listOf(tool(now, "Read", "redirect.ts", 9, 60), tool(now, "Read", "login-form.ts", 22, 70), tool(now, "Grep", "afterLogin", 31, 640)),
                usage = usage(58_000, 4_100, 310_000, 0.62), tokensPerMin = 2_700.0, rate = 46.0,
            ),
            9.0, 1,
        )
        nodes += n(
            MapNode(
                id = I.push, kind = MapNodeKind.SESSION, title = "Push the login fix", state = MapState.WAITING, waitingOn = "approval", agent = "coder",
                model = "anthropic/claude-sonnet-5-5", device = "macbook", cwd = "~/Developer/fernway-web", group = fernway,
                tool = tool(now, "Bash", "git push origin fix/login", 128), tools = listOf(tool(now, "Bash", "git log --oneline -3", 140, 210)),
                usage = usage(19_000, 600, 41_000, 0.06),
            ),
            4.0, 128,
        )
        nodes += n(
            MapNode(
                id = I.e2e, kind = MapNodeKind.SESSION, title = "Write e2e tests for checkout", state = MapState.IDLE, agent = "tester",
                model = "anthropic/claude-sonnet-5-5", device = "macbook", cwd = "~/Developer/fernway-web", group = fernway,
                tools = listOf(tool(now, "Bash", "bunx playwright test", 3 * 3600, 48_000), tool(now, "Write", "checkout.spec.ts", 3 * 3600 + 90, 30)),
                usage = usage(88_000, 6_400, 720_000, 0.48), endedAt = now - 3 * HOUR,
            ),
            4.0 * 60, 3 * 3600,
        )
        nodes += n(
            MapNode(
                id = I.bundle, kind = MapNodeKind.SESSION, title = "Audit the bundle size", state = MapState.FAILED, agent = "coder",
                model = "zai/glm-5", device = "macbook", cwd = "~/Developer/fernway-web", group = fernway,
                error = "vite build exited with code 1: Could not resolve \"./charts\"",
                tools = listOf(tool(now, "Bash", "bunx vite build --mode analyze", 47 * 60, 9_400, true)),
                usage = usage(22_000, 1_300, 0, 0.03), endedAt = now - 47 * MIN,
            ),
            58.0, 47 * 60,
        )
        nodes += n(
            MapNode(
                id = I.backup, kind = MapNodeKind.SESSION, title = "Verify PBS backups for all LXCs", state = MapState.RUNNING, agent = "sysadmin",
                model = "claude-code/sonnet", device = "pve", cwd = "/root/scripts", group = homelab,
                tool = tool(now, "Bash", "proxmox-backup-client list", 6), tools = listOf(tool(now, "Bash", "pct list", 18, 900), tool(now, "Read", "backup.sh", 25, 40)),
                usage = usage(36_000, 2_200, 140_000, 0.21), tokensPerMin = 640.0, rate = 11.0,
            ),
            52.0, 3,
        )
        nodes += n(
            MapNode(
                id = I.certs, kind = MapNodeKind.SESSION, title = "Rotate the Caddy certificates", state = MapState.DONE, agent = "sysadmin",
                model = "anthropic/claude-sonnet-5-5", device = "pve", cwd = "/root/scripts", group = homelab,
                tools = listOf(tool(now, "Bash", "systemctl reload caddy", 6 * 3600, 1_200)), usage = usage(14_000, 900, 61_000, 0.05), endedAt = now - 6 * HOUR,
            ),
            7.0 * 60, 6 * 3600,
        )
        nodes += n(
            MapNode(id = I.week, kind = MapNodeKind.CHAT, title = "Plan the week", state = MapState.IDLE, agent = "chat", model = "anthropic/claude-sonnet-5-5", device = "local", group = "chats", usage = usage(6_200, 900, 12_000, 0.03), endedAt = now - 2 * HOUR),
            2.5 * 60, 2 * 3600,
        )
        nodes += n(
            MapNode(
                id = I.proxy, kind = MapNodeKind.CHAT, title = "Caddy or Traefik for the homelab", state = MapState.IDLE, agent = "chat", model = "openai/gpt-5.5", device = "local", group = "chats",
                tools = listOf(tool(now, "WebSearch", "caddy vs traefik 2026", 5 * 3600, 2_100)), usage = usage(22_000, 6_100, 0, 0.19), endedAt = now - 5 * HOUR,
            ),
            5.5 * 60, 5 * 3600,
        )

        val counted = nodes.filter { it.kind != MapNodeKind.WORKFLOW }
        val running = counted.count { it.state == MapState.RUNNING }
        val waiting = counted.count { it.state == MapState.WAITING }
        return MapSnapshot(
            at = now,
            live = true,
            from = now - 24 * HOUR,
            hub = MapHub("madx", if (waiting > 0) MapState.WAITING else if (running > 0) MapState.RUNNING else MapState.IDLE),
            devices = listOf(
                MapDevice("local", "madx", true),
                MapDevice("arch-desktop", "arch-desktop", true),
                MapDevice("macbook", "MacBook", true),
                MapDevice("pve", "pve", true),
                MapDevice("kali-vm", "kali-vm", false),
            ),
            groups = listOf(
                MapGroup(conclave, "project", "conclave", "arch-desktop", "prj_conclave", "~/code/conclave"),
                MapGroup(fernway, "project", "fernway-web", "macbook", "prj_fernway", "~/Developer/fernway-web"),
                MapGroup(homelab, "project", "homelab-scripts", "pve", "prj_homelab", "/root/scripts"),
                MapGroup("chats", "chats", "Chats", "local"),
            ),
            nodes = nodes,
            totals = MapTotals(running, waiting, MapToday(now - 15 * HOUR, 3_412_000, 8.12)),
        )
    }

    /** A small seeded random generator, so a failing case can be run again (the web test's rng). */
    fun rng(seed: Int): () -> Double {
        var s = seed
        return {
            s = ((s xor (s ushr 15)) * 0x2c1b3c6d) + 0x9e3779b9L.toInt()
            ((s.toLong() and 0xffffffffL) % 100_000) / 100_000.0
        }
    }

    private val WORDS = listOf("Fix", "login", "redirect", "Move", "auth", "middleware", "to", "jose", "Write", "tests", "for", "the", "checkout", "flow", "Audit", "bundle", "size", "Rotate", "certificates", "a", "very", "long", "title", "that", "keeps", "going", "past", "the", "edge")
    private val STATES = MapState.entries

    /** A random hub: up to 6 groups on up to 4 devices, up to 40 nodes with subagents and runs. */
    fun random(seed: Int, now: Long): MapSnapshot {
        val r = rng(seed)
        fun <T> pick(xs: List<T>): T = xs[(r() * xs.size).toInt()]
        val devices = listOf("local", "arch", "mac", "pve").take(1 + (r() * 4).toInt())
        val groups = ArrayList<MapGroup>()
        val nGroups = 1 + (r() * 6).toInt()
        for (i in 0 until nGroups) {
            val device = pick(devices)
            groups += if (i == 0 && r() < 0.5) {
                MapGroup("chats", "chats", "Chats", "local")
            } else {
                MapGroup("g$i", if (r() < 0.6) "project" else "folder", List(1 + (r() * 3).toInt()) { pick(WORDS) }.joinToString("-"), device)
            }
        }
        val nodes = ArrayList<MapNode>()
        val n = (r() * 40).toInt()
        for (i in 0 until n) {
            val parent = if (nodes.isNotEmpty() && r() < 0.35) pick(nodes) else null
            val g = if (parent != null) groups.first { it.id == parent.group } else pick(groups)
            val kind = when {
                parent != null -> if (parent.kind == MapNodeKind.WORKFLOW) MapNodeKind.AGENT else if (r() < 0.15) MapNodeKind.WORKFLOW else MapNodeKind.SUBAGENT
                g.isChats -> MapNodeKind.CHAT
                r() < 0.15 -> MapNodeKind.WORKFLOW
                else -> MapNodeKind.SESSION
            }
            nodes += MapNode(
                id = "ses_${seed}_${i.toString().padStart(3, '0')}",
                kind = kind,
                title = List(1 + (r() * 9).toInt()) { pick(WORDS) }.joinToString(" "),
                state = pick(STATES),
                device = g.device,
                group = g.id,
                parentId = parent?.id,
                startedAt = now - (r() * 86_400_000).toLong(),
                lastActivityAt = now,
                stuckSince = if (r() < 0.1) now - 6 * MIN else null,
            )
        }
        return MapSnapshot(
            at = now,
            live = true,
            from = now - 86_400_000,
            hub = MapHub(pick(listOf("madx", "homelab", "a-hub-with-a-long-name")), MapState.RUNNING),
            devices = devices.map { id -> MapDevice(id, if (id == "local") "madx" else id, r() < 0.8) },
            groups = groups,
            nodes = nodes,
        )
    }
}
