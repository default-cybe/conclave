package dev.conclave.client

import dev.conclave.client.model.Proposal
import dev.conclave.client.model.Today
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

// Home's Today and the proposals the owner approves (docs/DESIGN.md, Calendar
// and mail), the same calls as today, answerToday, proposals,
// approveProposal and declineProposal in packages/core/src/client/index.ts.

/** The day plan, today's events and the proposals waiting. */
suspend fun ConclaveClient.today(): Today = get(p("api", "assistant", "today"), Today.serializer())

/** Tap an option of the plan's question. */
suspend fun ConclaveClient.answerToday(option: String) =
    sendUnit("POST", p("api", "assistant", "today", "answer"), buildJsonObject { put("option", option) })

/** Proposals by status: pending (default), applied, declined, failed or all. */
suspend fun ConclaveClient.proposals(status: String = "pending"): List<Proposal> =
    get(p("api", "proposals"), ListSerializer(Proposal.serializer()), mapOf("status" to status))

/** Approve: the hub writes the event or the message, once. A second tap returns the same result. */
suspend fun ConclaveClient.approveProposal(id: String): Proposal = sendJson("POST", p("api", "proposals", id, "approve"), null, Proposal.serializer())

/** Decline, with an optional note the assistant gets. */
suspend fun ConclaveClient.declineProposal(id: String, note: String? = null): Proposal =
    sendJson("POST", p("api", "proposals", id, "decline"), buildJsonObject { if (note != null) put("note", note) }, Proposal.serializer())
