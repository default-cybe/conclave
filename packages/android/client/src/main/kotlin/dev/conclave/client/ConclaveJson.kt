package dev.conclave.client

import dev.conclave.client.model.ContentBlock
import dev.conclave.client.model.EngineEvent
import dev.conclave.client.model.EventEnvelope
import dev.conclave.client.model.UnknownBlock
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.modules.SerializersModule
import kotlinx.serialization.modules.polymorphic

/** JSON settings shared by the REST client and the WebSocket. */
val ConclaveJson: Json = Json {
    ignoreUnknownKeys = true
    coerceInputValues = true
    explicitNulls = false
    encodeDefaults = true
    classDiscriminator = "type"
    serializersModule = SerializersModule {
        polymorphic(ContentBlock::class) {
            defaultDeserializer { UnknownBlock.serializer() }
        }
        polymorphic(EngineEvent::class) {
            defaultDeserializer { EngineEvent.Unknown.serializer() }
        }
    }
}

/** One text frame from /api/ws. */
sealed class Frame {
    /** First frame after connecting: the hub's current seq. */
    data class Hello(val seq: Long) : Frame()

    /** The hub could not replay from our seq. Refetch everything. */
    data class Resync(val seq: Long) : Frame()

    data object Pong : Frame()

    data class Event(val envelope: EventEnvelope) : Frame()

    data object Malformed : Frame()

    companion object {
        fun parse(text: String, json: Json = ConclaveJson): Frame {
            val obj = try {
                json.parseToJsonElement(text) as? JsonObject
            } catch (_: Exception) {
                null
            } ?: return Malformed
            val type = (obj["type"] as? JsonPrimitive)?.contentOrNull ?: return Malformed
            val seq = (obj["seq"] as? JsonPrimitive)?.longOrNull ?: 0L
            return when (type) {
                "hello" -> Hello(seq)
                "resync" -> Resync(seq)
                "pong" -> Pong
                else -> {
                    val ts = (obj["ts"] as? JsonPrimitive)?.longOrNull ?: 0L
                    val event = try {
                        json.decodeFromJsonElement(EngineEvent.serializer(), obj)
                    } catch (_: Exception) {
                        EngineEvent.Unknown()
                    }
                    Event(EventEnvelope(seq = seq, ts = ts, type = type, event = event))
                }
            }
        }
    }
}
