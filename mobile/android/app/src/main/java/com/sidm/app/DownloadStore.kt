package com.sidm.app

import android.content.Context
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

enum class Status { QUEUED, RUNNING, PAUSED, WAITING_NETWORK, DONE, FAILED }

enum class Kind { FILE, VIDEO }

/** One row of the downloads list. Immutable; the store replaces it on every change. */
data class DownloadItem(
    val id: String,
    val kind: Kind,
    /** The link the user gave (page link for videos, file link for files). */
    val url: String,
    val title: String,
    val fileName: String,
    val status: Status,
    val createdAt: Long,
    val doneBytes: Long = 0,
    val totalBytes: Long = -1,
    /** 0..1, or -1 when unknown. */
    val progress: Float = -1f,
    val speed: Long = 0,
    val etaSec: Long = -1,
    /** "merging", "starting" or "" while running. */
    val phase: String = "",
    val error: String? = null,
    val contentUri: String? = null,
    val mime: String? = null,
    val finishedAt: Long = 0,
    // Files
    val finalUrl: String? = null,
    val acceptsRanges: Boolean = false,
    val segments: String = "",
    val referer: String? = null,
    // Videos
    val selector: String? = null,
    val audioOnly: Boolean = false,
    val convertAudio: String? = null,
    val qualityLabel: String? = null,
    val site: String? = null,
) {
    val active get() = status == Status.QUEUED || status == Status.RUNNING || status == Status.WAITING_NETWORK

    fun toJson(): JSONObject = JSONObject().apply {
        put("id", id); put("kind", kind.name); put("url", url); put("title", title); put("fileName", fileName)
        put("status", status.name); put("createdAt", createdAt); put("doneBytes", doneBytes); put("totalBytes", totalBytes)
        put("progress", progress.toDouble()); put("error", error ?: JSONObject.NULL); put("contentUri", contentUri ?: JSONObject.NULL)
        put("mime", mime ?: JSONObject.NULL); put("finishedAt", finishedAt); put("finalUrl", finalUrl ?: JSONObject.NULL)
        put("acceptsRanges", acceptsRanges); put("segments", segments); put("referer", referer ?: JSONObject.NULL)
        put("selector", selector ?: JSONObject.NULL); put("audioOnly", audioOnly); put("convertAudio", convertAudio ?: JSONObject.NULL)
        put("qualityLabel", qualityLabel ?: JSONObject.NULL); put("site", site ?: JSONObject.NULL)
    }

    companion object {
        private fun JSONObject.str(key: String): String? = if (isNull(key)) null else optString(key, "").ifEmpty { null }

        fun fromJson(o: JSONObject) = DownloadItem(
            id = o.getString("id"),
            kind = runCatching { Kind.valueOf(o.getString("kind")) }.getOrDefault(Kind.FILE),
            url = o.getString("url"),
            title = o.optString("title"),
            fileName = o.optString("fileName"),
            status = runCatching { Status.valueOf(o.getString("status")) }.getOrDefault(Status.FAILED),
            createdAt = o.optLong("createdAt"),
            doneBytes = o.optLong("doneBytes"),
            totalBytes = o.optLong("totalBytes", -1),
            progress = o.optDouble("progress", -1.0).toFloat(),
            error = o.str("error"),
            contentUri = o.str("contentUri"),
            mime = o.str("mime"),
            finishedAt = o.optLong("finishedAt"),
            finalUrl = o.str("finalUrl"),
            acceptsRanges = o.optBoolean("acceptsRanges"),
            segments = o.optString("segments"),
            referer = o.str("referer"),
            selector = o.str("selector"),
            audioOnly = o.optBoolean("audioOnly"),
            convertAudio = o.str("convertAudio"),
            qualityLabel = o.str("qualityLabel"),
            site = o.str("site"),
        )
    }
}

/**
 * The downloads list, kept in memory as a StateFlow and saved to downloads.json.
 * Progress-only changes are saved at most every 2 seconds; status changes at once.
 */
class DownloadStore(context: Context) {
    private val file = File(context.filesDir, "downloads.json")
    private val lock = Any()
    private val _items = MutableStateFlow(load())
    val items: StateFlow<List<DownloadItem>> = _items
    @Volatile private var lastSave = 0L

    private fun load(): List<DownloadItem> = try {
        if (!file.exists()) emptyList() else {
            val arr = JSONArray(file.readText())
            (0 until arr.length()).mapNotNull { runCatching { DownloadItem.fromJson(arr.getJSONObject(it)) }.getOrNull() }
        }
    } catch (_: Exception) {
        emptyList()
    }

    private fun save(list: List<DownloadItem>) {
        lastSave = System.currentTimeMillis()
        val arr = JSONArray()
        list.forEach { arr.put(it.toJson()) }
        val tmp = File(file.parentFile, "downloads.json.tmp")
        tmp.writeText(arr.toString())
        tmp.renameTo(file)
    }

    fun get(id: String) = _items.value.firstOrNull { it.id == id }

    fun add(item: DownloadItem) = synchronized(lock) {
        val next = listOf(item) + _items.value
        _items.value = next
        save(next)
    }

    fun update(id: String, change: (DownloadItem) -> DownloadItem): DownloadItem? = synchronized(lock) {
        var updated: DownloadItem? = null
        var statusChanged = false
        val next = _items.value.map {
            if (it.id == id) {
                val n = change(it)
                statusChanged = n.status != it.status || n.contentUri != it.contentUri
                updated = n
                n
            } else it
        }
        _items.value = next
        if (statusChanged || System.currentTimeMillis() - lastSave > 2000) save(next)
        updated
    }

    fun remove(ids: Collection<String>) = synchronized(lock) {
        val next = _items.value.filterNot { it.id in ids }
        _items.value = next
        save(next)
    }

    /** After a restart nothing is running yet: running rows go back to the queue. */
    fun requeueRunning() = synchronized(lock) {
        val next = _items.value.map { if (it.status == Status.RUNNING) it.copy(status = Status.QUEUED, speed = 0) else it }
        _items.value = next
        save(next)
    }
}
