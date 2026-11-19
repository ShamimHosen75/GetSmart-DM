package com.sidm.app

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.util.Log
import androidx.core.content.FileProvider
import com.sidm.core.HttpEngine
import com.sidm.core.Outcome
import com.sidm.core.SpeedLimiter
import com.sidm.core.Versions
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * Two kinds of updates:
 * - the video engine (yt-dlp): daily, by itself, no reinstall;
 * - the app: the website's version.json says a newer SIDM exists; the user
 *   downloads the new APK and Android asks them to confirm the update.
 */
class Updates(private val context: Context, private val settings: SettingsRepo, private val video: VideoTools) {

    sealed class AppState {
        data object Idle : AppState()
        data object Checking : AppState()
        data object UpToDate : AppState()
        data object NoSite : AppState()
        data class Available(val version: String) : AppState()
        data class Downloading(val percent: Int) : AppState()
        data object NeedsPermission : AppState()
        data class Failed(val message: String) : AppState()
    }

    private val _app = MutableStateFlow<AppState>(
        settings.value.latestAppVersion?.takeIf { Versions.compare(it, BuildConfig.VERSION_NAME) > 0 }
            ?.let { AppState.Available(it) } ?: AppState.Idle
    )
    val app: StateFlow<AppState> = _app

    val siteUrl: String get() = BuildConfig.SITE_URL.trimEnd('/')

    // ---------- Video engine ----------

    suspend fun dailyEngineUpdate() {
        val s = settings.value
        if (!s.autoUpdateEngine || System.currentTimeMillis() - s.lastEngineUpdateCheck < DAY) return
        if (!video.awaitReady()) return
        // Only a finished check counts, so an offline start tries again next time.
        runCatching { video.update() }
            .onSuccess { settings.update { it.copy(lastEngineUpdateCheck = System.currentTimeMillis()) } }
            .onFailure { Log.w(TAG, "engine update failed", it) }
    }

    /** Settings' "Update now": returns the new version, "" if already up to date. Throws on failure. */
    suspend fun updateEngineNow(): String {
        if (!video.awaitReady()) throw IllegalStateException("engine not ready")
        val v = video.update(waitMs = 0)
        settings.update { it.copy(lastEngineUpdateCheck = System.currentTimeMillis()) }
        return v ?: ""
    }

    // ---------- App ----------

    suspend fun dailyAppCheck() {
        if (System.currentTimeMillis() - settings.value.lastAppUpdateCheck < DAY) return
        checkApp()
    }

    fun checkApp() {
        if (siteUrl.isEmpty()) {
            _app.value = AppState.NoSite
            return
        }
        _app.value = AppState.Checking
        try {
            val conn = URL("$siteUrl/version.json").openConnection() as HttpURLConnection
            conn.connectTimeout = 15000
            conn.readTimeout = 15000
            conn.useCaches = false
            val text = conn.inputStream.bufferedReader().use { it.readText() }
            conn.disconnect()
            val latest = Versions.fromVersionJson(text)
            settings.update { it.copy(lastAppUpdateCheck = System.currentTimeMillis(), latestAppVersion = latest) }
            _app.value = if (latest != null && Versions.compare(latest, BuildConfig.VERSION_NAME) > 0) AppState.Available(latest) else AppState.UpToDate
        } catch (e: Exception) {
            _app.value = AppState.Failed(e.message ?: "network")
        }
    }

    /** The APK for this phone's processor, named the way scripts/release.py names it. */
    private fun apkUrl(version: String): String {
        val abi = Build.SUPPORTED_ABIS.firstOrNull() ?: "arm64-v8a"
        val suffix = if (abi == "armeabi-v7a") "android-32bit" else "android"
        return "$siteUrl/downloads/sidm-v$version-$suffix.apk"
    }

    /** Downloads the new APK and opens Android's installer. */
    fun downloadAndInstall(version: String) {
        if (Build.VERSION.SDK_INT >= 26 && !context.packageManager.canRequestPackageInstalls()) {
            _app.value = AppState.NeedsPermission
            val intent = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}"))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            runCatching { context.startActivity(intent) }
            return
        }
        val file = File(context.cacheDir, "update/sidm-$version.apk").apply { parentFile?.mkdirs(); delete() }
        val http = HttpEngine(SpeedLimiter(), "SIDM/${BuildConfig.VERSION_NAME}")
        val url = apkUrl(version)
        _app.value = AppState.Downloading(0)
        val outcome = try {
            val probe = http.probe(url)
            http.download(probe.finalUrl, emptyMap(), file, probe.size, probe.acceptsRanges, 4, mutableListOf(), object : HttpEngine.Listener {
                override fun onProgress(done: Long, total: Long) {
                    _app.value = AppState.Downloading(if (total > 0) (done * 100 / total).toInt() else 0)
                }
                override fun shouldStop() = false
            })
        } catch (e: Exception) {
            Outcome.Failed(e.message ?: "network")
        }
        if (outcome !is Outcome.Finished) {
            _app.value = AppState.Failed((outcome as? Outcome.Failed)?.message ?: "")
            return
        }
        _app.value = AppState.Available(version)
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.files", file)
        val install = Intent(Intent.ACTION_VIEW)
            .setDataAndType(uri, "application/vnd.android.package-archive")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(install)
    }

    companion object {
        private const val TAG = "SIDM.updates"
        private const val DAY = 24L * 60 * 60 * 1000
    }
}
