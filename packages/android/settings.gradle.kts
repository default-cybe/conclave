import java.util.Properties

pluginManagement {
    repositories {
        google {
            content {
                includeGroupByRegex("com\\.android.*")
                includeGroupByRegex("com\\.google.*")
                includeGroupByRegex("androidx.*")
            }
        }
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google {
            content {
                includeGroupByRegex("com\\.android.*")
                includeGroupByRegex("com\\.google.*")
                includeGroupByRegex("androidx.*")
            }
        }
        mavenCentral()
    }
}

rootProject.name = "conclave-android"

include(":client")

// :app needs the Android SDK. Include it only when an SDK is configured, so the
// pure Kotlin :client module still builds and tests anywhere.
// Force with -Pconclave.app=true or skip with -Pconclave.app=false.
fun androidSdkDir(): String? {
    System.getenv("ANDROID_HOME")?.takeIf { it.isNotBlank() }?.let { return it }
    System.getenv("ANDROID_SDK_ROOT")?.takeIf { it.isNotBlank() }?.let { return it }
    val local = file("local.properties")
    if (local.isFile) {
        val props = Properties()
        local.inputStream().use { props.load(it) }
        props.getProperty("sdk.dir")?.takeIf { it.isNotBlank() }?.let { return it }
    }
    return null
}

val appFlag = providers.gradleProperty("conclave.app").orNull
val includeApp = when (appFlag) {
    "true" -> true
    "false" -> false
    else -> androidSdkDir() != null
}
if (includeApp) {
    include(":app")
} else {
    logger.lifecycle("Conclave: no Android SDK found, building :client only")
}
