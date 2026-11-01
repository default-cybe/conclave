package dev.conclave.client.logic

import dev.conclave.client.model.UsageBucket
import kotlin.math.max

/**
 * What plan use is worth at API prices (web features/usage/value.ts). A
 * signed in plan bills $0 per call; the hub keeps what the same tokens cost
 * at the model's API prices beside it. For an API key the two are the same.
 */
object ApiValue {
    /** What the tokens are worth at API prices: never less than what was billed; the bill from a hub that does not say. */
    fun worth(billed: Double, value: Double?): Double = max(billed, value ?: billed)

    /** What a plan saved on these calls. */
    fun saved(billed: Double, value: Double?): Double = max(0.0, worth(billed, value) - billed)

    /** A plan served some of these calls: worth more than they billed, by half a cent or more. */
    fun planServed(billed: Double, value: Double?): Boolean = saved(billed, value) >= 0.005

    fun planServed(b: UsageBucket): Boolean = planServed(b.costUsd, b.apiValueUsd)

    /** "Billed $0, worth $41.20 at API prices", or "Billed $12.50" for a key. */
    fun billedLine(billed: Double, value: Double?): String =
        "Billed ${Format.usd(billed)}" + if (planServed(billed, value)) ", worth ${Format.usd(worth(billed, value))} at API prices" else ""

    /** "worth $1.20 at API prices" beside a bill a plan paid; null otherwise. */
    fun worthLine(billed: Double, value: Double?): String? =
        if (planServed(billed, value)) "worth ${Format.usd(worth(billed, value))} at API prices" else null

    /** "Your plans saved you about $212 this month", or null when they saved under a cent. */
    fun savedSentence(totals: UsageBucket?): String? {
        if (totals == null || !planServed(totals)) return null
        return "Your plans saved you about ${Format.usd(saved(totals.costUsd, totals.apiValueUsd))} this month"
    }

    /** The line under it: what the calls were worth and what was billed, and whether older calls are estimates. */
    fun savedDetail(totals: UsageBucket): String {
        val est = if ((totals.estimatedUsd ?: 0.0) >= 0.005) " Calls from before the hub kept this are priced from today's list prices." else ""
        return "Worth ${Format.usd(worth(totals.costUsd, totals.apiValueUsd))} at API prices, billed ${Format.usd(totals.costUsd)}.$est"
    }
}
