package com.sidm.app.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.sidm.app.Analysis
import com.sidm.app.SidmApp
import com.sidm.core.Links
import com.sidm.core.Quality
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

enum class Tab { HOME, BROWSER, DOWNLOADS, SETTINGS }

/** Screen state that outlives a single screen: the current tab, the link being looked at, the sheet on top. */
class AppModel(private val app: SidmApp) {
    var tab by mutableStateOf(Tab.HOME)
    var showAbout by mutableStateOf(false)
    var link by mutableStateOf("")
    var analyzing by mutableStateOf(false)
    var result by mutableStateOf<Analysis?>(null)
    /** A short message at the bottom of the screen (a message key with its arguments). */
    var toast by mutableStateOf<Pair<String, List<Any>>?>(null)
    /** A page the browser should open (from a "sign in" hint). */
    var browserUrl by mutableStateOf<String?>(null)
    private var job: Job? = null

    // The browser tab. The WebView lives here so switching tabs keeps the page.
    var webView: android.webkit.WebView? = null
    var pageUrl by mutableStateOf("")
    var pageLoading by mutableStateOf(0)
    var canGoBack by mutableStateOf(false)
    /** Video and audio addresses the open page loaded (plain files and HLS/DASH playlists). */
    val found = androidx.compose.runtime.mutableStateListOf<String>()

    /** Looks at a link (pasted, shared, or the page open in the browser). */
    fun analyze(raw: String, referer: String? = null) {
        val url = Links.firstLink(raw) ?: raw.trim()
        if (!Links.isWebLink(url)) {
            result = Analysis.Error("homeNoLink")
            return
        }
        link = url
        job?.cancel()
        analyzing = true
        result = null
        job = app.appScope.launch {
            val r = app.engine.analyze(url, referer)
            analyzing = false
            if (r is Analysis.Video && app.settings.value.alwaysBest) {
                val best = r.info.qualities.first()
                app.engine.addVideo(r, best, best.label)
                toast = "added" to emptyList()
                tab = Tab.DOWNLOADS
            } else {
                result = r
            }
        }
    }

    fun cancelAnalysis() {
        job?.cancel()
        analyzing = false
        result = null
    }

    fun downloadVideo(v: Analysis.Video, q: Quality, label: String) {
        app.engine.addVideo(v, q, label)
        result = null
        toast = "added" to emptyList()
        tab = Tab.DOWNLOADS
    }

    fun downloadFile(f: Analysis.FileLink) {
        app.engine.addFile(f)
        result = null
        toast = "added" to emptyList()
        tab = Tab.DOWNLOADS
    }
}
