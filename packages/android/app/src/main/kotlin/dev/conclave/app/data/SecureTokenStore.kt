package dev.conclave.app.data

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.google.crypto.tink.Aead
import com.google.crypto.tink.KeyTemplates
import com.google.crypto.tink.RegistryConfiguration
import com.google.crypto.tink.aead.AeadConfig
import com.google.crypto.tink.integration.android.AndroidKeysetManager
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withContext
import java.util.Base64

private val Context.secureDataStore: DataStore<Preferences> by preferencesDataStore(name = "secure")

/**
 * Stores the hub token encrypted with a Tink AEAD (AES256-GCM). The Tink
 * keyset is itself encrypted by a non-exportable Android Keystore master key.
 * The file is excluded from backups (see res/xml/data_extraction_rules.xml).
 *
 * The hub's public key (PairResponse.identity) is kept next to the token, the
 * same way: every connection checks the hub still holds it before the token
 * goes out (HUB-LOGIN-AND-IDENTITY.md section 2).
 */
class SecureTokenStore(context: Context) {
    private val appContext = context.applicationContext
    private val store = appContext.secureDataStore

    private val aead: Aead by lazy {
        AeadConfig.register()
        AndroidKeysetManager.Builder()
            .withSharedPref(appContext, KEYSET_NAME, KEYSET_PREFS)
            .withKeyTemplate(KeyTemplates.get("AES256_GCM"))
            .withMasterKeyUri(MASTER_KEY_URI)
            .build()
            .keysetHandle
            .getPrimitive(RegistryConfiguration.get(), Aead::class.java)
    }

    /** A new pairing: the token and the hub's key (null from a hub older than identity). */
    suspend fun save(token: String, hubKey: String?) = withContext(Dispatchers.IO) {
        val encoded = seal(token, ASSOCIATED_DATA)
        val key = hubKey?.let { seal(it, KEY_ASSOCIATED_DATA) }
        store.edit {
            it[TOKEN] = encoded
            if (key != null) it[HUB_KEY] = key else it.remove(HUB_KEY)
        }
    }

    /** The key a hub paired before identity proved on its first check (trust on first use). */
    suspend fun saveHubKey(hubKey: String) = withContext(Dispatchers.IO) {
        val key = seal(hubKey, KEY_ASSOCIATED_DATA)
        store.edit { it[HUB_KEY] = key }
    }

    /** Null when there is no token or it can no longer be decrypted (e.g. keystore reset). */
    suspend fun load(): String? = withContext(Dispatchers.IO) {
        val encoded = store.data.first()[TOKEN] ?: return@withContext null
        open(encoded, ASSOCIATED_DATA)
    }

    /** The hub's pinned public key, or null for a pairing from before identity. */
    suspend fun loadHubKey(): String? = withContext(Dispatchers.IO) {
        val encoded = store.data.first()[HUB_KEY] ?: return@withContext null
        open(encoded, KEY_ASSOCIATED_DATA)
    }

    suspend fun clear() = withContext(Dispatchers.IO) {
        store.edit {
            it.remove(TOKEN)
            it.remove(HUB_KEY)
        }
    }

    private fun seal(plain: String, associated: ByteArray): String =
        Base64.getEncoder().encodeToString(aead.encrypt(plain.toByteArray(Charsets.UTF_8), associated))

    private fun open(encoded: String, associated: ByteArray): String? = try {
        String(aead.decrypt(Base64.getDecoder().decode(encoded), associated), Charsets.UTF_8)
    } catch (_: Exception) {
        null
    }

    private companion object {
        val TOKEN = stringPreferencesKey("hub_token")
        val HUB_KEY = stringPreferencesKey("hub_key")
        const val KEYSET_NAME = "conclave_token_keyset"
        const val KEYSET_PREFS = "conclave_keyset_prefs"
        const val MASTER_KEY_URI = "android-keystore://conclave_master_key"
        val ASSOCIATED_DATA = "conclave.hub.token".toByteArray(Charsets.UTF_8)
        val KEY_ASSOCIATED_DATA = "conclave.hub.key".toByteArray(Charsets.UTF_8)
    }
}
