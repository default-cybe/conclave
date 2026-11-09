package dev.conclave.client.logic

import dev.conclave.client.model.Session

/**
 * The model picker's list, as on the web (components/pickers/ModelPicker.tsx):
 * provider tabs (All, Anthropic, OpenAI, Google, Z.ai, Local, Coding agents,
 * Other; only the ones that have models), then Pinned (the account's pins,
 * kept on the hub in preferences.pinnedModels), Recent (the last three in the
 * tab), then the tab's models under a heading per maker and a small one per
 * family, strongest family first (Mythos, Fable, Opus, Sonnet, Haiku; GPT,
 * mini and nano, o-series, Codex; Gemini Pro, Flash, Flash-Lite; GLM by
 * size), newest first inside. A search lists the matches of every tab, most
 * capable first, with no Pinned or Recent.
 */
object PickerTabs {
    /** The hub keeps at most this many pins (core client/people.ts PINS_MAX). */
    const val PINS_MAX = 50

    /** A tab; [maker] is the provider whose logo it shows, null for All (a word) and the neutral tabs (an icon). */
    enum class Tab(val label: String, val maker: String? = null) {
        ALL("All"),
        ANTHROPIC("Anthropic", "anthropic"),
        OPENAI("OpenAI", "openai"),
        GOOGLE("Google", "google"),
        ZAI("Z.ai", "zai"),
        LOCAL("Local"),
        AGENTS("Coding agents"),
        OTHER("Other"),
    }

    private val MAKER_TABS = mapOf("anthropic" to Tab.ANTHROPIC, "openai" to Tab.OPENAI, "google" to Tab.GOOGLE, "zai" to Tab.ZAI)

    // shortcut: local servers by provider id, as the web reads them; a custom provider on a LAN address counts as Other until the hub says where a provider runs
    private val LOCAL = setOf("ollama", "lmstudio", "llamacpp", "llama-cpp", "vllm", "localai", "jan")

    fun isLocalProvider(provider: String): Boolean = provider in LOCAL

    /** A row with its maker's key and name, as the list shows it. */
    data class Entry(val row: ModelPicks.Row, val makerKey: String, val makerName: String) {
        val tab: Tab get() = tabOf(makerKey, row)
    }

    /** Where a row sits in the list: Pinned, Recent, or the tab's ranked list. */
    enum class Section { PIN, RECENT, LIST }

    /** One line of the list: a heading (a maker's, with its logo, or a small family one) or a model. */
    sealed class Item {
        data class Head(val label: String, val maker: String? = null, val family: Boolean = false) : Item()
        data class Model(val entry: Entry, val section: Section) : Item()
    }

    /** A row's tab: coding agents, then local servers (whoever made the model), then its maker, else Other. */
    fun tabOf(makerKey: String, row: ModelPicks.Row): Tab = when {
        row.harness || makerKey == ModelPicks.AGENTS -> Tab.AGENTS
        isLocalProvider(row.ref.substringBefore('/')) -> Tab.LOCAL
        else -> MAKER_TABS[makerKey] ?: Tab.OTHER
    }

    /** OpenCode's free models (big-pickle, ids ending in -free), as the web's isFreeModel: free only inside the opencode CLI. */
    fun isFree(row: ModelPicks.Row): Boolean {
        val id = row.ref.substringAfterLast('/').lowercase()
        return row.harness && (id.endsWith("-free") || id == "big-pickle")
    }

    const val FREE_NOTE = "Free inside OpenCode for a limited time; providers may keep data."

    /** Every row of every maker, once; a plan's copy of a model with no tier of its own takes the catalog's by name. */
    fun entries(groups: List<ModelPicks.Group>): List<Entry> {
        val all = groups.flatMap { g -> g.rows.map { Entry(it, g.key, g.name) } }
        val tiers = all.mapNotNull { e -> e.row.model.tier?.let { e.row.label to it } }.toMap()
        return all.map { e ->
            val tier = tiers[e.row.label]
            if (e.row.model.tier == null && tier != null) e.copy(row = e.row.copy(model = e.row.model.copy(tier = tier))) else e
        }
    }

    /** All, and the tabs that have a model. */
    fun shownTabs(entries: List<Entry>): List<Tab> = Tab.entries.filter { t -> t == Tab.ALL || entries.any { it.tab == t } }

    /** The tab the picker opens on: the current model's, else All. */
    fun tabFor(entries: List<Entry>, ref: String?): Tab = entries.firstOrNull { it.row.ref == ref }?.tab ?: Tab.ALL

    private val TIER = mapOf("deep" to 0, "smart" to 1, "fast" to 2)

    private fun tier(r: ModelPicks.Row): Int = if (r.harness) 4 else r.model.tier?.let { TIER[it] } ?: 3

    /**
     * Most capable first: the catalog's tier (deep, smart, fast, none; coding
     * agents after), then the larger context window, then the higher output
     * price, then the newer model ([compareModels]).
     */
    val capability: Comparator<ModelPicks.Row> = Comparator<ModelPicks.Row> { a, b ->
        tier(a).compareTo(tier(b)).takeIf { it != 0 }
            ?: b.model.contextWindow.compareTo(a.model.contextWindow).takeIf { it != 0 }
            ?: b.model.outputPrice.compareTo(a.model.outputPrice).takeIf { it != 0 }
            ?: compareModels(a.model.id, b.model.id)
    }

    /** A model's family inside its maker, its power rank among the maker's families (0 the strongest), and its version (the web's familyOf). */
    data class Family(val name: String, val rank: Int, val version: List<Int>, val dated: Long)

    /** Anthropic's families, most powerful first. */
    private val CLAUDE_FAMILIES = listOf("mythos", "fable", "opus", "sonnet", "haiku")

    fun familyOf(id: String): Family {
        val m = id.lowercase().substringAfterLast('/')
        val date = Regex("-(\\d{8})$").find(m)
        val base = m.replace(Regex("-\\d{8}$"), "")
        val version = Regex("\\d+").findAll(base).mapNotNull { it.value.toIntOrNull() }.toList()
        val dated = date?.groupValues?.get(1)?.toLongOrNull() ?: 0L
        fun fam(name: String, rank: Int) = Family(name, rank, version, dated)
        CLAUDE_FAMILIES.forEachIndexed { i, f -> if (f in base) return fam(f.replaceFirstChar { it.uppercase() }, i) }
        return when {
            base.startsWith("claude") -> fam("Claude", CLAUDE_FAMILIES.size)
            // Codex before GPT: gpt-5.3-codex is a Codex model
            "codex" in base -> fam("Codex", 3)
            base.startsWith("gpt") -> if (Regex("-(mini|nano)\\b").containsMatchIn(base)) fam("GPT mini and nano", 1) else fam("GPT", 0)
            Regex("^o\\d").containsMatchIn(base) -> fam("o-series", 2)
            base.startsWith("gemini") -> when {
                "flash-lite" in base -> fam("Gemini Flash-Lite", 2)
                "flash" in base -> fam("Gemini Flash", 1)
                "pro" in base -> fam("Gemini Pro", 0)
                else -> fam("Gemini", 3)
            }
            base.startsWith("gemma") -> fam("Gemma", 4)
            base.startsWith("glm") -> when {
                Regex("-air\\b").containsMatchIn(base) -> fam("GLM Air", 1)
                Regex("-flash\\b").containsMatchIn(base) -> fam("GLM Flash", 2)
                else -> fam("GLM", 0)
            }
            else -> fam("", 9)
        }
    }

    /** Inside a maker: by family, newest version first, a plain id before its variants, undated before dated, newest date first. */
    fun compareModels(a: String, b: String): Int {
        val x = familyOf(a)
        val y = familyOf(b)
        if (x.rank != y.rank) return x.rank - y.rank
        if (x.name != y.name) return x.name.compareTo(y.name)
        for (i in 0 until maxOf(x.version.size, y.version.size)) {
            val d = (y.version.getOrNull(i) ?: -1) - (x.version.getOrNull(i) ?: -1)
            if (d != 0) return d
        }
        if ((x.dated != 0L) != (y.dated != 0L)) return if (x.dated != 0L) 1 else -1
        if (x.dated != y.dated) return y.dated.compareTo(x.dated)
        return (a.length - b.length).takeIf { it != 0 } ?: a.compareTo(b)
    }

    /** The last five distinct models the sessions used, newest first: Recent before the tab's three are picked. */
    fun recent(sessions: List<Session>): List<String> =
        sessions.sortedByDescending { it.updatedAt }.map { it.model }.filter { it.isNotBlank() }.distinct().take(5)

    /**
     * What the list shows under the search and the tabs: Pinned (the pins in
     * this tab, most capable first), Recent (the last three in this tab, pins
     * left out), then the tab's models by maker (in [entries]' order) and
     * family, strongest family first, newest first inside. A search lists the
     * matches of every tab, most capable first, with no Pinned or Recent.
     * [recent] holds refs the picker already mapped to their rows.
     */
    fun items(entries: List<Entry>, query: String, tab: Tab, pinned: List<String> = emptyList(), recent: List<String> = emptyList()): List<Item> {
        val q = query.trim().lowercase()
        val byRank = compareBy<Entry, ModelPicks.Row>(capability) { it.row }
        if (q.isNotEmpty()) {
            val found = entries.filter { e ->
                e.row.label.lowercase().contains(q) || e.row.model.name.lowercase().contains(q) || e.row.ref.lowercase().contains(q) || e.makerName.lowercase().contains(q)
            }.sortedWith(byRank)
            if (found.isEmpty()) return emptyList()
            return listOf<Item>(Item.Head("Matches for \"${query.trim()}\"")) + found.map { Item.Model(it, Section.LIST) }
        }
        val ranked = entries.filter { tab == Tab.ALL || it.tab == tab }.sortedWith(byRank)
        if (ranked.isEmpty()) return emptyList()
        val pins = ranked.filter { it.row.ref in pinned }
        val recents = recent.distinct().mapNotNull { ref -> ranked.firstOrNull { it.row.ref == ref } }.filter { it.row.ref !in pinned }.take(3)
        val out = mutableListOf<Item>()
        if (pins.isNotEmpty()) {
            out += Item.Head("Pinned")
            pins.forEach { out += Item.Model(it, Section.PIN) }
        }
        if (recents.isNotEmpty()) {
            out += Item.Head("Recent")
            recents.forEach { out += Item.Model(it, Section.RECENT) }
        }
        val makers = entries.map { it.makerKey }.distinct()
        val family = { e: Entry -> if (e.row.harness) Family("", 9, emptyList(), 0) else familyOf(e.row.model.id) }
        val byFamily = compareBy<Entry> { makers.indexOf(it.makerKey) }
            .thenBy { family(it).rank }
            .thenBy { family(it).name }
            .thenComparator { a, b -> compareModels(a.row.model.id, b.row.model.id) }
        var maker: String? = null
        var fam: String? = null
        for (e in ranked.sortedWith(byFamily)) {
            if (e.makerKey != maker) {
                maker = e.makerKey
                fam = null
                out += Item.Head(e.makerName, maker = maker.takeIf { !e.row.harness && it != ModelPicks.AGENTS })
            }
            val f = family(e).name
            // a model of no known family after the families goes under "Other"
            if (f != (fam ?: "") && (f.isNotEmpty() || !fam.isNullOrEmpty())) out += Item.Head(f.ifEmpty { "Other" }, family = true)
            fam = f
            out += Item.Model(e, Section.LIST)
        }
        return out
    }

    /** Pin or unpin [ref]: a new pin goes last, the oldest falls off past [PINS_MAX]. */
    fun togglePin(pins: List<String>, ref: String): List<String> =
        if (ref in pins) pins - ref else (pins + ref).takeLast(PINS_MAX)
}
