package com.sidm.app

import android.content.Context
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import java.util.Locale

data class AppSettings(
    /** "en" or "bn". */
    val language: String,
    /** "system", "light" or "dark". */
    val theme: String,
    val wifiOnly: Boolean,
    val connections: Int,
    val parallel: Int,
    /** Bytes per second, 0 = no limit. */
    val speedLimit: Long,
    val alwaysBest: Boolean,
    /** On by default; the welcome screen shows the responsibility notice. */
    val allowYouTube: Boolean,
    val autoUpdateEngine: Boolean,
    val welcomeDone: Boolean,
    val lastEngineUpdateCheck: Long,
    val lastAppUpdateCheck: Long,
    val latestAppVersion: String?,
)

/** Settings stored in SharedPreferences, published as a StateFlow for the screens. */
class SettingsRepo(context: Context) {
    private val prefs = context.getSharedPreferences("sidm_settings", Context.MODE_PRIVATE)
    private val _state = MutableStateFlow(read())
    val state: StateFlow<AppSettings> = _state
    val value get() = _state.value

    private fun read() = AppSettings(
        language = prefs.getString("language", null)
            ?: if (Locale.getDefault().language == "bn") "bn" else "en",
        theme = prefs.getString("theme", "system") ?: "system",
        wifiOnly = prefs.getBoolean("wifiOnly", false),
        connections = prefs.getInt("connections", 4),
        parallel = prefs.getInt("parallel", 3),
        speedLimit = prefs.getLong("speedLimit", 0),
        alwaysBest = prefs.getBoolean("alwaysBest", false),
        allowYouTube = prefs.getBoolean("allowYouTube", true),
        autoUpdateEngine = prefs.getBoolean("autoUpdateEngine", true),
        welcomeDone = prefs.getBoolean("welcomeDone", false),
        lastEngineUpdateCheck = prefs.getLong("lastEngineUpdateCheck", 0),
        lastAppUpdateCheck = prefs.getLong("lastAppUpdateCheck", 0),
        latestAppVersion = prefs.getString("latestAppVersion", null),
    )

    fun update(change: (AppSettings) -> AppSettings) {
        val next = change(_state.value)
        prefs.edit()
            .putString("language", next.language)
            .putString("theme", next.theme)
            .putBoolean("wifiOnly", next.wifiOnly)
            .putInt("connections", next.connections)
            .putInt("parallel", next.parallel)
            .putLong("speedLimit", next.speedLimit)
            .putBoolean("alwaysBest", next.alwaysBest)
            .putBoolean("allowYouTube", next.allowYouTube)
            .putBoolean("autoUpdateEngine", next.autoUpdateEngine)
            .putBoolean("welcomeDone", next.welcomeDone)
            .putLong("lastEngineUpdateCheck", next.lastEngineUpdateCheck)
            .putLong("lastAppUpdateCheck", next.lastAppUpdateCheck)
            .putString("latestAppVersion", next.latestAppVersion)
            .apply()
        _state.value = next
    }

    companion object {
        val CONNECTION_CHOICES = listOf(1, 2, 4, 8, 16)
        val PARALLEL_CHOICES = listOf(1, 2, 3, 4, 5)
        /** Bytes per second; 0 = no limit. */
        val SPEED_CHOICES = listOf(0L, 128L * 1024, 256L * 1024, 512L * 1024, 1024L * 1024, 2L * 1024 * 1024, 5L * 1024 * 1024)
    }
}
