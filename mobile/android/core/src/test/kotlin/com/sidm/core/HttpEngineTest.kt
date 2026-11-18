package com.sidm.core

import com.sun.net.httpserver.HttpServer
import java.io.File
import java.net.InetSocketAddress
import java.util.concurrent.atomic.AtomicInteger
import kotlin.random.Random
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class HttpEngineTest {
    private val data = Random(7).nextBytes(5 * 1024 * 1024 + 123)
    private lateinit var server: HttpServer
    private val rangeRequests = AtomicInteger()
    private var base = ""

    @BeforeTest fun start() {
        server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/file.bin") { ex ->
            val range = ex.requestHeaders.getFirst("Range")
            ex.responseHeaders.add("Accept-Ranges", "bytes")
            ex.responseHeaders.add("Content-Type", "application/octet-stream")
            if (range != null) {
                rangeRequests.incrementAndGet()
                val (a, b) = range.removePrefix("bytes=").split('-')
                val start = a.toInt()
                val end = if (b.isEmpty()) data.size - 1 else minOf(b.toInt(), data.size - 1)
                ex.responseHeaders.add("Content-Range", "bytes $start-$end/${data.size}")
                ex.sendResponseHeaders(206, (end - start + 1).toLong())
                ex.responseBody.use { it.write(data, start, end - start + 1) }
            } else {
                ex.sendResponseHeaders(200, data.size.toLong())
                ex.responseBody.use { it.write(data) }
            }
        }
        server.createContext("/plain") { ex ->
            ex.responseHeaders.add("Content-Disposition", "attachment; filename=\"notes.txt\"")
            ex.sendResponseHeaders(200, 0)
            ex.responseBody.use { it.write("hello".toByteArray()) }
        }
        server.createContext("/moved") { ex ->
            ex.responseHeaders.add("Location", "/file.bin")
            ex.sendResponseHeaders(302, -1)
            ex.close()
        }
        server.executor = java.util.concurrent.Executors.newFixedThreadPool(16)
        server.start()
        base = "http://127.0.0.1:${server.address.port}"
    }

    @AfterTest fun stop() = server.stop(0)

    private fun listener(stopAfter: Long = Long.MAX_VALUE) = object : HttpEngine.Listener {
        @Volatile var done = 0L
        override fun onProgress(done: Long, total: Long) { this.done = done }
        override fun shouldStop() = done >= stopAfter
    }

    @Test fun probeFollowsRedirectAndReadsSize() {
        val p = HttpEngine(SpeedLimiter(), "test").probe("$base/moved")
        assertEquals(data.size.toLong(), p.size)
        assertTrue(p.acceptsRanges)
        assertEquals("file.bin", p.fileName)
        assertTrue(p.finalUrl.endsWith("/file.bin"))
    }

    @Test fun multiConnectionDownloadIsExact() {
        val engine = HttpEngine(SpeedLimiter(), "test")
        val out = File.createTempFile("sidm", ".bin")
        val segments = mutableListOf<Segment>()
        val result = engine.download("$base/file.bin", emptyMap(), out, data.size.toLong(), true, 4, segments, listener())
        assertEquals(Outcome.Finished, result)
        assertTrue(segments.size >= 4)
        assertContentEquals(data, out.readBytes())
        out.delete()
    }

    @Test fun pauseAndResume() {
        val engine = HttpEngine(SpeedLimiter(2L * 1024 * 1024), "test")
        val out = File.createTempFile("sidm", ".bin")
        val segments = mutableListOf<Segment>()
        val first = engine.download("$base/file.bin", emptyMap(), out, data.size.toLong(), true, 3, segments, listener(stopAfter = 1024 * 1024))
        assertEquals(Outcome.Stopped, first)
        val saved = Segment.formatList(segments)
        assertTrue(segments.sumOf { it.done } in 1..(data.size - 1).toLong())
        val restored = Segment.parseList(saved)
        val second = HttpEngine(SpeedLimiter(), "test")
            .download("$base/file.bin", emptyMap(), out, data.size.toLong(), true, 3, restored, listener())
        assertEquals(Outcome.Finished, second)
        assertContentEquals(data, out.readBytes())
        out.delete()
    }

    @Test fun singleConnectionWithoutSize() {
        val engine = HttpEngine(SpeedLimiter(), "test")
        val probe = engine.probe("$base/plain")
        assertEquals("notes.txt", probe.fileName)
        val out = File.createTempFile("sidm", ".txt")
        val result = engine.download("$base/plain", emptyMap(), out, probe.size, probe.acceptsRanges, 4, mutableListOf(), listener())
        assertEquals(Outcome.Finished, result)
        assertEquals("hello", out.readText())
    }

    @Test fun speedLimitHolds() {
        val limiter = SpeedLimiter(1024L * 1024)
        val start = System.nanoTime()
        repeat(32) { limiter.acquire(64 * 1024) } // 2 MiB at 1 MiB/s, first second is burst
        val secs = (System.nanoTime() - start) / 1e9
        assertTrue(secs in 0.8..3.0, "took $secs s")
    }

    @Test fun planSplitsEvenly() {
        val plan = Segment.plan(10L * 1024 * 1024, 4)
        assertEquals(4, plan.size)
        assertEquals(10L * 1024 * 1024 - 1, plan.last().end)
        assertEquals(1, Segment.plan(1000, 8).size)
    }
}
