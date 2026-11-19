package com.sidm.app

import android.content.Context
import android.util.Log
import android.webkit.CookieManager
import com.sidm.core.CookieFile
import com.sidm.core.VideoFormats
import com.sidm.core.VideoInfo
import com.sidm.core.YtdlpArgs
import com.yausername.ffmpeg.FFmpeg
import com.yausername.youtubedl_android.YoutubeDL
import com.yausername.youtubedl_android.YoutubeDLRequest
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import java.io.File

/**
 * yt-dlp and ffmpeg on the phone (through youtubedl-android, which packs a
 * Python runtime). yt-dlp is the part that knows how each social site hides its
 * videos; it updates itself from yt-dlp's releases without a new app install.
 */
class VideoTools(private val context: Context) {

    sealed class State {
        data object Starting : State()
        data object Ready : State()
        data class Failed(val message: String) : State()
    }

    private val _state = MutableStateFlow<State>(State.Starting)
    val state: StateFlow<State> = _state
    private val ready = CompletableDeferred<Boolean>()

    private val _version = MutableStateFlow<String?>(null)
    val version: StateFlow<String?> = _version

    /** Unpacks Python, yt-dlp and ffmpeg on first run. Slow (seconds), so call it off the main thread. */
    fun init() {
        try {
            YoutubeDL.getInstance().init(context)
            FFmpeg.getInstance().init(context)
            _version.value = readVersion()
            _state.value = State.Ready
            ready.complete(true)
        } catch (e: Throwable) {
            Log.e(TAG, "init failed", e)
            _state.value = State.Failed(e.message ?: e.javaClass.simpleName)
            ready.complete(false)
        }
    }

    suspend fun awaitReady(): Boolean = ready.await()

    class VideoError(val code: String) : Exception(code)

    /**
     * A cookie file with what SIDM's browser holds for this site, so a video the
     * user can see after signing in can be read. Null when there are no cookies.
     */
    fun cookieFileFor(url: String, name: String): File? {
        val header = runCatching { CookieManager.getInstance().getCookie(url) }.getOrNull()
        if (header.isNullOrBlank()) return null
        val f = File(context.cacheDir, "cookies-$name.txt")
        f.writeText(CookieFile.netscape(url, header, System.currentTimeMillis() / 1000 + 7 * 86400))
        return f
    }

    /** Asks yt-dlp what is behind [url]. Throws [VideoError] with a message key. */
    fun info(url: String, userAgent: String?): VideoInfo {
        val cookies = cookieFileFor(url, "info-${System.nanoTime()}")
        try {
            val request = YoutubeDLRequest(url)
            request.addCommands(YtdlpArgs.forInfo(cookies?.absolutePath, if (cookies != null) userAgent else null))
            val response = try {
                running { YoutubeDL.getInstance().execute(request, null, null) }
            } catch (e: Exception) {
                val msg = e.message.orEmpty()
                Log.w(TAG, "info failed (${com.sidm.core.Links.hostOf(url)}): ${YtdlpArgs.lastError(msg).take(300)}")
                throw VideoError(YtdlpArgs.errorKey(msg) ?: "errOther:${YtdlpArgs.lastError(msg).take(300)}")
            }
            val json = response.out.lineSequence().firstOrNull { it.trimStart().startsWith("{") }
                ?: throw VideoError(YtdlpArgs.errorKey(response.err) ?: "errUnsupported")
            return VideoFormats.parse(json, url)
        } finally {
            cookies?.delete()
        }
    }

    /**
     * Downloads with yt-dlp into [workDir]. [onProgress] gets (0..1, eta seconds, total bytes or -1, raw line).
     * Returns the finished file. Throws [YoutubeDL.CanceledException] when [cancel] was called.
     */
    fun download(
        id: String,
        url: String,
        options: YtdlpArgs.Options,
        onProgress: (Float, Long, Long, String) -> Unit,
    ): File {
        val request = YoutubeDLRequest(url)
        request.addCommands(YtdlpArgs.forDownload(options))
        try {
            running {
                YoutubeDL.getInstance().execute(request, id) { progress: Float, eta: Long, line: String ->
                    val total = YtdlpArgs.parseProgress(line)?.second ?: -1L
                    onProgress(progress / 100f, eta, total, line)
                }
            }
        } catch (e: YoutubeDL.CanceledException) {
            throw e
        } catch (e: Exception) {
            val msg = e.message.orEmpty()
            throw VideoError(YtdlpArgs.errorKey(msg) ?: "errOther:${YtdlpArgs.lastError(msg).take(300)}")
        }
        val dir = File(options.outputDir)
        return dir.listFiles()
            ?.filter { it.isFile && !it.name.endsWith(".part") && !it.name.endsWith(".ytdl") && !it.name.contains(".part-Frag") }
            ?.maxByOrNull { it.length() }
            ?: throw VideoError("errOther:yt-dlp finished but no file was found")
    }

    fun cancel(id: String) {
        runCatching { YoutubeDL.getInstance().destroyProcessById(id) }
    }

    // An update replaces the yt-dlp file, so it must not happen while yt-dlp runs
    // (Python then fails with "bad local file header"). Runs wait while an update
    // is in progress; an update waits until no run is active.
    private val gate = Object()
    private var activeRuns = 0
    private var updating = false

    private inline fun <T> running(block: () -> T): T {
        synchronized(gate) {
            while (updating) gate.wait()
            activeRuns++
        }
        try {
            return block()
        } finally {
            synchronized(gate) {
                activeRuns--
                gate.notifyAll()
            }
        }
    }

    class BusyException : Exception("yt-dlp is busy with a download")

    /**
     * Updates yt-dlp to its latest stable release. Returns the new version, or
     * null if it was up to date. Waits up to [waitMs] for running downloads to
     * finish, then throws [BusyException].
     */
    fun update(waitMs: Long = 10 * 60_000L): String? {
        synchronized(gate) {
            val until = System.currentTimeMillis() + waitMs
            while (activeRuns > 0 || updating) {
                val left = until - System.currentTimeMillis()
                if (left <= 0) throw BusyException()
                gate.wait(left)
            }
            updating = true
        }
        try {
            val status = YoutubeDL.getInstance().updateYoutubeDL(context, YoutubeDL.UpdateChannel.STABLE)
            val v = readVersion()
            _version.value = v
            Log.i(TAG, "yt-dlp update: $status, now $v")
            return if (status == YoutubeDL.UpdateStatus.DONE) v else null
        } finally {
            synchronized(gate) {
                updating = false
                gate.notifyAll()
            }
        }
    }

    /**
     * The library only remembers the version after an update, so on a fresh
     * install ask yt-dlp itself.
     */
    private fun readVersion(): String? {
        runCatching { YoutubeDL.getInstance().version(context) }.getOrNull()?.takeIf { it.isNotBlank() }?.let { return it }
        return runCatching {
            val request = YoutubeDLRequest(emptyList<String>()).addOption("--version")
            YoutubeDL.getInstance().execute(request, null, null).out.trim().lineSequence().lastOrNull()?.trim()
        }.onFailure { Log.w(TAG, "yt-dlp --version failed", it) }.getOrNull()?.takeIf { it.isNotBlank() }
    }

    companion object {
        private const val TAG = "SIDM.video"
    }
}
