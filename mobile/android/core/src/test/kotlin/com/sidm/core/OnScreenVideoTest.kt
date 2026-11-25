package com.sidm.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class OnScreenVideoTest {
    @Test fun videoPagesAreRecognised() {
        listOf(
            "https://m.youtube.com/watch?v=abc123",
            "https://www.youtube.com/shorts/abc123",
            "https://youtu.be/abc123",
            "https://m.facebook.com/reel/1234567890",
            "https://www.facebook.com/watch/?v=1234567890",
            "https://www.facebook.com/someone/videos/1234567890/",
            "https://www.facebook.com/share/r/AbCdEf/",
            "https://fb.watch/abcDEF/",
            "https://www.instagram.com/reel/C1abc/",
            "https://www.instagram.com/p/C1abc/",
            "https://www.tiktok.com/@someone/video/7300000000000000000",
            "https://x.com/someone/status/1800000000000000000",
            "https://vimeo.com/123456789",
            "https://www.dailymotion.com/video/x8abcd",
            "https://www.reddit.com/r/videos/comments/abc/title/",
        ).forEach { assertTrue(OnScreenVideo.isVideoPermalink(it), it) }
    }

    @Test fun feedsAndProfilesAreNotVideoPages() {
        listOf(
            "https://m.youtube.com/",
            "https://m.facebook.com/",
            "https://www.instagram.com/",
            "https://www.instagram.com/someone/",
            "https://x.com/home",
            "https://x.com/someone",
            "https://www.tiktok.com/foryou",
            "https://www.tiktok.com/@someone",
            "https://vimeo.com/channels",
            "blob:https://www.instagram.com/1234",
        ).forEach { assertFalse(OnScreenVideo.isVideoPermalink(it), it) }
    }

    @Test fun feedTakesTheLinkAroundTheVideoOnScreen() {
        // A home feed: the clicked post's own link is close to its video; other posts are further up.
        val levels = listOf(
            emptyList(),
            listOf("https://x.com/someone", "https://x.com/someone/status/111"),
            listOf("https://x.com/someone", "https://x.com/someone/status/111", "https://x.com/other/status/222"),
        )
        assertEquals(OnScreenVideo.Target("https://x.com/someone/status/111", false), OnScreenVideo.pick("https://x.com/home", levels, "blob:https://x.com/9"))
    }

    @Test fun youTubeHomePreviewIsTheClickedVideoNotThePage() {
        val levels = listOf(emptyList(), listOf("https://m.youtube.com/watch?v=CLICKED#t=1"))
        assertEquals(OnScreenVideo.Target("https://m.youtube.com/watch?v=CLICKED", false), OnScreenVideo.pick("https://m.youtube.com/", levels, "blob:x"))
    }

    @Test fun videoPageIsUsedWhenNoLinkIsCloseToThePlayer() {
        val far = List(6) { emptyList<String>() } + listOf(listOf("https://m.youtube.com/watch?v=RELATED"))
        assertEquals(OnScreenVideo.Target("https://m.youtube.com/watch?v=MAIN", false), OnScreenVideo.pick("https://m.youtube.com/watch?v=MAIN", far, "blob:x"))
        // On a feed page the further link is still better than nothing.
        assertEquals(OnScreenVideo.Target("https://m.youtube.com/watch?v=RELATED", false), OnScreenVideo.pick("https://m.youtube.com/", far, "blob:x"))
    }

    @Test fun plainVideoFileWhenThereIsNoVideoPage() {
        assertEquals(
            OnScreenVideo.Target("https://cdn.example.com/clip.mp4", true),
            OnScreenVideo.pick("https://example.com/", listOf(listOf("https://example.com/about")), "https://cdn.example.com/clip.mp4"),
        )
        assertNull(OnScreenVideo.pick("https://example.com/", listOf(emptyList()), "blob:https://example.com/1"))
        assertNull(OnScreenVideo.pick("https://example.com/", emptyList(), ""))
    }

    @Test fun readsTheScriptResult() {
        val json = """{"src":"blob:https://www.instagram.com/1","levels":[[],["https://www.instagram.com/someone/","https://www.instagram.com/reel/AAA/"]]}"""
        assertEquals(OnScreenVideo.Target("https://www.instagram.com/reel/AAA/", false), OnScreenVideo.fromScript(json, "https://www.instagram.com/"))
        assertNull(OnScreenVideo.fromScript("null", "https://www.instagram.com/"))
        assertNull(OnScreenVideo.fromScript("""{"src":"","levels":[]}""", "https://www.instagram.com/"))
    }
}
