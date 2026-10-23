package dev.conclave.client

import dev.conclave.client.logic.Effort
import dev.conclave.client.model.ModelGroup
import dev.conclave.client.model.ThinkingLevel
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/** Effort levels from the hub's model list, as the composer sheet lists them (logic/Effort.kt). */
class EffortTest {
    private val groups = ConclaveJson.decodeFromString(
        kotlinx.serialization.builtins.ListSerializer(ModelGroup.serializer()),
        """
        [{"provider":"anthropic","models":[
          {"id":"claude-opus-5-5","ref":"anthropic/claude-opus-5-5","thinking":true,"effort":{"levels":["low","medium","high","xhigh","max"],"off":false,"default":"medium"}},
          {"id":"claude-opus-4-6","ref":"anthropic/claude-opus-4-6","thinking":true,"effort":{"levels":["low","medium","high","max"],"off":true,"default":"high"}},
          {"id":"claude-haiku-4-5","ref":"anthropic/claude-haiku-4-5","thinking":true}
        ]}]
        """,
    )
    private val opus55 = groups[0].models[0].effort!!
    private val opus46 = groups[0].models[1].effort!!

    @Test
    fun listsOnlyTheModelsLevels() {
        assertEquals(listOf(ThinkingLevel.LOW, ThinkingLevel.MEDIUM, ThinkingLevel.HIGH, ThinkingLevel.XHIGH, ThinkingLevel.MAX), Effort.choices(opus55))
        assertEquals(listOf(ThinkingLevel.OFF, ThinkingLevel.LOW, ThinkingLevel.MEDIUM, ThinkingLevel.HIGH, ThinkingLevel.MAX), Effort.choices(opus46))
        assertEquals(emptyList<ThinkingLevel>(), Effort.choices(groups[0].models[2].effort))
        assertEquals(ThinkingLevel.MEDIUM, Effort.defaultOf(opus55))
        assertEquals("Extra high", Effort.label(ThinkingLevel.XHIGH, opus55))
    }

    @Test
    fun aLevelTheModelLacksIsTheNearestOne() {
        assertEquals(ThinkingLevel.HIGH, Effort.clamp(ThinkingLevel.XHIGH, opus46))
        assertEquals(ThinkingLevel.LOW, Effort.clamp(ThinkingLevel.OFF, opus55))
        assertEquals(ThinkingLevel.MEDIUM, Effort.shown(null, opus55))
        assertEquals(ThinkingLevel.HIGH, Effort.shown(ThinkingLevel.XHIGH, opus46))
        assertNull(Effort.clamp(ThinkingLevel.HIGH, null))
    }
}
