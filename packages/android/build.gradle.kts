buildscript {
    // AGP comes from Google Maven. Resolve it only when :app is in the build
    // (see settings.gradle.kts) so :client works without an Android SDK.
    if (findProject(":app") != null) {
        repositories {
            google()
            mavenCentral()
        }
        dependencies {
            classpath("com.android.tools.build:gradle:${libs.versions.agp.get()}")
        }
    }
}

plugins {
    alias(libs.plugins.kotlin.jvm) apply false
    alias(libs.plugins.kotlin.compose) apply false
    alias(libs.plugins.kotlin.serialization) apply false
}
