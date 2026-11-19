package com.sidm.core

/** Safe file names and the file kinds SIDM shows in its lists. */
object FileNames {

    private val FORBIDDEN = Regex("""[\\/:*?"<>|\u0000-\u001f]""")
    private const val MAX_LENGTH = 150

    /** A name that is safe on Android storage: no slashes or control characters, not too long. */
    fun clean(name: String): String {
        var n = FORBIDDEN.replace(name, "_").trim().trim('.')
        n = n.replace(Regex("\\s+"), " ")
        if (n.isEmpty()) return "_"
        if (n.length > MAX_LENGTH) {
            val ext = n.substringAfterLast('.', "")
            n = if (ext.isNotEmpty() && ext.length <= 8 && ext.length < n.length - 1) {
                n.substring(0, MAX_LENGTH - ext.length - 1).trimEnd() + "." + ext
            } else {
                n.substring(0, MAX_LENGTH).trimEnd()
            }
        }
        return n
    }

    /**
     * File name from a Content-Disposition header, or null.
     * Handles filename*=UTF-8''name%20here and filename="name here".
     */
    fun fromContentDisposition(header: String?): String? {
        if (header.isNullOrBlank()) return null
        Regex("""filename\*\s*=\s*([^']*)'[^']*'([^;]+)""", RegexOption.IGNORE_CASE).find(header)?.let { m ->
            val charset = m.groupValues[1].ifBlank { "UTF-8" }
            val value = try {
                java.net.URLDecoder.decode(m.groupValues[2].trim().trim('"').replace("+", "%2B"), charset)
            } catch (_: Exception) {
                m.groupValues[2]
            }
            return clean(value).takeIf { it != "_" }
        }
        Regex("""filename\s*=\s*"([^"]*)"""", RegexOption.IGNORE_CASE).find(header)?.let {
            return clean(it.groupValues[1]).takeIf { n -> n != "_" }
        }
        Regex("""filename\s*=\s*([^;]+)""", RegexOption.IGNORE_CASE).find(header)?.let {
            return clean(it.groupValues[1].trim()).takeIf { n -> n != "_" }
        }
        return null
    }

    private val MIME_TO_EXT = mapOf(
        "video/mp4" to "mp4", "video/webm" to "webm", "video/x-matroska" to "mkv",
        "video/quicktime" to "mov", "video/3gpp" to "3gp", "video/mp2t" to "ts",
        "audio/mpeg" to "mp3", "audio/mp4" to "m4a", "audio/aac" to "aac", "audio/ogg" to "ogg",
        "audio/opus" to "opus", "audio/wav" to "wav", "audio/x-wav" to "wav", "audio/flac" to "flac",
        "application/pdf" to "pdf", "application/zip" to "zip", "application/x-rar-compressed" to "rar",
        "application/vnd.rar" to "rar", "application/x-7z-compressed" to "7z", "application/gzip" to "gz",
        "application/vnd.android.package-archive" to "apk", "image/jpeg" to "jpg", "image/png" to "png",
        "image/gif" to "gif", "image/webp" to "webp", "text/plain" to "txt", "text/csv" to "csv",
        "application/epub+zip" to "epub",
    )

    private val EXT_TO_MIME = MIME_TO_EXT.entries.associate { (k, v) -> v to k } + mapOf(
        "m4v" to "video/mp4", "jpeg" to "image/jpeg", "doc" to "application/msword",
        "docx" to "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xls" to "application/vnd.ms-excel",
        "xlsx" to "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "ppt" to "application/vnd.ms-powerpoint",
        "pptx" to "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "exe" to "application/x-msdownload", "iso" to "application/x-iso9660-image",
    )

    fun extensionForMime(mime: String?): String? = mime?.substringBefore(';')?.trim()?.lowercase()?.let { MIME_TO_EXT[it] }

    fun mimeFor(fileName: String): String {
        val ext = fileName.substringAfterLast('.', "").lowercase()
        return EXT_TO_MIME[ext] ?: "application/octet-stream"
    }

    /** Adds an extension from the MIME type when the name has none. */
    fun withExtension(name: String, mime: String?): String {
        if (name.substringAfterLast('.', "").let { it.isNotEmpty() && it.length <= 5 }) return name
        val ext = extensionForMime(mime) ?: return name
        return "$name.$ext"
    }

    enum class Kind { VIDEO, MUSIC, DOCUMENT, ARCHIVE, PROGRAM, IMAGE, OTHER }

    fun kindOf(fileName: String): Kind = when (fileName.substringAfterLast('.', "").lowercase()) {
        "mp4", "m4v", "mkv", "webm", "mov", "avi", "wmv", "flv", "3gp", "ts" -> Kind.VIDEO
        "mp3", "m4a", "aac", "ogg", "opus", "wav", "flac", "wma" -> Kind.MUSIC
        "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "csv", "epub", "rtf" -> Kind.DOCUMENT
        "zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "xz", "iso" -> Kind.ARCHIVE
        "apk", "exe", "msi", "dmg", "deb", "rpm" -> Kind.PROGRAM
        "jpg", "jpeg", "png", "gif", "webp", "bmp", "svg", "heic" -> Kind.IMAGE
        else -> Kind.OTHER
    }
}
