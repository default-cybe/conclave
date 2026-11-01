package dev.conclave.client.logic

import dev.conclave.client.model.AppDto
import dev.conclave.client.model.Device
import dev.conclave.client.model.PairingInfo
import dev.conclave.client.motion.Roll

/*
 * Pair a device from the phone: Devices, Pair a device (the web's PairDialog
 * and PairingPanel). The code is the signed in person's, so what pairs with
 * it is theirs (docs/design/ACCOUNTS.md 4): a member who makes one here pairs
 * his own computer to his own account. A computer is spotted as the device
 * that came online after the code was made, an app as the one that is new
 * in the account's apps.
 */

/** What a code pairs, and its wire kind for POST /api/pairing. */
enum class PairKind(val wire: String, val label: String) {
    /** The Conclave app on a phone or a computer, or a browser. */
    APP("client", "App"),

    /** A computer's daemon, set up with the conclave command. */
    COMPUTER("device", "Command line"),
}

/** The app or computer that paired with the code. */
data class JustPaired(val id: String, val name: String)

/**
 * What was there when the code was made: the computers online then, and
 * every app (a phone pairs as a new app each time). [apps] null: the apps
 * could not be read, so a new one cannot be told apart.
 */
class PairWatch(val kind: PairKind, private val online: Set<String>, private val apps: Set<String>?) {

    /** The one that paired since, or null while none has. */
    fun paired(devices: List<Device>, apps: List<AppDto>): JustPaired? = when (kind) {
        PairKind.APP -> {
            val known = this.apps
            if (known == null) null else apps.firstOrNull { !it.revoked && it.id !in known }?.let { JustPaired(it.id, it.name.ifBlank { it.id }) }
        }
        PairKind.COMPUTER -> devices.firstOrNull { it.online && it.id !in online }?.let { JustPaired(it.id, it.name.ifBlank { it.id }) }
    }

    companion object {
        fun start(kind: PairKind, devices: List<Device>, apps: List<AppDto>?): PairWatch =
            PairWatch(kind, devices.filter { it.online }.map { it.id }.toSet(), apps?.map { it.id }?.toSet())
    }
}

object PairingWords {
    /** The Conclave installer for Linux and macOS (docs/INSTALL.md, section 5). */
    const val INSTALL = "curl -fsSL https://github.com/default-cybe/conclave/releases/latest/download/install.sh | sh"

    /** The line under the choice: what this kind is for. */
    fun help(kind: PairKind): String = when (kind) {
        PairKind.APP ->
            "For the Conclave app on a phone or a computer, or a browser. Type the code there, or scan it with the Conclave app. " +
                "It signs in as you. On a computer, the desktop app then offers Let the hub use this computer."
        PairKind.COMPUTER ->
            "For a computer without the desktop app: install the conclave command there, then pair it with this code. With the desktop app, use App instead."
    }

    fun waiting(kind: PairKind): String = when (kind) {
        PairKind.APP -> "Waiting for the app"
        PairKind.COMPUTER -> "Waiting for the computer"
    }

    fun expired(info: PairingInfo, now: Long): Boolean = info.expiresAt <= now

    /** "9:42": the time left, rounded up, so the last second reads 0:01. */
    fun clock(info: PairingInfo, now: Long): String = Roll.clockLeft(info.expiresAt - now)

    /** "Expires in 9:42", or "Expired." once it ran out. */
    fun timer(info: PairingInfo, now: Long): String = if (expired(info, now)) "Expired." else "Expires in ${clock(info, now)}"

    /**
     * What to run on the computer: install, pair with this code at the
     * address the code carries (the hub's best one), and start at login.
     * [fallbackUrl] is the address this app uses, for a hub that sent none.
     */
    fun commands(info: PairingInfo, fallbackUrl: String? = null): List<String> {
        val base = info.url.ifBlank { fallbackUrl.orEmpty() }.trim().trimEnd('/')
        return listOf(INSTALL, "conclave daemon pair $base ${info.code}", "conclave daemon install --start")
    }

    /** The line under "Paired <name>.": where it shows now. */
    fun pairedNote(kind: PairKind): String = when (kind) {
        PairKind.APP -> "It is signed in as you. Apps are not devices, so it does not show in this list."
        PairKind.COMPUTER -> "It is in the list now, online."
    }

    /** The apps with [app] put in, new or changed (app.updated). */
    fun withApp(apps: List<AppDto>, app: AppDto): List<AppDto> = apps.filterNot { it.id == app.id } + app
}
