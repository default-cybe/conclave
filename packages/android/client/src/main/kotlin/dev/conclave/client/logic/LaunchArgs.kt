package dev.conclave.client.logic

import dev.conclave.client.model.WorkflowArgField
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull

/**
 * The workflow launch form's values (the same rules as packages/web/src/features/workflows/args-form.tsx):
 * typed fields from the workflow's argsSchema, and [raw], the JSON box. With no schema the box holds
 * all the args; with one it holds the extras the schema does not name.
 */
data class LaunchForm(
    val texts: Map<String, String> = emptyMap(),
    val bools: Map<String, Boolean> = emptyMap(),
    val raw: String = "",
)

/** The args to start or save with ([args] null: none), or [error] when a field or the box is bad. */
data class LaunchArgs(val args: JsonElement? = null, val error: String? = null)

object Launch {
    /** The whole form a preset fills: nothing from an earlier pick is kept. */
    fun formOf(schema: Map<String, WorkflowArgField>?, args: JsonElement?): LaunchForm {
        if (args == null || args is JsonNull) return LaunchForm()
        if (schema == null || args !is JsonObject) return LaunchForm(raw = args.toString())
        val texts = mutableMapOf<String, String>()
        val bools = mutableMapOf<String, Boolean>()
        val extra = mutableMapOf<String, JsonElement>()
        for ((k, v) in args) {
            val field = schema[k]
            when {
                field == null -> extra[k] = v
                field.type == "boolean" -> bools[k] = (v as? JsonPrimitive)?.booleanOrNull ?: false
                v !is JsonNull -> texts[k] = (v as? JsonPrimitive)?.content ?: v.toString()
            }
        }
        return LaunchForm(texts, bools, if (extra.isEmpty()) "" else JsonObject(extra).toString())
    }

    fun argsOf(schema: Map<String, WorkflowArgField>?, form: LaunchForm): LaunchArgs {
        if (schema == null) {
            if (form.raw.isBlank()) return LaunchArgs()
            return try {
                LaunchArgs(Json.parseToJsonElement(form.raw))
            } catch (_: Exception) {
                LaunchArgs(error = "Args must be JSON, like {\"question\": \"...\"}")
            }
        }
        val extras = if (form.raw.isBlank()) {
            JsonObject(emptyMap())
        } else {
            try {
                Json.parseToJsonElement(form.raw) as? JsonObject
            } catch (_: Exception) {
                null
            } ?: return LaunchArgs(error = "More args (JSON) must be a JSON object")
        }
        val typed = mutableMapOf<String, JsonElement>()
        for ((name, field) in schema) {
            if (field.type == "boolean") {
                // always sent, false included: absent and false must not collapse
                typed[name] = JsonPrimitive(form.bools[name] == true)
                continue
            }
            val v = form.texts[name].orEmpty().trim()
            if (v.isEmpty()) continue
            if (field.type == "number") {
                val n = v.toDoubleOrNull()?.takeIf { it.isFinite() } ?: return LaunchArgs(error = "$name must be a number")
                typed[name] = JsonPrimitive(n)
            } else {
                typed[name] = JsonPrimitive(v)
            }
        }
        // declared fields win over an extra of the same name, as on web
        return LaunchArgs(JsonObject(extras + typed))
    }
}
