plugins {
    // AGP is on the root buildscript classpath (see ../build.gradle.kts).
    id("com.android.application")
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

// Release signing comes from the environment (CI secrets). Without it the
// release build is left unsigned.
val keystorePath: String? = System.getenv("ANDROID_KEYSTORE_PATH")?.takeIf { it.isNotBlank() }
val hasReleaseKeystore = keystorePath != null && file(keystorePath).isFile

val appVersionName: String = System.getenv("CONCLAVE_VERSION_NAME")?.takeIf { it.isNotBlank() } ?: "0.1.0"
val appVersionCode: Int = System.getenv("CONCLAVE_VERSION_CODE")?.toIntOrNull() ?: 1

// The update key (docs/DESIGN.md, Updates): the last line of packages/core/src/update/update-key.pub
// that is not a comment, the one file every Conclave updater reads. While it is the placeholder the
// app installs no updates (client update/Minisign.kt). One base64 line, so it is safe in a Java string.
val updateKeyLine: String = rootProject.file("../core/src/update/update-key.pub")
    .takeIf { it.isFile }
    ?.readLines()
    ?.map { it.trim() }
    ?.lastOrNull { it.isNotEmpty() && !it.startsWith("#") }
    ?.filter { it.isLetterOrDigit() || it == '+' || it == '/' || it == '=' }
    ?: "PLACEHOLDER"

android {
    namespace = "dev.conclave.app"
    compileSdk = 37

    defaultConfig {
        applicationId = "dev.conclave.app"
        minSdk = 26
        targetSdk = 37
        versionCode = appVersionCode
        versionName = appVersionName
        buildConfigField("String", "UPDATE_KEY", "\"$updateKeyLine\"")
    }

    signingConfigs {
        if (hasReleaseKeystore) {
            create("release") {
                storeFile = file(keystorePath!!)
                storePassword = System.getenv("ANDROID_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("ANDROID_KEY_ALIAS")
                keyPassword = System.getenv("ANDROID_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        getByName("debug") {
            // Same application id as release so a CI debug APK can be used as the daily app.
            versionNameSuffix = "-debug"
        }
        getByName("release") {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            if (hasReleaseKeystore) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    packaging {
        resources {
            excludes += setOf(
                "/META-INF/{AL2.0,LGPL2.1}",
                "/META-INF/LICENSE*",
                "/META-INF/NOTICE*",
                "/META-INF/versions/9/OSGI-INF/MANIFEST.MF",
            )
        }
    }

    lint {
        abortOnError = false
        checkReleaseBuilds = false
    }
}

dependencies {
    implementation(project(":client"))

    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.kotlinx.serialization.json)

    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.fragment.ktx)
    // Only for the window theme: BiometricPrompt's fingerprint dialog (API 26-27) needs an AppCompat theme.
    implementation(libs.androidx.appcompat)
    implementation(libs.androidx.navigation.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.datastore.preferences)
    implementation(libs.androidx.biometric)
    implementation(libs.androidx.work.runtime.ktx)

    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.ui.graphics)
    implementation(libs.compose.ui.tooling.preview)
    implementation(libs.compose.foundation)
    implementation(libs.compose.material3)
    implementation(libs.compose.material.icons.extended)
    debugImplementation(libs.compose.ui.tooling)

    implementation(libs.androidx.camera.core)
    implementation(libs.androidx.camera.camera2)
    implementation(libs.androidx.camera.lifecycle)
    implementation(libs.androidx.camera.view)
    // Bundled model: works without Google Play services.
    implementation(libs.mlkit.barcode.scanning)

    implementation(libs.tink.android)
    implementation(libs.markdown.m3)
    implementation(libs.markdown.code)
}
