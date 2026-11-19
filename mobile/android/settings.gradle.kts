// SIDM for Android.
//
//   core/  plain Kotlin (no Android): link rules, the multi-connection HTTP
//          engine, yt-dlp format and argument logic. Its tests run on any JVM.
//   app/   the Android app (Jetpack Compose) on top of core.
//
// SIDM_CORE_ONLY=1 configures core alone, for machines without the Android SDK.
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
    // Versions live here so a plugin is only fetched by the module that applies it.
    plugins {
        id("com.android.application") version "8.7.3"
        id("org.jetbrains.kotlin.android") version "2.0.21"
        id("org.jetbrains.kotlin.jvm") version "2.0.21"
        id("org.jetbrains.kotlin.plugin.compose") version "2.0.21"
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "sidm-android"
include(":core")
if (System.getenv("SIDM_CORE_ONLY") == null) {
    include(":app")
}
