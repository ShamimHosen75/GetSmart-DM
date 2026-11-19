package com.sidm.core

import java.net.URI
import java.net.URLDecoder

/**
 * Rules about links: which sites are refused (DRM), which are YouTube, which
 * links are plain files, and how to pull a link out of shared text.
 * Same lists as the extension's sites.js, so both products behave alike.
 */
object Links {

    /** DRM services: never downloaded. We refuse instead of working around protection. */
    val DRM_HOSTS = listOf(
        "netflix.com", "nflxvideo.net", "primevideo.com", "amazonvideo.com",
        "disneyplus.com", "disney-plus.net", "hotstar.com", "hulu.com", "max.com",
        "hbomax.com", "peacocktv.com", "paramountplus.com", "tv.apple.com",
        "music.apple.com", "spotify.com", "scdn.co", "deezer.com", "tidal.com",
        "crunchyroll.com",
    )

    val YOUTUBE_HOSTS = listOf("youtube.com", "youtu.be", "youtube-nocookie.com", "googlevideo.com")

    /** File types downloaded directly with the multi-connection engine. */
    val FILE_EXTENSIONS = setOf(
        // video and audio
        "mp4", "m4v", "mkv", "webm", "mov", "avi", "wmv", "flv", "3gp", "ts",
        "mp3", "m4a", "aac", "ogg", "opus", "wav", "flac", "wma",
        // documents
        "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "csv", "epub", "rtf",
        // archives and programs
        "zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "xz", "apk", "exe", "msi", "dmg", "iso", "deb", "rpm",
        // images
        "jpg", "jpeg", "png", "gif", "webp", "bmp", "svg", "heic",
    )

    /** Streaming playlists: handed to yt-dlp, which joins the pieces. */
    val STREAM_EXTENSIONS = setOf("m3u8", "mpd")

    /** Host in lower case without "www.", or "" when the text is not a web link. */
    fun hostOf(url: String?): String {
        if (url.isNullOrBlank()) return ""
        return try {
            (URI(url.trim()).host ?: "").lowercase().removePrefix("www.")
        } catch (_: Exception) {
            ""
        }
    }

    /** True if [host] is one of [domains] or a subdomain of one. */
    fun hostMatches(host: String, domains: List<String>): Boolean {
        val h = host.lowercase().removePrefix("www.")
        return h.isNotEmpty() && domains.any { h == it || h.endsWith(".$it") }
    }

    fun isDrm(url: String?) = hostMatches(hostOf(url), DRM_HOSTS)

    fun isYouTube(url: String?) = hostMatches(hostOf(url), YOUTUBE_HOSTS)

    fun isWebLink(text: String?): Boolean {
        if (text.isNullOrBlank()) return false
        val t = text.trim()
        return (t.startsWith("http://", true) || t.startsWith("https://", true)) && hostOf(t).isNotEmpty()
    }

    /** Lower-case extension of the link's path ("mp4"), or "". */
    fun extensionOf(url: String): String {
        val path = try {
            URI(url.trim()).rawPath ?: ""
        } catch (_: Exception) {
            return ""
        }
        val name = path.substringAfterLast('/')
        if (!name.contains('.')) return ""
        return name.substringAfterLast('.').lowercase()
    }

    fun looksLikeFile(url: String) = extensionOf(url) in FILE_EXTENSIONS

    fun looksLikeStream(url: String) = extensionOf(url) in STREAM_EXTENSIONS

    private val URL_IN_TEXT = Regex("""https?://[^\s<>"'`]+""", RegexOption.IGNORE_CASE)

    /**
     * The first web link in shared text. Apps share things like
     * "Look at this! https://www.instagram.com/reel/abc/?igsh=x" or a bare link.
     * Trailing punctuation that is part of the sentence is dropped.
     */
    fun firstLink(text: String?): String? {
        if (text.isNullOrBlank()) return null
        val match = URL_IN_TEXT.find(text) ?: return null
        return match.value.trimEnd('.', ',', ')', ']', '}', '!', '?', ';', ':', '»', '"')
    }

    /** "file.mp4" from a link's path, decoded, or null if the path has no usable name. */
    fun fileNameFromUrl(url: String): String? {
        val raw = try {
            URI(url.trim()).rawPath ?: return null
        } catch (_: Exception) {
            return null
        }
        val last = raw.substringAfterLast('/')
        if (last.isBlank()) return null
        val decoded = try {
            URLDecoder.decode(last.replace("+", "%2B"), "UTF-8")
        } catch (_: Exception) {
            last
        }
        return FileNames.clean(decoded).takeIf { it.isNotBlank() && it != "_" }
    }
}
