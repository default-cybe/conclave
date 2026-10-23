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

    /** One way to reach a row's model: its own ref first (the owner's first route), a plan's prefix, another provider, an effort variant. */
    data class Route(val ref: String, val label: String, val first: Boolean = false)

    data class Row(val ref: String, val model: ModelInfo, val label: String, val via: String?, val harness: Boolean, val routes: List<Route> = emptyList())

    data class Group(val key: String, val name: String, val rows: List<Row>)

    /** The maker a model sits under, from its id; the web's makerOf. Null keeps its provider. */
    private val MAKER: List<Pair<Regex, String>> = listOf(
        Regex("claude") to "anthropic",
        Regex("gpt|(^|/)o\\d|codex") to "openai",
        Regex("gemini|gemma") to "google",
        Regex("glm") to "zai",
        Regex("muse") to "meta",
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

    /** A model's maker: by its id, else the vendor of the plan that lists it (the hub's ModelInfo.vendor; gemini is Google's). */
    fun makerOf(m: ModelInfo): String? = makerOf(m.id) ?: m.vendor?.let { if (it == "gemini") "google" else it }

    /** Ids that are not chat models: image generators, review models (the web's NON_CHAT). */
    private val NON_CHAT = Regex("(^|/)(gpt-image|codex-auto-review|dall-e|whisper|tts-)|-image(-|$)|embedding", RegexOption.IGNORE_CASE)

    fun isChatModel(id: String): Boolean = !NON_CHAT.containsMatchIn(id)

    /** An effort or thinking variant of one model ("claude-opus-5-5-high", "claude-opus-4-6-thinking"). */
    private val VARIANT = Regex("-(minimal|low|medium|high|xhigh|thinking)$", RegexOption.IGNORE_CASE)

    private fun bare(id: String): String = id.substringAfterLast('/').lowercase()

    /** The words for a route: a plan's short name, "Main accounts" for the plans without one, else the provider. */
    fun routeLabel(ref: String): String {
        val provider = ref.substringBefore('/')
        val id = ref.substringAfter('/')
        val account = if ('/' in id) id.substringBeforeLast('/') else ""
        return if (provider == "cliproxy") account.ifBlank { "Main accounts" } else ModelRefs.providerName(provider)
    }

    /**
     * Effort and thinking variants fold under their model's row as routes ("High", "Thinking"),
     * not rows of their own. A variant whose model is not listed becomes the row, named as the model.
     */
    fun foldVariants(rows: List<Row>): List<Row> {
        val base = LinkedHashMap<String, Row>()
        for (r in rows) if (!r.harness && !VARIANT.containsMatchIn(bare(r.model.id))) base[bare(r.model.id)] = r
        val order = mutableListOf<String>()
        val out = LinkedHashMap<String, Row>()
        for (r in rows) {
            val id = bare(r.model.id)
            val m = VARIANT.find(id)
            if (r.harness || m == null) {
                // a variant listed before its model already put its route on it
                out[r.ref] = if (r.harness) r else base[id]?.takeIf { it.ref == r.ref } ?: r
                order += r.ref
                continue
            }
            val w = m.groupValues[1].lowercase()
            val word = if (w == "xhigh") "Extra high" else w.replaceFirstChar { it.uppercase() }
            val key = id.removeSuffix(m.value.lowercase())
            val host = base[key]
            if (host != null) {
                val now = out[host.ref] ?: host
                val routes = now.routes.ifEmpty { listOf(Route(now.ref, "Default", first = true)) } + Route(r.ref, word)
                val next = now.copy(routes = routes)
                out[host.ref] = next; base[key] = next
                continue
            }
            // only the variant is listed: it is the row, under the model's name
            val row = r.copy(label = r.label.replace(Regex("[\\s-]${m.groupValues[1]}$", RegexOption.IGNORE_CASE), ""), routes = listOf(Route(r.ref, word, first = true)))
            base[key] = row
            out[r.ref] = row; order += r.ref
        }
        return order.mapNotNull { out[it] }
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
    fun label(m: ModelInfo): String {
        val name = m.name.ifBlank { null }?.takeIf { !it.equals(m.id, ignoreCase = true) }?.let { ModelRefs.cleanName(it) } ?: ModelRefs.displayName(m.fullRef)
        // a plan's prefix is a route, not part of the name; a dated snapshot reads as its model ("Opus 4.5")
        val account = m.id.substringBeforeLast('/', "")
        val plain = if (account.isNotEmpty() && name.endsWith(", $account")) name.removeSuffix(", $account") else name
        return plain.replace(Regex("[\\s-]\\(?\\d{8}\\)?$"), "")
    }

    /** The makers and their models. */
    fun groups(all: List<ModelGroup>): List<Group> {
        val offered = all.filter { it.enabled && it.configured }.distinctBy { it.provider }.sortedBy { rank(it.provider) }
        val byMaker = LinkedHashMap<String, MutableList<Row>>()
        val agents = mutableListOf<Row>()
        for (g in offered) {
            val harness = ModelRefs.isHarness(g.provider)
            for (m in g.models) {
                // an image or review model is not a chat model
                if (m.sameAs != null || !isChatModel(m.id)) continue
                if (harness) {
                    agents += Row(m.fullRef, m, label(m), m.via, harness = true)
                    continue
                }
                val maker = makerOf(m) ?: g.provider
                // the row is the model's name; the route words are its detail, the other routes a choice behind it
                val via = m.via ?: if (maker != g.provider) ModelRefs.providerName(g.provider) else null
                val routes = m.choices.orEmpty().let { c -> if (c.isEmpty()) emptyList() else listOf(Route(m.fullRef, routeLabel(m.fullRef), first = true)) + c.map { Route(it, routeLabel(it)) } }
                byMaker.getOrPut(maker) { mutableListOf() } += Row(m.fullRef, m, label(m), via, harness = false, routes = routes)
            }
        }
        val makers = byMaker.entries.sortedBy { rank(it.key) }.map { (key, rows) -> Group(key, ModelRefs.providerName(key), foldVariants(rows.distinctBy { it.ref })) }
        return if (agents.isEmpty()) makers else makers + Group(AGENTS, "Coding agents", agents.distinctBy { it.ref })
    }

    /** The ref the picker checks for a stored one: the merged row it points at, else itself. */
    fun shown(all: List<ModelGroup>, ref: String?): String? {
        if (ref == null) return null
        return all.asSequence().flatMap { it.models.asSequence() }.firstOrNull { it.fullRef == ref }?.sameAs ?: ref
    }

    /** The ref the picker checks among rows: the row whose routes hold it (a variant, a plan's prefix), else [shown]. */
    fun shownRow(groups: List<Group>, all: List<ModelGroup>, ref: String?): String? {
        val s = shown(all, ref) ?: return null
        return groups.asSequence().flatMap { it.rows.asSequence() }.firstOrNull { r -> r.ref == s || r.routes.any { it.ref == ref } }?.ref ?: s
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
