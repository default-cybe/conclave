package dev.conclave.client

import dev.conclave.client.logic.Launch
import dev.conclave.client.logic.LaunchForm
import dev.conclave.client.model.WorkflowArgField
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull

/** The Android launch form: a preset fills it whole, and the args come back out unchanged. */
class LaunchArgsTest {
    private val schema = mapOf(
        "question" to WorkflowArgField("string"),
        "votes" to WorkflowArgField("number"),
        "fast" to WorkflowArgField("boolean"),
    )

    @Test
    fun aPresetReplacesTheWholeForm() {
        val a = Launch.formOf(schema, Json.parseToJsonElement("""{"question":"a","fast":true,"maxVerify":5}"""))
        assertEquals(LaunchForm(mapOf("question" to "a"), mapOf("fast" to true), """{"maxVerify":5}"""), a)
        // picking B after A keeps nothing of A
        assertEquals(LaunchForm(mapOf("votes" to "3")), Launch.formOf(schema, Json.parseToJsonElement("""{"votes":3}""")))
        assertEquals(LaunchForm(), Launch.formOf(schema, null))
        assertEquals(LaunchForm(), Launch.formOf(schema, JsonNull))
    }

    @Test
    fun stringsRoundTripUnescaped() {
        val tricky = "say \"hi\"\\n\nline two\""
        val args = JsonObject(mapOf("question" to JsonPrimitive(tricky), "fast" to JsonPrimitive(false)))
        val form = Launch.formOf(schema, args)
        assertEquals(tricky, form.texts["question"])
        assertEquals(args, Launch.argsOf(schema, form).args)
    }

    @Test
    fun argsComeBackTypedWithExtras() {
        val r = Launch.argsOf(schema, LaunchForm(mapOf("question" to " q ", "votes" to "3"), raw = """{"maxVerify":5,"question":"x"}"""))
        assertNull(r.error)
        val o = r.args!!.jsonObject
        assertEquals(JsonPrimitive("q"), o["question"])
        assertEquals(3.0, (o["votes"] as JsonPrimitive).content.toDouble())
        assertEquals(JsonPrimitive(false), o["fast"])
        assertEquals(JsonPrimitive(5), o["maxVerify"])
        assertNotNull(Launch.argsOf(schema, LaunchForm(mapOf("votes" to "many"))).error)
        assertNotNull(Launch.argsOf(schema, LaunchForm(mapOf("votes" to "NaN"))).error)
        assertNotNull(Launch.argsOf(schema, LaunchForm(raw = "[1]")).error)
        // no schema: the box is the args, empty is none
        assertNull(Launch.argsOf(null, LaunchForm()).args)
        assertNotNull(Launch.argsOf(null, LaunchForm(raw = "{bad")).error)
        assertEquals(Json.parseToJsonElement("""{"q":1}"""), Launch.argsOf(null, LaunchForm(raw = """{"q":1}""")).args)
    }
}
