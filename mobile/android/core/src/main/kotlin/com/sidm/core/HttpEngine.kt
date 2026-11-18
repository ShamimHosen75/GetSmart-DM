package com.sidm.core

import java.io.File
import java.io.IOException
import java.io.InputStream
import java.io.RandomAccessFile
import java.net.HttpURLConnection
import java.net.URL
import java.nio.ByteBuffer
import java.util.concurrent.atomic.AtomicReference

/** One byte range of a file. [end] is inclusive and may shrink when another connection takes over half. */
class Segment(val start: Long, end: Long, done: Long = 0) {
    @Volatile var end: Long = end
    @Volatile var done: Long = done

    val position get() = start + done
    val remaining get() = (end - position + 1).coerceAtLeast(0)
    val finished get() = position > end

    override fun toString() = "$start-$end:$done"

    companion object {
        /** "0-99:50,100-199:0" back into segments (how the app stores them). */
        fun parseList(text: String?): MutableList<Segment> {
            if (text.isNullOrBlank()) return mutableListOf()
            return text.split(',').mapNotNull { part ->
                val m = Regex("""(\d+)-(\d+):(\d+)""").matchEntire(part.trim()) ?: return@mapNotNull null
                Segment(m.groupValues[1].toLong(), m.groupValues[2].toLong(), m.groupValues[3].toLong())
            }.toMutableList()
        }

        fun formatList(segments: List<Segment>) = segments.joinToString(",")

        /**
         * Splits [size] bytes into up to [connections] equal parts, none smaller than [minPart]
         * (small files are not worth several connections).
         */
        fun plan(size: Long, connections: Int, minPart: Long = 512 * 1024): MutableList<Segment> {
            if (size <= 0) return mutableListOf()
            val count = minOf(connections.coerceAtLeast(1).toLong(), maxOf(1L, size / minPart)).toInt()
            val part = size / count
            return MutableList(count) { i ->
                val start = i * part
                val end = if (i == count - 1) size - 1 else start + part - 1
                Segment(start, end)
            }
        }
    }
}

/** What the server says about a link before downloading. */
data class Probe(
    val finalUrl: String,
    val size: Long,
    val acceptsRanges: Boolean,
    val fileName: String?,
    val mime: String?,
) {
    val isWebPage get() = mime?.startsWith("text/html", true) == true ||
        mime?.startsWith("application/xhtml", true) == true
}

sealed class Outcome {
    data object Finished : Outcome()
    data object Stopped : Outcome()
    data class Failed(val message: String) : Outcome()
}

class HttpStatusException(val code: Int) : IOException("HTTP $code")

/**
 * SIDM's file download engine: several connections per file (each one fetches
 * its own byte range), resume after pause or a dropped network, and the shared
 * speed limit. Plain java.net, so it runs and is tested on any JVM.
 */
class HttpEngine(
    private val limiter: SpeedLimiter,
    private val userAgent: String,
    private val connectTimeoutMs: Int = 20_000,
    private val readTimeoutMs: Int = 30_000,
) {
    interface Listener {
        /** Called about 4 times a second while downloading. */
        fun onProgress(done: Long, total: Long)
        /** True once the user paused or cancelled; the engine stops soon after. */
        fun shouldStop(): Boolean
    }

    private fun open(url: String, headers: Map<String, String>, range: String?): HttpURLConnection {
        var current = url
        repeat(10) {
            val conn = URL(current).openConnection() as HttpURLConnection
            conn.instanceFollowRedirects = false
            conn.connectTimeout = connectTimeoutMs
            conn.readTimeout = readTimeoutMs
            conn.setRequestProperty("User-Agent", userAgent)
            conn.setRequestProperty("Accept-Encoding", "identity")
            headers.forEach { (k, v) -> conn.setRequestProperty(k, v) }
            if (range != null) conn.setRequestProperty("Range", range)
            val code = conn.responseCode
            if (code in 300..399 && code != 304) {
                val location = conn.getHeaderField("Location") ?: throw HttpStatusException(code)
                conn.disconnect()
                current = URL(URL(current), location).toString()
                return@repeat
            }
            if (code >= 400) {
                conn.disconnect()
                throw HttpStatusException(code)
            }
            return conn
        }
        throw IOException("Too many redirects")
    }

    /** Asks for the first byte only, to learn the size, the name and whether ranges work. */
    fun probe(url: String, headers: Map<String, String> = emptyMap()): Probe {
        val conn = open(url, headers, "bytes=0-0")
        try {
            val finalUrl = conn.url.toString()
            val mime = conn.contentType
            val disposition = conn.getHeaderField("Content-Disposition")
            val (size, ranges) = if (conn.responseCode == 206) {
                val total = conn.getHeaderField("Content-Range")?.substringAfterLast('/')?.trim()?.toLongOrNull() ?: -1L
                total to (total > 0)
            } else {
                val length = conn.getHeaderField("Content-Length")?.toLongOrNull() ?: -1L
                length to (conn.getHeaderField("Accept-Ranges")?.contains("bytes", true) == true && length > 0)
            }
            val name = FileNames.fromContentDisposition(disposition)
                ?: Links.fileNameFromUrl(finalUrl)
                ?: Links.fileNameFromUrl(url)
            return Probe(finalUrl, size, ranges, name?.let { FileNames.withExtension(it, mime) }, mime)
        } finally {
            conn.disconnect()
        }
    }

    /**
     * Downloads [url] into [target]. With [acceptsRanges] and a known [size] the file is
     * split over [connections] connections, and [segments] (empty for a new download)
     * carries the progress so a later call resumes where this one stopped.
     */
    fun download(
        url: String,
        headers: Map<String, String>,
        target: File,
        size: Long,
        acceptsRanges: Boolean,
        connections: Int,
        segments: MutableList<Segment>,
        listener: Listener,
    ): Outcome {
        target.parentFile?.mkdirs()
        return if (acceptsRanges && size > 0) {
            if (segments.isEmpty() || segments.last().end != size - 1) {
                segments.clear()
                segments.addAll(Segment.plan(size, connections))
            }
            downloadRanges(url, headers, target, size, connections, segments, listener)
        } else {
            segments.clear()
            downloadSingle(url, headers, target, size, listener)
        }
    }

    private fun downloadSingle(url: String, headers: Map<String, String>, target: File, size: Long, listener: Listener): Outcome {
        var done = 0L
        var lastReport = 0L
        return try {
            val conn = open(url, headers, null)
            try {
                conn.inputStream.use { input ->
                    target.outputStream().use { out ->
                        val buf = ByteArray(BUFFER)
                        while (true) {
                            if (listener.shouldStop()) return Outcome.Stopped
                            val n = input.read(buf)
                            if (n < 0) break
                            limiter.acquire(n)
                            out.write(buf, 0, n)
                            done += n
                            val now = System.nanoTime()
                            if (now - lastReport > REPORT_NS) {
                                lastReport = now
                                listener.onProgress(done, size)
                            }
                        }
                    }
                }
            } finally {
                conn.disconnect()
            }
            if (size > 0 && done < size) return Outcome.Failed("errNetwork:closed early")
            listener.onProgress(done, if (size > 0) size else done)
            Outcome.Finished
        } catch (e: IOException) {
            if (listener.shouldStop()) Outcome.Stopped else Outcome.Failed(describe(e))
        }
    }

    private fun downloadRanges(
        url: String,
        headers: Map<String, String>,
        target: File,
        size: Long,
        connections: Int,
        segments: MutableList<Segment>,
        listener: Listener,
    ): Outcome {
        val error = AtomicReference<String?>(null)
        val lock = Object()
        RandomAccessFile(target, "rw").use { raf ->
            if (raf.length() != size) raf.setLength(size)
            val channel = raf.channel

            fun stop() = listener.shouldStop() || error.get() != null

            fun runSegment(seg: Segment) {
                var attempt = 0
                while (!seg.finished && !stop()) {
                    try {
                        val conn = open(url, headers, "bytes=${seg.position}-${seg.end}")
                        try {
                            if (conn.responseCode != 206) throw IOException("ranges refused")
                            readInto(conn.inputStream, seg, channel, ::stop)
                            attempt = 0
                        } finally {
                            conn.disconnect()
                        }
                    } catch (e: IOException) {
                        if (stop()) return
                        attempt += 1
                        if (attempt > MAX_RETRIES || (e is HttpStatusException && e.code in 400..499 && e.code != 408 && e.code != 429)) {
                            error.compareAndSet(null, describe(e))
                            return
                        }
                        Thread.sleep(minOf(8000L, 500L shl attempt))
                    }
                }
            }

            /** A connection that ran out of work takes the second half of the biggest remaining part. */
            fun steal(): Segment? = synchronized(lock) {
                val biggest = segments.filter { !it.finished }.maxByOrNull { it.remaining } ?: return null
                if (biggest.remaining < 2 * MIN_STEAL) return null
                val mid = biggest.position + biggest.remaining / 2
                val taken = Segment(mid, biggest.end)
                biggest.end = mid - 1
                segments.add(segments.indexOf(biggest) + 1, taken)
                taken
            }

            val assigned = HashSet<Segment>()

            fun next(): Segment? = synchronized(lock) {
                val free = segments.firstOrNull { !it.finished && it !in assigned }
                (free ?: steal())?.also { assigned += it }
            }

            val workers = List(connections.coerceIn(1, 16)) {
                Thread {
                    while (!stop()) {
                        val seg = next() ?: break
                        runSegment(seg)
                    }
                }.apply { isDaemon = true; start() }
            }

            while (workers.any { it.isAlive }) {
                listener.onProgress(segments.sumOf { minOf(it.done, it.end - it.start + 1) }, size)
                workers.firstOrNull { it.isAlive }?.join(REPORT_NS / 1_000_000)
            }
            listener.onProgress(segments.sumOf { minOf(it.done, it.end - it.start + 1) }, size)
        }
        error.get()?.let { return Outcome.Failed(it) }
        if (listener.shouldStop()) return Outcome.Stopped
        return if (segments.all { it.finished }) Outcome.Finished else Outcome.Failed("errNetwork:incomplete")
    }

    private fun readInto(input: InputStream, seg: Segment, channel: java.nio.channels.FileChannel, stop: () -> Boolean) {
        input.use { stream ->
            val buf = ByteArray(BUFFER)
            while (!seg.finished) {
                if (stop()) return
                val want = minOf(BUFFER.toLong(), seg.remaining).toInt()
                val n = stream.read(buf, 0, want)
                if (n < 0) {
                    if (!seg.finished) throw IOException("closed early")
                    return
                }
                limiter.acquire(n)
                // The part may have been shortened by another connection while we read.
                val usable = minOf(n.toLong(), seg.remaining).toInt()
                if (usable > 0) {
                    channel.write(ByteBuffer.wrap(buf, 0, usable), seg.position)
                    seg.done += usable
                }
            }
        }
    }

    /**
     * A short error code the app translates: "errAccess:403", "errGone:404", "errHttp:500",
     * "errOffline", "errTimeout", "errNetwork:<detail>".
     */
    private fun describe(e: IOException): String = when (e) {
        is HttpStatusException -> when (e.code) {
            401, 403 -> "errAccess:${e.code}"
            404, 410 -> "errGone:${e.code}"
            else -> "errHttp:${e.code}"
        }
        is java.net.UnknownHostException -> "errOffline"
        is java.net.SocketTimeoutException -> "errTimeout"
        else -> "errNetwork:${e.message ?: ""}"
    }

    companion object {
        private const val BUFFER = 64 * 1024
        private const val MAX_RETRIES = 6
        private const val MIN_STEAL = 1024L * 1024
        private const val REPORT_NS = 250_000_000L
    }
}
