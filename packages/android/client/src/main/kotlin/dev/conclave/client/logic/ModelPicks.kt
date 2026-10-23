package dev.conclave.client.logic

import dev.conclave.client.model.ModelGroup
import dev.conclave.client.model.ModelInfo

/**
 * The model picker in two levels, as on the web (components/pickers/
 * ModelPicker.tsx): one row per maker first (Anthropic, OpenAI, Google,
 * Z.ai, then the others, the coding agents last), a maker's models behind
 * its row, one flat list while searching. A model sits under its maker
 * whatever route reaches it: GLM through OpenRouter is under Z.ai, with the
 * route under its name. The picker offers the same models as before:
 * providers that are on and set up, each model once.
 */
object ModelPicks {
    /** The key of the coding agents' row. */
    const val AGENTS = "harness"

    data class Row(val ref: String, val model: ModelInfo, val label: String, val via: String?, val harness: Boolean)

    data class Group(val key: String, val name: String, val rows: List<Row>)

    /** The maker a model sits under, from its id; the web's makerOf. Null keeps its provider. */
    private val MAKER: List<Pair<Regex, String>> = listOf(
        Regex("claude") to "anthropic",
        Regex("gpt|(^|/)o\\d|codex") to "openai",
        Regex("gemini|gemma") to "google",
        Regex("glm") to "zai",
        Regex("deepseek") to "deepseek",
        Regex("kimi|moonshot") to "moonshot",
        Regex("qwen") to "qwen",
        Regex("mistral|codestral|devstral") to "mistral",
        Regex("grok") to "xai",
    )

    fun makerOf(id: String): String? {
        val s = id.lowercase()
        return MAKER.firstOrNull { it.first.containsMatchIn(s) }?.second
    }

    private val FIRST = listOf("anthropic", "openai", "google", "zai")

    /** How Settings lists providers (web lib/providers.ts), for the makers after the first four. */
    private val PROVIDERS = listOf("anthropic", "openai", "zai", "google", "openrouter", "deepseek", "moonshot", "ollama", "mistral", "groq", "xai", "lmstudio", "qwen")

    /** Place on the first level: Anthropic, OpenAI, Google, Z.ai, then the others, coding agents last. */
    fun rank(key: String): Int = when {
        key == AGENTS -> 10_000
        key in FIRST -> FIRST.indexOf(key)
        key in PROVIDERS -> FIRST.size + PROVIDERS.indexOf(key)
        else -> 1_000
    }

    /** A row's name: the hub's name without the maker's prefix ("Sonnet 5.5"), else one made from the ref. */
    fun label(m: ModelInfo): String = m.name.ifBlank { null }?.let { ModelRefs.cleanName(it) } ?: ModelRefs.displayName(m.fullRef)

    /** The makers and their models. */
    fun groups(all: List<ModelGroup>): List<Group> {
        val offered = all.filter { it.enabled && it.configured }.distinctBy { it.provider }.sortedBy { rank(it.provider) }
        val byMaker = LinkedHashMap<String, MutableList<Row>>()
        val agents = mutableListOf<Row>()
        for (g in offered) {
            val harness = ModelRefs.isHarness(g.provider)
            for (m in g.models) {
                if (m.sameAs != null) continue
                if (harness) {
                    agents += Row(m.fullRef, m, label(m), m.via, harness = true)
                    continue
                }
                val maker = makerOf(m.id) ?: g.provider
                // a model reached through another provider names that route, as a merged row does
                val via = m.via ?: if (maker != g.provider) ModelRefs.providerName(g.provider) else null
                byMaker.getOrPut(maker) { mutableListOf() } += Row(m.fullRef, m, label(m), via, harness = false)
            }
        }
        val makers = byMaker.entries.sortedBy { rank(it.key) }.map { (key, rows) -> Group(key, ModelRefs.providerName(key), rows.distinctBy { it.ref }) }
        return if (agents.isEmpty()) makers else makers + Group(AGENTS, "Coding agents", agents.distinctBy { it.ref })
    }

    /** The ref the picker checks for a stored one: the merged row it points at, else itself. */
    fun shown(all: List<ModelGroup>, ref: String?): String? {
        if (ref == null) return null
        return all.asSequence().flatMap { it.models.asSequence() }.firstOrNull { it.fullRef == ref }?.sameAs ?: ref
    }

    /** The maker that holds [ref]: where the picker opens. Null for no model, or one no maker offers. */
    fun groupOf(groups: List<Group>, ref: String?): String? {
        if (ref == null) return null
        return groups.firstOrNull { g -> g.rows.any { it.ref == ref } }?.key
    }

    /** What a maker's row says at the right: the current model's name when it is there, else how many models it has. */
    fun note(g: Group, current: String?): String = g.rows.firstOrNull { it.ref == current }?.label ?: g.rows.size.toString()

    /** A search: every model whose name or ref has [query] in it, from every maker, as one list. Blank: none. */
    fun search(groups: List<Group>, query: String): List<Row> {
        val q = query.trim().lowercase()
        if (q.isEmpty()) return emptyList()
        return groups.flatMap { it.rows }.filter { r ->
            r.label.lowercase().contains(q) || r.model.name.lowercase().contains(q) || r.ref.lowercase().contains(q)
        }
    }
}
