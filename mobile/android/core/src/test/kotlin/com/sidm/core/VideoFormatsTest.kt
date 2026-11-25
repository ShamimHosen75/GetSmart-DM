package com.sidm.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class VideoFormatsTest {
    private val json = """
    {"id":"abc","title":"Sunset","extractor_key":"Instagram","webpage_url":"https://www.instagram.com/reel/abc/",
     "duration":31.5,"thumbnail":"https://t/1.jpg","formats":[
      {"format_id":"a1","vcodec":"none","acodec":"mp4a.40.2","tbr":128,"filesize":500000,"ext":"m4a"},
      {"format_id":"v360","vcodec":"avc1","acodec":"none","height":360,"tbr":500,"filesize":2000000},
      {"format_id":"v1080","vcodec":"avc1","acodec":"none","height":1080,"tbr":3000,"filesize_approx":9000000},
      {"format_id":"v720","vcodec":"avc1","acodec":"none","height":720,"tbr":1500},
      {"format_id":"sb0","vcodec":"none","acodec":"none","protocol":"mhtml"}
    ]}
    """

    @Test fun qualitiesHighestFirst() {
        val info = VideoFormats.parse(json, "https://instagram.com/reel/abc")
        assertEquals("Sunset", info.title)
        assertEquals(31, info.durationSec)
        val ids = info.qualities.map { it.id }
        assertEquals(listOf("best", "h720", "h360", "m4a", "mp3"), ids)
        assertEquals(1080, info.qualities.first().height)
        assertEquals(9500000, info.qualities.first().approxBytes)
        assertEquals("bv*+ba/b", info.qualities.first().selector)
    }

    @Test fun playlistTakesFirstEntry() {
        val playlist = """{"_type":"playlist","entries":[$json]}"""
        val info = VideoFormats.parse(playlist, "https://x")
        assertEquals("Sunset", info.title)
    }

    @Test fun drmFlag() {
        val info = VideoFormats.parse("""{"title":"t","formats":[{"format_id":"1","has_drm":true,"vcodec":"avc1","height":720}]}""", "https://x")
        assertTrue(info.hasDrm)
    }

    @Test fun args() {
        val q = Quality("mp3", "Audio", "ba/b", audioOnly = true, convertAudio = "mp3")
        val a = YtdlpArgs.forDownload(YtdlpArgs.Options("/out", q, 4, 1000, "/c.txt", null))
        assertTrue(a.containsAll(listOf("-x", "--audio-format", "mp3", "-r", "1000", "--cookies", "/c.txt")))
        // Same single video as the quality picker showed (forInfo reads item 1).
        assertEquals("1", a[a.indexOf("--playlist-items") + 1])
        assertEquals("1", YtdlpArgs.forInfo(null, null).let { it[it.indexOf("--playlist-items") + 1] })
        val p = YtdlpArgs.parseProgress("[download]  42.0% of ~  12.30MiB at  1.00MiB/s ETA 00:07")!!
        assertEquals(42.0f, p.first)
        assertEquals((12.30 * 1024 * 1024).toLong(), p.second)
    }
}
