package com.sidm.app

import android.content.Context
import android.os.StatFs
import android.util.Log
import android.webkit.CookieManager
import android.webkit.WebSettings
import androidx.core.content.ContextCompat
import com.sidm.core.HttpEngine
import com.sidm.core.Links
import com.sidm.core.Outcome
import com.sidm.core.Probe
import com.sidm.core.Quality
import com.sidm.core.Segment
import com.sidm.core.SpeedLimiter
import com.sidm.core.VideoInfo
import com.sidm.core.YtdlpArgs
import com.yausername.youtubedl_android.YoutubeDL
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import java.io.File
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean

/** What a link turned out to be. */
sealed class Analysis {
    data class FileLink(val url: String, val probe: Probe, val referer: String?) : Analysis()
    data class Video(val url: String, val info: VideoInfo) : Analysis()
    data class Error(val code: String) : Analysis()
}

/**
 * The download queue: starts up to N downloads at once, files through SIDM's
 * multi-connection engine and videos through yt-dlp, and moves finished files
 * to Downloads/SIDM.
 */
class Engine(
    private val context: Context,
    val store: DownloadStore,
    private val settings: SettingsRepo,
    val video: VideoTools,
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val limiter = SpeedLimiter(settings.value.speedLimit)
    val userAgent: String = runCatching { WebSettings.getDefaultUserAgent(context) }.getOrDefault("Mozilla/5.0 (Linux; Android) SIDM")
    private val http = HttpEngine(limiter, userAgent)

    private class Running(val job: Job, val stop: AtomicBoolean, var cancel: Boolean = false)
    private val running = ConcurrentHashMap<String, Running>()
    private val net = Net(context) { schedule() }

    init {
        store.requeueRunning()
        scope.launch {
            settings.state.collect {
                limiter.bytesPerSecond = it.speedLimit
                schedule()
            }
        }
    }

    // ---------- Looking at a link ----------

    /** Decides what a link is: a DRM site (refused), a plain file, or a video page for yt-dlp. */
    suspend fun analyze(url: String, referer: String? = null): Analysis {
        if (Links.isDrm(url) || (referer != null && Links.isDrm(referer))) return Analysis.Error("errDrm")
        if (Links.isYouTube(url) && !settings.value.allowYouTube) return Analysis.Error("errYouTubeOff")
        val headers = headersFor(url, referer)
        if (Links.looksLikeFile(url)) {
            runCatching { http.probe(url, headers) }.getOrNull()?.let { if (!it.isWebPage) return Analysis.FileLink(url, it, referer) }
        }
        if (!video.awaitReady()) {
            val s = video.state.value
            return Analysis.Error("errEngine:${if (s is VideoTools.State.Failed) s.message else ""}")
        }
        var videoError: String
        try {
            val info = video.info(url, userAgent)
            if (info.hasDrm) return Analysis.Error("errDrm")
            if (info.qualities.isNotEmpty()) return Analysis.Video(url, info)
            videoError = "errUnsupported"
        } catch (e: VideoTools.VideoError) {
            videoError = e.code
        } catch (e: Exception) {
            videoError = "errOther:${e.message}"
        }
        // yt-dlp found nothing: maybe it is a file with an unusual address.
        if (videoError == "errUnsupported" || videoError.startsWith("errOther")) {
            val probe = runCatching { http.probe(url, headers) }.getOrNull()
            if (probe != null && !probe.isWebPage && probe.mime != null) return Analysis.FileLink(url, probe, referer)
            if (probe != null && probe.isWebPage && videoError == "errUnsupported") return Analysis.Error("errUnsupported")
        }
        return Analysis.Error(videoError)
    }

    private fun headersFor(url: String, referer: String?): Map<String, String> {
        val h = HashMap<String, String>()
        runCatching { CookieManager.getInstance().getCookie(url) }.getOrNull()?.let { if (it.isNotBlank()) h["Cookie"] = it }
        if (referer != null) h["Referer"] = referer
        return h
    }

    // ---------- Adding ----------

    fun addFile(link: Analysis.FileLink, fileName: String? = null): DownloadItem {
        val name = fileName ?: link.probe.fileName ?: "download"
        val item = DownloadItem(
            id = UUID.randomUUID().toString(),
            kind = Kind.FILE,
            url = link.url,
            title = name,
            fileName = name,
            status = Status.QUEUED,
            createdAt = System.currentTimeMillis(),
            totalBytes = link.probe.size,
            finalUrl = link.probe.finalUrl,
            acceptsRanges = link.probe.acceptsRanges,
            mime = link.probe.mime,
            referer = link.referer,
        )
        store.add(item)
        schedule()
        return item
    }

    /** A download the browser handed over (the page's own Download link). */
    fun addBrowserDownload(url: String, fileName: String, mime: String?, size: Long, referer: String?) {
        scope.launch {
            val probe = runCatching { http.probe(url, headersFor(url, referer)) }.getOrNull()
                ?: Probe(url, size, false, fileName, mime)
            addFile(Analysis.FileLink(url, probe, referer), fileName)
        }
    }

    fun addVideo(v: Analysis.Video, quality: Quality, qualityLabel: String): DownloadItem {
        val item = DownloadItem(
            id = UUID.randomUUID().toString(),
            kind = Kind.VIDEO,
            url = v.info.pageUrl.ifBlank { v.url },
            title = v.info.title,
            fileName = v.info.title,
            status = Status.QUEUED,
            createdAt = System.currentTimeMillis(),
            totalBytes = quality.approxBytes,
            selector = quality.selector,
            audioOnly = quality.audioOnly,
            convertAudio = quality.convertAudio,
            qualityLabel = qualityLabel,
            site = v.info.site,
        )
        store.add(item)
        schedule()
        return item
    }

    // ---------- Controls ----------

    fun pause(id: String) {
        val r = running[id]
        if (r != null) stopRunning(id, r) else store.update(id) { if (it.active) it.copy(status = Status.PAUSED, speed = 0) else it }
    }

    fun pauseAll() = store.items.value.filter { it.active }.forEach { pause(it.id) }

    fun resume(id: String) {
        store.update(id) { if (it.status == Status.PAUSED || it.status == Status.FAILED) it.copy(status = Status.QUEUED, error = null) else it }
        schedule()
    }

    /** Stops a download and removes its unfinished data (never a finished file). */
    fun cancel(id: String) {
        val r = running[id]
        if (r != null) {
            r.cancel = true
            stopRunning(id, r)
        } else {
            cleanup(id)
            store.remove(listOf(id))
        }
    }

    fun remove(id: String, deleteFile: Boolean) {
        val item = store.get(id) ?: return
        if (item.active) {
            cancel(id)
            return
        }
        if (deleteFile) Saver.delete(context, item)
        cleanup(id)
        store.remove(listOf(id))
    }

    fun clearFinished() = store.remove(store.items.value.filter { it.status == Status.DONE }.map { it.id })

    private fun stopRunning(id: String, r: Running) {
        r.stop.set(true)
        if (store.get(id)?.kind == Kind.VIDEO) video.cancel(id)
    }

    /** Unfinished data of a download: its .part file or its video work folder. */
    private fun cleanup(id: String) {
        File(Saver.workDir(context), "$id.part").delete()
        File(Saver.workDir(context), id).deleteRecursively()
    }

    // ---------- Queue ----------

    @Synchronized
    fun schedule() {
        val s = settings.value
        val items = store.items.value
        val online = net.online
        val wifiOk = !s.wifiOnly || net.unmetered
        for (item in items) {
            if (item.status == Status.RUNNING && item.id !in running) store.update(item.id) { it.copy(status = Status.QUEUED) }
            if (item.status == Status.WAITING_NETWORK && online && wifiOk) store.update(item.id) { it.copy(status = Status.QUEUED) }
        }
        val queued = store.items.value.filter { it.status == Status.QUEUED }.sortedBy { it.createdAt }
        if (queued.isNotEmpty() && (!online || !wifiOk)) {
            queued.forEach { q -> store.update(q.id) { it.copy(status = Status.WAITING_NETWORK, speed = 0, error = if (online) "wifi" else "offline") } }
            return
        }
        var free = s.parallel - running.size
        for (q in queued) {
            if (free <= 0) break
            start(q)
            free--
        }
        if (running.isNotEmpty()) {
            runCatching { ContextCompat.startForegroundService(context, android.content.Intent(context, DownloadService::class.java)) }
        }
    }

    private fun start(item: DownloadItem) {
        val stop = AtomicBoolean(false)
        store.update(item.id) { it.copy(status = Status.RUNNING, error = null, speed = 0, phase = "starting") }
        val job = scope.launch(start = CoroutineStart.LAZY) {
            try {
                when (item.kind) {
                    Kind.FILE -> runFile(item, stop)
                    Kind.VIDEO -> runVideo(item, stop)
                }
            } catch (e: Throwable) {
                Log.e(TAG, "download ${item.id} crashed", e)
                fail(item.id, "errOther:${e.message ?: e.javaClass.simpleName}")
            } finally {
                val entry = running.remove(item.id)
                if (entry?.cancel == true) {
                    cleanup(item.id)
                    store.remove(listOf(item.id))
                }
                schedule()
            }
        }
        running[item.id] = Running(job, stop)
        job.start()
    }

    /** Speed over the last few seconds, for the list and the notification. */
    private class SpeedMeter {
        private val samples = ArrayDeque<Pair<Long, Long>>()
        fun add(bytes: Long): Long {
            val now = System.nanoTime()
            samples.addLast(now to bytes)
            while (samples.size > 2 && now - samples.first().first > 3_000_000_000L) samples.removeFirst()
            val (t0, b0) = samples.first()
            val dt = (now - t0) / 1e9
            return if (dt < 0.3) 0 else ((bytes - b0) / dt).toLong().coerceAtLeast(0)
        }
    }

    private fun runFile(item: DownloadItem, stop: AtomicBoolean) {
        val temp = File(Saver.workDir(context), "${item.id}.part")
        val segments = Segment.parseList(item.segments)
        var size = item.totalBytes
        var ranges = item.acceptsRanges
        val url = item.finalUrl ?: item.url
        val headers = headersFor(url, item.referer)
        // A fresh download, or one without a known size: ask the server again (links can expire).
        if (segments.isEmpty() && size <= 0) {
            runCatching { http.probe(item.url, headersFor(item.url, item.referer)) }.getOrNull()?.let { p ->
                size = p.size
                ranges = p.acceptsRanges
                store.update(item.id) { it.copy(totalBytes = p.size, acceptsRanges = p.acceptsRanges, finalUrl = p.finalUrl) }
            }
        }
        if (size > 0 && !hasSpace(size * 2)) return fail(item.id, "errNoSpace")
        val meter = SpeedMeter()
        val outcome = http.download(url, headers, temp, size, ranges, settings.value.connections, segments, object : HttpEngine.Listener {
            override fun onProgress(done: Long, total: Long) {
                val speed = meter.add(done)
                store.update(item.id) {
                    it.copy(
                        doneBytes = done,
                        totalBytes = if (total > 0) total else it.totalBytes,
                        progress = if (total > 0) done.toFloat() / total else -1f,
                        speed = speed,
                        etaSec = if (speed > 0 && total > 0) (total - done) / speed else -1,
                        phase = "",
                        segments = Segment.formatList(segments),
                    )
                }
            }

            override fun shouldStop() = stop.get()
        })
        when (outcome) {
            Outcome.Finished -> finish(item.id, temp, item.fileName)
            Outcome.Stopped -> store.update(item.id) { it.copy(status = Status.PAUSED, speed = 0, segments = Segment.formatList(segments)) }
            is Outcome.Failed -> {
                store.update(item.id) { it.copy(segments = Segment.formatList(segments)) }
                failOrWait(item.id, outcome.message)
            }
        }
    }

    private suspend fun runVideo(item: DownloadItem, stop: AtomicBoolean) {
        if (!video.awaitReady()) return fail(item.id, "errEngine")
        val dir = File(Saver.workDir(context), item.id).apply { mkdirs() }
        val cookies = video.cookieFileFor(item.url, item.id)
        val s = settings.value
        val quality = Quality("saved", item.qualityLabel ?: "", item.selector ?: "bv*+ba/b", item.audioOnly, item.convertAudio)
        val options = YtdlpArgs.Options(
            outputDir = dir.absolutePath,
            quality = quality,
            connections = s.connections,
            speedLimitBytes = s.speedLimit,
            cookieFile = cookies?.absolutePath,
            userAgent = if (cookies != null) userAgent else null,
        )
        val meter = SpeedMeter()
        var phaseBase = 0L
        var lastTotal = -1L
        try {
            val file = video.download(item.id, item.url, options) { p, eta, total, line ->
                if (stop.get()) return@download
                if (line.startsWith("[Merger]") || line.startsWith("[ExtractAudio]") || line.startsWith("[VideoConvertor]")) {
                    store.update(item.id) { it.copy(phase = "merging", speed = 0, etaSec = -1) }
                    return@download
                }
                if (total > 0 && total != lastTotal) {
                    // yt-dlp moved on to the next part (the sound after the video).
                    if (lastTotal > 0) phaseBase += lastTotal
                    lastTotal = total
                }
                val doneNow = if (total > 0) (p.coerceIn(0f, 1f) * total).toLong() else 0L
                val done = phaseBase + doneNow
                val speed = meter.add(done)
                store.update(item.id) {
                    it.copy(
                        doneBytes = done,
                        totalBytes = if (total > 0) phaseBase + total else it.totalBytes,
                        progress = if (p >= 0) p.coerceIn(0f, 1f) else -1f,
                        speed = speed,
                        etaSec = eta,
                        phase = "",
                    )
                }
            }
            val ext = file.name.substringAfterLast('.', "mp4")
            val name = com.sidm.core.FileNames.clean(item.title).let { if (it.length > 120) it.substring(0, 120) else it } + "." + ext
            finish(item.id, file, name)
            dir.deleteRecursively()
        } catch (e: YoutubeDL.CanceledException) {
            store.update(item.id) { it.copy(status = Status.PAUSED, speed = 0, phase = "") }
        } catch (e: VideoTools.VideoError) {
            if (stop.get()) store.update(item.id) { it.copy(status = Status.PAUSED, speed = 0, phase = "") }
            else failOrWait(item.id, e.code)
        } finally {
            cookies?.delete()
        }
    }

    private fun finish(id: String, file: File, fileName: String) {
        try {
            val length = file.length()
            val (uri, mime) = Saver.publish(context, file, fileName)
            file.delete()
            val done = store.update(id) {
                it.copy(
                    status = Status.DONE, contentUri = uri.toString(), mime = mime, fileName = Saver.displayName(context, uri) ?: fileName,
                    progress = 1f, speed = 0, etaSec = 0, phase = "", finishedAt = System.currentTimeMillis(),
                    doneBytes = length, totalBytes = length, segments = "",
                )
            }
            if (done != null) Notifications.finished(context, done, settings.value.language)
        } catch (e: Exception) {
            Log.e(TAG, "save failed", e)
            fail(id, "errSave:${e.message}")
        }
    }

    private fun failOrWait(id: String, code: String) {
        if (!net.online) {
            store.update(id) { it.copy(status = Status.WAITING_NETWORK, speed = 0, error = "offline") }
        } else fail(id, code)
    }

    private fun fail(id: String, code: String) {
        val item = store.update(id) { it.copy(status = Status.FAILED, error = code, speed = 0, phase = "") }
        if (item != null) Notifications.failed(context, item, settings.value.language)
    }

    private fun hasSpace(bytes: Long): Boolean = try {
        StatFs(Saver.workDir(context).absolutePath).availableBytes > bytes
    } catch (_: Exception) {
        true
    }

    companion object {
        private const val TAG = "SIDM.engine"
    }
}
