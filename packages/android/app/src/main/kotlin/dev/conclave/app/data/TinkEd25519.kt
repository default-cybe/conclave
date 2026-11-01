package dev.conclave.app.data

import com.google.crypto.tink.subtle.Ed25519Verify
import dev.conclave.client.Ed25519Verifier
import java.security.GeneralSecurityException

/**
 * Checks the hub's identity signatures with Tink, which the app already has
 * for the token. java.security has no Ed25519 on Android before 14, so the
 * client's default would not work on most phones.
 */
object TinkEd25519 : Ed25519Verifier {
    override fun verify(publicKey: ByteArray, message: ByteArray, signature: ByteArray): Boolean {
        if (publicKey.size != 32 || signature.size != 64) return false
        return try {
            Ed25519Verify(publicKey).verify(signature, message)
            true
        } catch (_: GeneralSecurityException) {
            false
        }
    }
}
