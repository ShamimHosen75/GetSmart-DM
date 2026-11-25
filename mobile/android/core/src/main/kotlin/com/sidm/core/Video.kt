package com.sidm.core

import org.json.JSONArray
import org.json.JSONObject

/** One choice in the quality picker. [selector] is a yt-dlp format selector. */
data class Quality(
    val id: String,
    val label: String,
    val selector: String,
    val audioOnly: Boolean = false,
    /** "mp3" when the audio is converted with ffmpeg, else null. */
    val convertAudio: String? = null,
    val approxBytes: Long = -1,
    val height: Int = 0,
)

/** What yt-dlp found behind a link. */
data class VideoInfo(
    val title: String,
    val site: String,
    val thumbnail: String?,
    val durationSec: Long,
    val qualities: List<Quality>,
    /** The page link yt-dlp should download (the canonical one when it gives one). */
    val pageUrl: String,
    val isLive: Boolean,
    val hasDrm: Boolean,
    val entries: Int,
)

/** Turns yt-dlp's JSON (--dump-single-json) into what the quality picker shows. */
object VideoFormats {

    const val BEST_ID = "best"

    fun parse(json: String, requestedUrl: String): VideoInfo {
        var root = JSONObject(json)
        var entries = 1
        // A playlist or a post with several videos: SIDM takes the first video.
        if (root.optString("_type") == "playlist") {
            val list = root.optJSONArray("entries") ?: JSONArray()
            entries = list.length()
            val first = (0 until list.length()).asSequence().mapNotNull { list.optJSONObject(it) }.firstOrNull()
            if (first != null) root = first
        }
        val formats = root.optJSONArray("formats") ?: JSONArray()
        var drm = root.optBoolean("_has_drm", false)
        val videos = ArrayList<Fmt>()
        val audios = ArrayList<Fmt>()
        for (i in 0 until formats.length()) {
            val f = formats.optJSONObject(i) ?: continue
            if (f.optBoolean("has_drm", false)) {
                drm = true
                continue
            }
            val fmt = Fmt(
                id = f.optString("format_id"),
                height = f.optInt("height", 0),
                vcodec = f.optString("vcodec", ""),
                acodec = f.optString("acodec", ""),
                bytes = f.optLong("filesize", 0).takeIf { it > 0 } ?: f.optLong("filesize_approx", 0),
                tbr = f.optDouble("tbr", 0.0).let { if (it.isNaN()) 0.0 else it },
                protocol = f.optString("protocol", ""),
            )
            if (fmt.protocol.startsWith("mhtml")) continue // storyboards
            val hasVideo = fmt.vcodec.isNotEmpty() && fmt.vcodec != "none"
            val hasAudio = fmt.acodec.isNotEmpty() && fmt.acodec != "none"
            when {
                hasVideo || (fmt.height > 0 && fmt.vcodec.isEmpty()) -> videos += fmt
                hasAudio -> audios += fmt
            }
        }
        val bestAudio = audios.maxByOrNull { it.tbr }
        val heights = videos.map { it.height }.filter { it > 0 }.distinct().sortedDescending()
        val qualities = ArrayList<Quality>()
        val top = heights.firstOrNull() ?: 0
        val bestSize = videos.filter { it.height == top }.maxOfOrNull { it.bytes }?.takeIf { it > 0 }
            ?.let { it + (bestAudio?.bytes ?: 0) } ?: -1
        qualities += Quality(
            id = BEST_ID,
            label = if (top > 0) "${label(top)} · original" else "Original",
            selector = "bv*+ba/b",
            approxBytes = bestSize,
            height = top,
        )
        for (h in heights.drop(1).take(6)) {
            val v = videos.filter { it.height == h }.maxByOrNull { it.tbr }
            val size = v?.bytes?.takeIf { it > 0 }?.let { it + (bestAudio?.bytes ?: 0) } ?: -1
            qualities += Quality(
                id = "h$h",
                label = label(h),
                selector = "bv*[height<=$h]+ba/b[height<=$h]/b",
                approxBytes = size,
                height = h,
            )
        }
        if (videos.isNotEmpty() || audios.isNotEmpty()) {
            qualities += Quality("m4a", "Audio · M4A", "ba[ext=m4a]/ba/b", audioOnly = true, approxBytes = bestAudio?.bytes?.takeIf { it > 0 } ?: -1)
            qualities += Quality("mp3", "Audio · MP3", "ba/b", audioOnly = true, convertAudio = "mp3")
        }
        val page = root.optString("webpage_url").ifBlank { root.optString("original_url") }.ifBlank { requestedUrl }
        return VideoInfo(
            title = root.optString("title").ifBlank { root.optString("id", "video") },
            site = root.optString("extractor_key").ifBlank { root.optString("extractor") }.ifBlank { Links.hostOf(requestedUrl) },
            thumbnail = root.optString("thumbnail").ifBlank { null },
            durationSec = root.optDouble("duration", 0.0).let { if (it.isNaN()) 0L else it.toLong() },
            qualities = qualities,
            pageUrl = page,
            isLive = root.optBoolean("is_live", false),
            hasDrm = drm,
            entries = entries,
        )
    }

    /** 2160 -> "4K (2160p)", 720 -> "720p". */
    fun label(height: Int): String = when {
        height >= 4320 -> "8K (${height}p)"
        height >= 2160 -> "4K (${height}p)"
        height >= 1440 -> "2K (${height}p)"
        else -> "${height}p"
    }

    private data class Fmt(
        val id: String,
        val height: Int,
        val vcodec: String,
        val acodec: String,
        val bytes: Long,
        val tbr: Double,
        val protocol: String,
    )
}

/** Builds yt-dlp's command-line options for one download. */
object YtdlpArgs {

    data class Options(
        val outputDir: String,
        val quality: Quality,
        val connections: Int,
        val speedLimitBytes: Long,
        val cookieFile: String?,
        val userAgent: String?,
    )

    fun forDownload(o: Options): List<String> {
        val args = mutableListOf(
            // Only the video the quality picker showed: a post with several
            // videos is a "playlist" to yt-dlp, and forInfo looked at item 1.
            "--no-playlist",
            "--playlist-items", "1",
            "--newline",
            "--no-mtime",
            "--no-colors",
            "--continue",
            "--trim-filenames", "140",
            "-o", "${o.outputDir}/%(title).120B [%(id)s].%(ext)s",
            "-f", o.quality.selector,
            "-N", o.connections.coerceIn(1, 16).toString(),
        )
        if (o.quality.audioOnly) {
            if (o.quality.convertAudio != null) {
                args += listOf("-x", "--audio-format", o.quality.convertAudio, "--audio-quality", "0")
            }
        } else {
            args += listOf("--merge-output-format", "mp4/mkv")
        }
        if (o.speedLimitBytes > 0) args += listOf("-r", o.speedLimitBytes.toString())
        if (o.cookieFile != null) args += listOf("--cookies", o.cookieFile)
        if (o.userAgent != null) args += listOf("--user-agent", o.userAgent)
        return args
    }

    fun forInfo(cookieFile: String?, userAgent: String?): List<String> {
        val args = mutableListOf("--dump-single-json", "--no-warnings", "--no-playlist", "--playlist-items", "1")
        if (cookieFile != null) args += listOf("--cookies", cookieFile)
        if (userAgent != null) args += listOf("--user-agent", userAgent)
        return args
    }

    private val PROGRESS = Regex("""\[download]\s+([\d.]+)%(?:\s+of\s+~?\s*([\d.]+)\s*([KMGT]?i?B))?""")

    /** Reads "[download]  42.0% of ~ 12.30MiB at ..." into (percent, total bytes or -1). */
    fun parseProgress(line: String): Pair<Float, Long>? {
        val m = PROGRESS.find(line) ?: return null
        val pct = m.groupValues[1].toFloatOrNull() ?: return null
        val total = m.groupValues[2].toDoubleOrNull()?.let { n ->
            val mult = when (m.groupValues[3].uppercase().replace("I", "")) {
                "KB" -> 1024.0
                "MB" -> 1024.0 * 1024
                "GB" -> 1024.0 * 1024 * 1024
                "TB" -> 1024.0 * 1024 * 1024 * 1024
                else -> 1.0
            }
            (n * mult).toLong()
        } ?: -1L
        return pct to total
    }

    /**
     * A message key for a yt-dlp error ("errDrm", "errUnsupported", "errLogin",
     * "errUnavailable", "errLive", "errNetworkVideo"), or null to show yt-dlp's own words.
     */
    fun errorKey(stderr: String): String? {
        val s = stderr.lowercase()
        return when {
            "drm" in s -> "errDrm"
            "unsupported url" in s -> "errUnsupported"
            "private" in s || "login" in s || "log in" in s || "sign in" in s || "cookies" in s || "confirm your age" in s -> "errLogin"
            "is not available" in s || "unavailable" in s || "http error 404" in s -> "errUnavailable"
            "live event" in s || "is live" in s || "is_live" in s -> "errLive"
            "unable to download webpage" in s || "connection" in s || "timed out" in s || "name resolution" in s -> "errNetworkVideo"
            else -> null
        }
    }

    /** The last "ERROR: ..." line of yt-dlp's output, without the prefix. */
    fun lastError(stderr: String): String =
        stderr.lines().lastOrNull { it.startsWith("ERROR:") }?.removePrefix("ERROR:")?.trim()
            ?: stderr.lines().lastOrNull { it.isNotBlank() }?.trim().orEmpty()
}
