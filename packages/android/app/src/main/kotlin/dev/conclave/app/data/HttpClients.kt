package dev.conclave.app.data

import dev.conclave.client.logic.HubAddress
import dev.conclave.client.logic.NetworkKind
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.Response
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * App-level cleartext rule. The platform network security config allows
 * cleartext (it cannot be changed per host at runtime), so this interceptor
 * decides: plain http is fine to this device, a home or office network and
 * private VPN ranges (the hub's same network address is plain http), and to a
 * public host only when the user approved that exact host while pairing.
 */
class CleartextPolicy(@Volatile var allowedHosts: Set<String> = emptySet()) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val url = chain.request().url
        if (!allows(url.isHttps, url.host)) {
            throw IOException("Plain http to ${url.host} is blocked. Use the hub's https address, or pair again and allow it.")
        }
        return chain.proceed(chain.request())
    }

    fun allows(https: Boolean, host: String): Boolean {
        if (https) return true
        val h = host.lowercase()
        return HubAddress.classifyHost(h) != NetworkKind.PUBLIC || h in allowedHosts
    }
}

object HttpClients {
    fun create(policy: CleartextPolicy): OkHttpClient = OkHttpClient.Builder()
        .addInterceptor(policy)
        .addNetworkInterceptor(policy)
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .writeTimeout(60, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        .build()

    /** For "does the hub answer here?" checks: give up fast. */
    fun probe(base: OkHttpClient): OkHttpClient = base.newBuilder()
        .connectTimeout(3, TimeUnit.SECONDS)
        .readTimeout(3, TimeUnit.SECONDS)
        .callTimeout(4, TimeUnit.SECONDS)
        .retryOnConnectionFailure(false)
        .build()
}
