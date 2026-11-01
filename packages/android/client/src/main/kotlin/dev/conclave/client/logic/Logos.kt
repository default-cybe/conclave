package dev.conclave.client.logic

/**
 * Provider, model and harness identity: refs, display names and which mark to
 * show. Same rules as packages/web/src/lib/models.ts and
 * packages/web/src/components/logo/resolve.ts (spec 8.2).
 *
 * Three tiers:
 * - a session or run that goes through a CLI shows the harness mark
 * - a model shows its model family mark
 * - a plan, key, bill or provider account shows the company mark
 */
enum class LogoTier { HARNESS, MODEL, COMPANY }

/** Marks from @lobehub/icons-static-svg (MIT). The ids match the web registry. */
enum class LogoId(val id: String, val displayName: String, val tier: LogoTier) {
    // harnesses
    CLAUDE_CODE("claude-code", "Claude Code", LogoTier.HARNESS),
    CODEX("codex", "Codex", LogoTier.HARNESS),
    GEMINI_CLI("gemini-cli", "Gemini CLI", LogoTier.HARNESS),
    OPENCODE("opencode", "OpenCode", LogoTier.HARNESS),
    CURSOR("cursor", "Cursor", LogoTier.HARNESS),
    CLINE("cline", "Cline", LogoTier.HARNESS),
    OPENHANDS("openhands", "OpenHands", LogoTier.HARNESS),

    // model families
    CLAUDE("claude", "Claude", LogoTier.MODEL),
    GPT("gpt", "GPT", LogoTier.MODEL),
    GEMINI("gemini", "Gemini", LogoTier.MODEL),
    GLM("glm", "GLM", LogoTier.MODEL),
    DEEPSEEK("deepseek", "DeepSeek", LogoTier.MODEL),
    QWEN("qwen", "Qwen", LogoTier.MODEL),
    KIMI("kimi", "Kimi", LogoTier.MODEL),
    MISTRAL("mistral", "Mistral", LogoTier.MODEL),
    GROK("grok", "Grok", LogoTier.MODEL),
    LLAMA("llama", "Llama", LogoTier.MODEL),
    MINIMAX("minimax", "MiniMax", LogoTier.MODEL),

    // companies, plans and accounts
    ANTHROPIC("anthropic", "Anthropic", LogoTier.COMPANY),
    OPENAI("openai", "OpenAI", LogoTier.COMPANY),
    GOOGLE("google", "Google", LogoTier.COMPANY),
    ZAI("zai", "Z.ai", LogoTier.COMPANY),
    ZHIPU("zhipu", "Zhipu", LogoTier.COMPANY),
    MOONSHOT("moonshot", "Moonshot", LogoTier.COMPANY),
    OPENROUTER("openrouter", "OpenRouter", LogoTier.COMPANY),
    OLLAMA("ollama", "Ollama", LogoTier.COMPANY),
    LMSTUDIO("lmstudio", "LM Studio", LogoTier.COMPANY),
    GROQ("groq", "Groq", LogoTier.COMPANY),
    XAI("xai", "xAI", LogoTier.COMPANY),
    ;

    companion object {
        private val byId = entries.associateBy { it.id }

        fun of(id: String?): LogoId? = id?.let { byId[it] }
    }
}

/** Model refs ("provider/model"), harness refs ("claude-code/opus") and their display names. */
object ModelRefs {

    /** CLI coding agents Conclave can drive, with the names their makers use. */
    val HARNESSES: Map<String, String> = linkedMapOf(
        "claude-code" to "Claude Code",
        "codex" to "Codex",
        "gemini-cli" to "Gemini CLI",
        "opencode" to "OpenCode",
        "cursor" to "Cursor",
        "cline" to "Cline",
        "openhands" to "OpenHands",
    )

    /** How their makers write provider and plan names. */
    val PROVIDER_NAMES: Map<String, String> = linkedMapOf(
        "anthropic" to "Anthropic",
        "claude-max" to "Claude Max",
        "claude-pro" to "Claude Pro",
        "openai" to "OpenAI",
        "chatgpt" to "ChatGPT",
        "chatgpt-pro" to "ChatGPT Pro",
        "codex" to "Codex",
        "google" to "Google",
        "gemini" to "Gemini",
        "ai-studio" to "AI Studio",
        "zai" to "Z.ai",
        "zai-coding" to "Z.ai Coding",
        "zhipu" to "Zhipu",
        "openrouter" to "OpenRouter",
        "ollama" to "Ollama",
        "lmstudio" to "LM Studio",
        "deepseek" to "DeepSeek",
        "moonshot" to "Moonshot",
        "kimi" to "Kimi",
        "mistral" to "Mistral",
        "groq" to "Groq",
        "xai" to "xAI",
        "qwen" to "Qwen",
        "dashscope" to "Alibaba Cloud",
        "minimax" to "MiniMax",
        "meta" to "Meta",
        "cliproxy" to "CLIProxy",
    ) + HARNESSES

    /** Binary names a device reports (DeviceInfo.clis) for each harness. */
    private val CLI_HARNESS = mapOf(
        "claude" to "claude-code",
        "codex" to "codex",
        "gemini" to "gemini-cli",
        "opencode" to "opencode",
    )

    data class Ref(val provider: String, val model: String)

    /** "anthropic/claude-sonnet-5-5" to ("anthropic", "claude-sonnet-5-5"). A ref without a slash is a bare model. */
    fun split(ref: String?): Ref {
        if (ref.isNullOrEmpty()) return Ref("", "")
        val i = ref.indexOf('/')
        if (i < 0) return Ref("", ref)
        return Ref(ref.substring(0, i), ref.substring(i + 1))
    }

    /** "claude-code/opus" to "claude-code". Also accepts a bare harness id. */
    fun harnessId(ref: String?): String? {
        if (ref.isNullOrEmpty()) return null
        if (ref in HARNESSES) return ref
        val p = split(ref).provider
        return if (p in HARNESSES) p else null
    }

    fun isHarness(ref: String?): Boolean = harnessId(ref) != null

    /** "Claude Code" for any claude-code ref. */
    fun harnessLabel(ref: String?): String? = harnessId(ref)?.let { HARNESSES[it] }

    /** Harness id for a CLI binary name ("claude" to "claude-code"), or null for other tools. */
    fun cliHarness(cli: String?): String? = cli?.let { CLI_HARNESS[it.lowercase()] }

    fun providerName(id: String?): String {
        if (id.isNullOrEmpty()) return ""
        return PROVIDER_NAMES[id] ?: PROVIDER_NAMES[id.lowercase()] ?: titleCase(id)
    }

    /**
     * Display name for a model ref, the way its maker writes it in prose.
     * - "anthropic/claude-sonnet-5-5" to "Sonnet 5.5"
     * - "openrouter/deepseek/deepseek-v4" to "DeepSeek V4"
     * - "claude-code/opus" to "Opus"; "claude-code/default" to "Claude Code"
     */
    fun displayName(ref: String?): String {
        if (ref.isNullOrEmpty()) return ""
        val h = harnessId(ref)
        if (h != null) {
            val m = split(ref).model
            if (m.isEmpty() || m == "default" || m == h) return HARNESSES.getValue(h)
            return formatModelId(m)
        }
        return formatModelId(split(ref).model.ifEmpty { ref })
    }

    /** A hub model name without the redundant maker prefix ("Claude Sonnet 5.5" to "Sonnet 5.5"). */
    fun cleanName(name: String): String = name.replace(Regex("^Claude (?=(Opus|Sonnet|Haiku)\\b)"), "")

    private val WORDS = mapOf(
        "pro" to "Pro", "flash" to "Flash", "lite" to "Lite", "mini" to "mini", "nano" to "nano",
        "air" to "Air", "coder" to "Coder", "codex" to "Codex", "chat" to "Chat", "reasoner" to "Reasoner",
        "instruct" to "Instruct", "turbo" to "Turbo", "large" to "Large", "medium" to "Medium",
        "small" to "Small", "max" to "Max", "plus" to "Plus", "thinking" to "Thinking",
        "preview" to "Preview", "latest" to "latest", "exp" to "Exp", "vision" to "Vision",
    )

    private fun titleCase(s: String): String =
        s.split(Regex("[-_\\s]+"))
            .filter { it.isNotEmpty() }
            .joinToString(" ") { w ->
                WORDS[w.lowercase()] ?: if (w[0].isDigit()) w.uppercase() else w[0].uppercase() + w.substring(1)
            }

    private fun cap(s: String): String = s.replaceFirstChar { it.uppercaseChar() }

    private val CLAUDE_A = Regex("^(?:claude-)?(opus|sonnet|haiku)(?:-(\\d+)(?:[-.](\\d+))?)?(.*)$")
    private val CLAUDE_B = Regex("^claude-(\\d+)(?:[-.](\\d+))?-(opus|sonnet|haiku)(.*)$")
    private val GPT = Regex("^gpt-?([\\d.]+o?)(?:-(.*))?$")
    private val O_SERIES = Regex("^(o\\d)(?:-(.*))?$")
    private val CODEX = Regex("^codex(?:-(.*))?$")
    private val GEMINI = Regex("^gemini-([\\d.]+)(?:-(.*))?$")
    private val GLM = Regex("^glm-([\\d.]+v?)(?:-(.*))?$")
    private val DEEPSEEK = Regex("^deepseek-(.*)$")
    private val QWEN = Regex("^qwen([\\d.]*)[-:]?(.*)$")
    private val KIMI = Regex("^kimi-(.*)$")
    private val GROK = Regex("^grok-(.*)$")
    private val LLAMA = Regex("^llama-?([\\d.]+)(?:-(.*))?$")
    private val MINIMAX = Regex("^minimax-(.*)$")
    private val MISTRAL = Regex("^(mistral|codestral|devstral|magistral|ministral)(?:-(.*))?$")

    /** Format a raw model id the way its maker writes it: "claude-opus-5-5" to "Opus 5.5". */
    fun formatModelId(id: String): String {
        var m = id.lowercase()
        if ('/' in m) m = m.substring(m.lastIndexOf('/') + 1)
        m = m.replace(Regex("-\\d{8}$"), "").replace(Regex("@.*$"), "").replace(Regex("-latest$"), "")
        fun rest(s: String, sep: String = " ") = if (s.isNotEmpty()) sep + titleCase(s) else ""
        CLAUDE_A.matchEntire(m)?.groupValues?.let { r ->
            val v = if (r[2].isNotEmpty()) " " + r[2] + (if (r[3].isNotEmpty()) "." + r[3] else "") else ""
            return cap(r[1]) + v + rest(r[4])
        }
        CLAUDE_B.matchEntire(m)?.groupValues?.let { r ->
            return cap(r[3]) + " " + r[1] + (if (r[2].isNotEmpty()) "." + r[2] else "")
        }
        GPT.matchEntire(m)?.groupValues?.let { r -> return "GPT-" + r[1] + rest(r[2]) }
        O_SERIES.matchEntire(m)?.groupValues?.let { r -> return r[1] + (if (r[2].isNotEmpty()) "-" + r[2] else "") }
        CODEX.matchEntire(m)?.groupValues?.let { r -> return "Codex" + rest(r[1]) }
        GEMINI.matchEntire(m)?.groupValues?.let { r -> return "Gemini " + r[1] + rest(r[2]) }
        GLM.matchEntire(m)?.groupValues?.let { r -> return "GLM-" + r[1].uppercase() + rest(r[2]) }
        DEEPSEEK.matchEntire(m)?.groupValues?.let { r -> return "DeepSeek " + titleCase(r[1]) }
        QWEN.matchEntire(m)?.groupValues?.let { r -> return "Qwen" + r[1] + rest(r[2].replace(':', '-')) }
        KIMI.matchEntire(m)?.groupValues?.let { r -> return "Kimi " + titleCase(r[1]) }
        GROK.matchEntire(m)?.groupValues?.let { r -> return "Grok " + titleCase(r[1]) }
        LLAMA.matchEntire(m)?.groupValues?.let { r -> return "Llama " + r[1] + rest(r[2]) }
        MINIMAX.matchEntire(m)?.groupValues?.let { r -> return "MiniMax " + titleCase(r[1]) }
        MISTRAL.matchEntire(m)?.groupValues?.let { r -> return titleCase(r[1]) + rest(r[2]) }
        return titleCase(m.replace(':', '-'))
    }
}

/** Which mark to show for a harness, a model or a company. Null means: draw a monogram. */
object Logos {

    private val FAMILY: List<Pair<Regex, LogoId>> = listOf(
        Regex("claude|opus|sonnet|haiku") to LogoId.CLAUDE,
        Regex("gpt|(^|[^a-z])o\\d|codex|chatgpt") to LogoId.GPT,
        Regex("gemini|gemma") to LogoId.GEMINI,
        Regex("glm|chatglm") to LogoId.GLM,
        Regex("deepseek") to LogoId.DEEPSEEK,
        Regex("qwen|qwq") to LogoId.QWEN,
        Regex("kimi|moonshot") to LogoId.KIMI,
        Regex("mistral|codestral|devstral|magistral|ministral|mixtral") to LogoId.MISTRAL,
        Regex("grok") to LogoId.GROK,
        Regex("llama") to LogoId.LLAMA,
        Regex("minimax|abab") to LogoId.MINIMAX,
    )

    /** Harness defaults when the ref names no model ("codex/default" is GPT). */
    private val HARNESS_FAMILY = mapOf(
        "claude-code" to LogoId.CLAUDE,
        "codex" to LogoId.GPT,
        "gemini-cli" to LogoId.GEMINI,
    )

    private val COMPANY: List<Pair<Regex, LogoId>> = listOf(
        Regex("^(anthropic|claude)") to LogoId.ANTHROPIC,
        Regex("^(openai|chatgpt|codex)") to LogoId.OPENAI,
        Regex("^(google|gemini|ai-studio|vertex)") to LogoId.GOOGLE,
        Regex("^(zai|z\\.ai|glm)") to LogoId.ZAI,
        Regex("^(zhipu|bigmodel)") to LogoId.ZHIPU,
        Regex("^(moonshot|kimi)") to LogoId.MOONSHOT,
        Regex("^openrouter") to LogoId.OPENROUTER,
        Regex("^ollama") to LogoId.OLLAMA,
        Regex("^(lmstudio|lm-studio)") to LogoId.LMSTUDIO,
        Regex("^groq") to LogoId.GROQ,
        Regex("^(xai|x-ai|grok)") to LogoId.XAI,
        Regex("^deepseek") to LogoId.DEEPSEEK,
        Regex("^(mistral|codestral)") to LogoId.MISTRAL,
        Regex("^(qwen|dashscope|alibaba)") to LogoId.QWEN,
        Regex("^minimax") to LogoId.MINIMAX,
        Regex("^(meta|llama)") to LogoId.LLAMA,
    )

    /** "claude-code/opus" to CLAUDE_CODE. Null for refs that do not go through a CLI. */
    fun harness(ref: String?): LogoId? {
        val h = ModelRefs.harnessId(ref) ?: return null
        return LogoId.of(h)?.takeIf { it.tier == LogoTier.HARNESS }
    }

    /**
     * Model family mark, matched on the model id. OpenRouter refs use the routed
     * model. A harness ref with a known model ("claude-code/opus") returns the
     * family (CLAUDE).
     */
    fun model(ref: String?): LogoId? {
        if (ref.isNullOrEmpty()) return null
        val (provider, model) = ModelRefs.split(ref)
        val id = model.ifEmpty { ref }.lowercase()
        for ((re, logo) in FAMILY) if (re.containsMatchIn(id)) return logo
        val h = ModelRefs.harnessId(ref)
        if (h != null) return HARNESS_FAMILY[h]
        return company(provider.ifEmpty { ref })
    }

    /**
     * Company mark for a provider id, plan or limit id:
     * "claude-max" to ANTHROPIC, "codex" to OPENAI, "zai-coding" to ZAI.
     * Null for unknown providers (cliproxy, custom endpoints).
     */
    fun company(providerOrLimitId: String?): LogoId? {
        if (providerOrLimitId.isNullOrEmpty()) return null
        val p = providerOrLimitId.lowercase()
        if (p == "gemini-cli") return LogoId.GOOGLE
        if (p == "claude-code") return LogoId.ANTHROPIC
        for ((re, logo) in COMPANY) if (re.containsMatchIn(p)) return logo
        return null
    }

    /**
     * One or two letters for the monogram fallback (spec 8.5): the first letters
     * of the first two words, or the start of a single word.
     */
    fun monogram(name: String, letters: Int = 1): String {
        val words = name.replace(Regex("[^\\p{L}\\p{N}\\s.-]"), "")
            .split(Regex("[\\s.-]+"))
            .filter { it.isNotEmpty() }
        val text = if (words.size > 1) "${words[0][0]}${words[1][0]}" else (words.firstOrNull() ?: "?").take(letters.coerceIn(1, 2))
        return text.uppercase()
    }
}
