package com.sidm.app

import android.util.Log
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Runs on an emulator in GitHub Actions (and on any phone with
 * ./gradlew connectedDebugAndroidTest). Checks that the app starts, the video
 * engine unpacks and runs, and a real file download lands in Downloads/SIDM.
 */
@RunWith(AndroidJUnit4::class)
class DeviceTest {
    @get:Rule
    val compose = createAndroidComposeRule<MainActivity>()

    private val app get() = ApplicationProvider.getApplicationContext<SidmApp>()

    @Test
    fun welcomeScreenShowsAndLanguageSwitches() {
        app.settings.update { it.copy(welcomeDone = false, language = "en") }
        compose.waitForIdle()
        compose.onNodeWithText("Welcome to SIDM").assertExists()
        compose.onNodeWithText("বাংলা").performClick()
        compose.waitForIdle()
        compose.onNodeWithText("SIDM-এ স্বাগতম").assertExists()
        app.settings.update { it.copy(welcomeDone = true, language = "en") }
        compose.waitForIdle()
        compose.onNodeWithText("Paste a link to download").assertExists()
    }

    @Test
    fun videoEngineStarts() = runBlocking {
        val ready = withTimeout(240_000) { app.engine.video.awaitReady() }
        assertTrue("video engine failed: ${app.engine.video.state.value}", ready)
        assertNotNull(app.engine.video.version.value)
        Log.i(TAG, "yt-dlp ${app.engine.video.version.value}")
    }

    @Test
    fun fileDownloadEndToEnd() = runBlocking {
        app.settings.update { it.copy(welcomeDone = true, wifiOnly = false) }
        val url = "https://raw.githubusercontent.com/ShamimHosen75/GetSmart-DM/main/site/assets/icon-128.png"
        val result = withTimeout(120_000) { app.engine.analyze(url) }
        assertTrue("expected a file, got $result", result is Analysis.FileLink)
        val item = app.engine.addFile(result as Analysis.FileLink)
        val done = waitFor(item.id, 120_000)
        assertEquals("download ended as ${done.status} ${done.error}", Status.DONE, done.status)
        assertTrue(Saver.exists(app, done.contentUri))
        assertTrue(done.fileName.endsWith(".png"))
        app.engine.remove(item.id, deleteFile = true)
    }

    @Test
    fun drmIsRefused() = runBlocking {
        val r = app.engine.analyze("https://www.netflix.com/watch/80100172")
        assertEquals(Analysis.Error("errDrm"), r)
    }

    /**
     * Real sites, report only: what yt-dlp on the phone finds behind public
     * test videos (the same ones yt-dlp's own tests use). Sites change and
     * sometimes block data-centre addresses, so this never fails the build;
     * the results are in the test log ("SIDM-SITES").
     */
    @Test
    fun realSitesReport() = runBlocking {
        assertTrue(withTimeout(240_000) { app.engine.video.awaitReady() })
        val sites = listOf(
            "Vimeo" to "https://vimeo.com/76979871",
            "Dailymotion" to "https://www.dailymotion.com/video/x5kesuj",
            "YouTube" to "https://www.youtube.com/watch?v=BaW_jenozKc",
            "Reddit" to "https://www.reddit.com/r/videos/comments/6rrwyj/that_small_heart_attack/",
            "TikTok" to "https://www.tiktok.com/@leenabhushan/video/6748451240264420610",
            "X" to "https://x.com/SpaceX/status/1585841080431321088",
            "Facebook" to "https://www.facebook.com/watch/?v=274175099429670",
            "Instagram" to "https://www.instagram.com/reel/Chunk8-jurw/",
            "LinkedIn" to "https://www.linkedin.com/posts/mishalkhawaja_sendinblueviews-toronto-digitalmarketing-ugcPost-6850898786781339649-mM20",
        )
        val lines = mutableListOf<String>()
        for ((name, url) in sites) {
            val r = runCatching { withTimeout(90_000) { app.engine.analyze(url) } }.getOrElse { Analysis.Error("timeout") }
            val line = when (r) {
                is Analysis.Video -> "OK    $name: \"${r.info.title}\" qualities=${r.info.qualities.joinToString { it.id }}"
                is Analysis.FileLink -> "FILE  $name: ${r.probe.fileName}"
                is Analysis.Error -> "FAIL  $name: ${r.code.take(200)}"
            }
            Log.i("SIDM-SITES", line)
            lines += line
        }
        // One full video download (lowest quality, to keep it quick): Vimeo, else Dailymotion.
        for ((name, url) in sites.take(2)) {
            val r = runCatching { withTimeout(90_000) { app.engine.analyze(url) } }.getOrNull() as? Analysis.Video ?: continue
            val q = r.info.qualities.filter { !it.audioOnly && it.height > 0 }.minByOrNull { it.height } ?: r.info.qualities.first()
            val item = app.engine.addVideo(r, q, q.label)
            val done = waitFor(item.id, 300_000)
            val line = "DOWNLOAD $name ${q.label}: ${done.status} ${done.fileName} ${done.doneBytes} bytes ${done.error ?: ""}"
            Log.i("SIDM-SITES", line)
            lines += line
            app.engine.remove(item.id, deleteFile = true)
            break
        }
        InstrumentationRegistry.getInstrumentation().sendStatus(0, android.os.Bundle().apply {
            putString(android.app.Instrumentation.REPORT_KEY_STREAMRESULT, "\nSIDM-SITES\n" + lines.joinToString("\n") + "\n")
        })
    }

    private suspend fun waitFor(id: String, timeoutMs: Long): DownloadItem {
        val end = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < end) {
            val item = app.engine.store.get(id)!!
            if (item.status == Status.DONE || item.status == Status.FAILED) return item
            delay(500)
        }
        return app.engine.store.get(id)!!
    }

    companion object {
        private const val TAG = "SIDM-TEST"
    }
}

