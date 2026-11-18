package com.sidm.core

/** Cookie files for yt-dlp, so videos the user can see after signing in can be saved. */
object CookieFile {

    /**
     * Netscape cookie file text for [url] from a browser Cookie header ("a=1; b=2").
     * The browser does not say which domain each cookie belongs to, so they are
     * written for the site's main domain and all its subdomains.
     */
    fun netscape(url: String, cookieHeader: String?, expiresEpochSec: Long): String {
        val sb = StringBuilder("# Netscape HTTP Cookie File\n")
        val host = Links.hostOf(url)
        if (host.isEmpty() || cookieHeader.isNullOrBlank()) return sb.toString()
        val domain = "." + mainDomain(host)
        val secure = if (url.trim().startsWith("https", true)) "TRUE" else "FALSE"
        cookieHeader.split(';').forEach { pair ->
            val name = pair.substringBefore('=').trim()
            if (name.isEmpty() || !pair.contains('=')) return@forEach
            val value = pair.substringAfter('=').trim()
            sb.append(domain).append("\tTRUE\t/\t").append(secure).append('\t')
                .append(expiresEpochSec).append('\t').append(name).append('\t').append(value).append('\n')
        }
        return sb.toString()
    }

    private val TWO_PART_SUFFIXES = setOf("co.uk", "com.au", "co.in", "com.bd", "co.jp", "com.br", "co.kr", "com.tr", "com.mx")

    /** "m.facebook.com" -> "facebook.com", "news.bbc.co.uk" -> "bbc.co.uk". */
    fun mainDomain(host: String): String {
        val parts = host.lowercase().split('.')
        if (parts.size <= 2) return host.lowercase()
        val lastTwo = parts.takeLast(2).joinToString(".")
        return if (lastTwo in TWO_PART_SUFFIXES) parts.takeLast(3).joinToString(".") else lastTwo
    }
}

object Versions {
    /** >0 if [a] is newer than [b], <0 if older, 0 if equal ("0.5.0" vs "0.4.10"). */
    fun compare(a: String, b: String): Int {
        val pa = a.trim().split('.').map { it.toIntOrNull() ?: 0 }
        val pb = b.trim().split('.').map { it.toIntOrNull() ?: 0 }
        for (i in 0 until maxOf(pa.size, pb.size)) {
            val d = pa.getOrElse(i) { 0 } - pb.getOrElse(i) { 0 }
            if (d != 0) return d
        }
        return 0
    }

    private val VERSION_JSON = Regex(""""version"\s*:\s*"(\d+\.\d+\.\d+)"""")

    /** The version from the website's version.json, or null. */
    fun fromVersionJson(text: String): String? = VERSION_JSON.find(text)?.groupValues?.get(1)
}

/** Sizes and times for the screens: "12.4 MB", "1.2 MB/s", "3:05". */
object Units {
    fun bytes(n: Long): String {
        if (n < 0) return "?"
        if (n < 1024) return "$n B"
        val units = listOf("KB", "MB", "GB", "TB")
        var v = n.toDouble()
        var i = -1
        while (v >= 1024 && i < units.size - 1) {
            v /= 1024
            i++
        }
        return if (v >= 100) "${v.toLong()} ${units[i]}" else String.format(java.util.Locale.US, "%.1f %s", v, units[i])
    }

    fun speed(bytesPerSec: Long) = bytes(bytesPerSec) + "/s"

    fun duration(sec: Long): String {
        if (sec < 0) return "--:--"
        val h = sec / 3600
        val m = (sec % 3600) / 60
        val s = sec % 60
        return if (h > 0) String.format(java.util.Locale.US, "%d:%02d:%02d", h, m, s) else String.format(java.util.Locale.US, "%d:%02d", m, s)
    }
}
