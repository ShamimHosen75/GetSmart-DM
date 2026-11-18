package com.sidm.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class LinksTest {
    @Test fun drmSitesAreRefused() {
        assertTrue(Links.isDrm("https://www.netflix.com/watch/123"))
        assertTrue(Links.isDrm("https://open.spotify.com/track/1"))
        assertFalse(Links.isDrm("https://www.instagram.com/reel/abc/"))
        assertFalse(Links.isDrm("https://notnetflix.com/"))
    }

    @Test fun youTube() {
        assertTrue(Links.isYouTube("https://youtu.be/xyz"))
        assertTrue(Links.isYouTube("https://m.youtube.com/watch?v=1"))
        assertFalse(Links.isYouTube("https://vimeo.com/1"))
    }

    @Test fun firstLinkFromSharedText() {
        assertEquals("https://www.instagram.com/reel/abc/?igsh=x", Links.firstLink("Look at this! https://www.instagram.com/reel/abc/?igsh=x"))
        assertEquals("https://vt.tiktok.com/ZS123/", Links.firstLink("https://vt.tiktok.com/ZS123/."))
        assertNull(Links.firstLink("no link here"))
    }

    @Test fun files() {
        assertTrue(Links.looksLikeFile("https://cdn.example.com/a/b/movie.MP4?token=1"))
        assertTrue(Links.looksLikeStream("https://x.com/master.m3u8"))
        assertFalse(Links.looksLikeFile("https://www.facebook.com/watch/?v=1"))
        assertEquals("my file.pdf", Links.fileNameFromUrl("https://e.com/docs/my%20file.pdf"))
        assertNull(Links.fileNameFromUrl("https://e.com/"))
    }

    @Test fun fileNames() {
        assertEquals("a_b_c.mp4", FileNames.clean("a/b:c.mp4"))
        assertEquals("report 2024.pdf", FileNames.fromContentDisposition("attachment; filename=\"report 2024.pdf\""))
        assertEquals("ফাইল.zip", FileNames.fromContentDisposition("attachment; filename*=UTF-8''%E0%A6%AB%E0%A6%BE%E0%A6%87%E0%A6%B2.zip"))
        assertEquals("video.mp4", FileNames.withExtension("video", "video/mp4"))
        assertEquals(150, FileNames.clean("x".repeat(300) + ".mp4").length)
        assertTrue(FileNames.clean("x".repeat(300) + ".mp4").endsWith(".mp4"))
        assertEquals(FileNames.Kind.VIDEO, FileNames.kindOf("a.webm"))
    }

    @Test fun cookies() {
        val text = CookieFile.netscape("https://www.instagram.com/p/1/", "sessionid=abc; csrftoken=x", 2000000000)
        assertTrue(text.contains(".instagram.com\tTRUE\t/\tTRUE\t2000000000\tsessionid\tabc"))
        assertEquals("bbc.co.uk", CookieFile.mainDomain("news.bbc.co.uk"))
        assertEquals("facebook.com", CookieFile.mainDomain("m.facebook.com"))
    }

    @Test fun versionsAndUnits() {
        assertTrue(Versions.compare("0.5.0", "0.4.10") > 0)
        assertEquals(0, Versions.compare("1.0.0", "1.0"))
        assertEquals("0.5.0", Versions.fromVersionJson("{\"version\": \"0.5.0\"}"))
        assertEquals("1.5 MB", Units.bytes(1572864))
        assertEquals("1:01:05", Units.duration(3665))
    }
}
