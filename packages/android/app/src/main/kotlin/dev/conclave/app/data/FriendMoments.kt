package dev.conclave.app.data

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update

/**
 * The knot moments of the friends screens (docs/design/KNOT-MOTION.md 5),
 * for the whole app: a friend just added ties the knot by their name, and
 * a share that arrives while you watch ties the rope in on its card. Each
 * plays once.
 */
object FriendMoments {
    val friends = MutableStateFlow<Set<String>>(emptySet())
    val shares = MutableStateFlow<Set<String>>(emptySet())

    fun friendAdded(id: String) = friends.update { it + id }
    fun shareArrived(id: String) = shares.update { it + id }
    fun playedFriend(id: String) = friends.update { it - id }
    fun playedShare(id: String) = shares.update { it - id }
}
