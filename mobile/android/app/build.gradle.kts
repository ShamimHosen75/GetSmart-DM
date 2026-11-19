import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

// The SIDM version is shared with the extension and the companion:
// scripts/bump.py writes it here (versionName) and bumps versionCode.
val sidmVersionName = "0.5.0"
val sidmVersionCode = 2

// Release signing: keystore path and passwords come from environment variables
// (GitHub Actions secrets) or mobile/android/keystore.properties (never committed).
val keystoreProps = Properties().apply {
    val f = rootProject.file("keystore.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}
// Trimmed: a password pasted into a GitHub secret often brings a newline along.
fun signingValue(env: String, prop: String): String? =
    (System.getenv(env)?.takeIf { it.isNotBlank() } ?: keystoreProps.getProperty(prop))?.trim()

android {
    namespace = "com.sidm.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.sidm.app"
        minSdk = 26
        targetSdk = 35
        versionCode = sidmVersionCode
        versionName = sidmVersionName
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        // The download website, e.g. "https://sidm.example". Empty: no app update check.
        // The SIDM website: update checks read <site>/version.json and fetch <site>/downloads/*.apk.
        val siteUrl = System.getenv("SIDM_SITE_URL")?.takeIf { it.isNotBlank() } ?: "https://sidm.online"
        buildConfigField("String", "SITE_URL", "\"$siteUrl\"")
        buildConfigField("String", "SOURCE_URL", "\"https://github.com/ShamimHosen75/GetSmart-DM\"")
    }

    // One APK per processor type keeps each download near 50 MB instead of 100 MB
    // (yt-dlp's Python and ffmpeg are native code). arm64-v8a fits nearly every phone
    // made since 2017; armeabi-v7a is for older 32-bit phones; x86_64 is for emulators.
    splits {
        abi {
            isEnable = true
            reset()
            include("arm64-v8a", "armeabi-v7a", "x86_64")
            isUniversalApk = false
        }
    }

    signingConfigs {
        create("release") {
            val store = signingValue("SIDM_KEYSTORE", "storeFile")
            if (store != null) {
                storeFile = file(store)
                storePassword = signingValue("SIDM_KEYSTORE_PASSWORD", "storePassword")
                keyAlias = signingValue("SIDM_KEY_ALIAS", "keyAlias") ?: "sidm"
                keyPassword = signingValue("SIDM_KEY_PASSWORD", "keyPassword")
            }
        }
    }

    buildTypes {
        debug {
            applicationIdSuffix = ".debug"
        }
        release {
            isMinifyEnabled = false
            if (signingValue("SIDM_KEYSTORE", "storeFile") != null) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    packaging {
        // yt-dlp's Python runtime is shipped as native libraries that must be unpacked on install.
        jniLibs { useLegacyPackaging = true }
        resources { excludes += setOf("META-INF/LICENSE*", "META-INF/NOTICE*", "META-INF/*.kotlin_module", "META-INF/DEPENDENCIES") }
    }

    lint {
        abortOnError = false
        checkReleaseBuilds = false
    }
}

dependencies {
    implementation(project(":core"))

    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    implementation(platform("androidx.compose:compose-bom:2024.12.01"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-core")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")

    // yt-dlp with its Python runtime, and ffmpeg, packed for Android (GPL-3.0).
    implementation("io.github.junkfood02.youtubedl-android:library:0.18.1")
    implementation("io.github.junkfood02.youtubedl-android:ffmpeg:0.18.1")

    testImplementation("junit:junit:4.13.2")

    // On-device tests (the emulator job in GitHub Actions).
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.test:runner:1.6.2")
    androidTestImplementation("androidx.test:rules:1.6.1")
    androidTestImplementation(platform("androidx.compose:compose-bom:2024.12.01"))
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")
    debugImplementation("androidx.compose.ui:ui-test-manifest")
}
