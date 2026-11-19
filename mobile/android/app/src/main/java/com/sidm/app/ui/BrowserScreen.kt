@file:OptIn(ExperimentalMaterial3Api::class)

package com.sidm.app.ui

import android.annotation.SuppressLint
import android.graphics.Bitmap
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.URLUtil
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import com.sidm.app.SidmApp
import com.sidm.app.t
import com.sidm.core.Links
import java.net.URLEncoder

private val QUICK_SITES = listOf(
    "Facebook" to "https://m.facebook.com/",
    "Instagram" to "https://www.instagram.com/",
    "TikTok" to "https://www.tiktok.com/",
    "X" to "https://x.com/",
    "YouTube" to "https://m.youtube.com/",
    "LinkedIn" to "https://www.linkedin.com/",
    "Reddit" to "https://www.reddit.com/",
    "Vimeo" to "https://vimeo.com/",
    "Dailymotion" to "https://www.dailymotion.com/",
    "Pinterest" to "https://www.pinterest.com/",
)

/** Media the page loads that SIDM can save: video/audio files and streaming playlists. Not YouTube's scrambled pieces. */
private fun isMedia(url: String): Boolean {
    if (!url.startsWith("http")) return false
    val host = Links.hostOf(url)
    if (host.endsWith("googlevideo.com") || Links.isDrm(url)) return false
    if (Links.looksLikeStream(url)) return true
    return Links.extensionOf(url) in setOf("mp4", "m4v", "webm", "mov", "mp3", "m4a", "aac", "ogg", "opus")
}

private fun toAddress(input: String): String {
    val text = input.trim()
    if (Links.isWebLink(text)) return text
    if (!text.contains(' ') && text.contains('.')) return "https://$text"
    return "https://www.google.com/search?q=" + URLEncoder.encode(text, "UTF-8")
}

@SuppressLint("SetJavaScriptEnabled")
private fun createWebView(context: android.content.Context, app: SidmApp, model: AppModel): WebView = WebView(context).apply {
    settings.javaScriptEnabled = true
    settings.domStorageEnabled = true
    settings.mediaPlaybackRequiresUserGesture = true
    settings.loadWithOverviewMode = true
    settings.useWideViewPort = true
    settings.setSupportZoom(true)
    settings.builtInZoomControls = true
    settings.displayZoomControls = false
    CookieManager.getInstance().setAcceptCookie(true)
    CookieManager.getInstance().setAcceptThirdPartyCookies(this, true)
    webChromeClient = object : WebChromeClient() {
        override fun onProgressChanged(view: WebView, newProgress: Int) {
            model.pageLoading = newProgress
        }
    }
    webViewClient = object : WebViewClient() {
        override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
            if (url != model.pageUrl) model.found.clear()
            model.pageUrl = url
        }

        override fun doUpdateVisitedHistory(view: WebView, url: String, isReload: Boolean) {
            if (url != model.pageUrl) {
                model.found.clear()
                model.pageUrl = url
            }
            model.canGoBack = view.canGoBack()
        }

        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
            val u = request.url.toString()
            if (isMedia(u)) {
                view.post { if (u !in model.found) model.found.add(u) }
            }
            return null
        }

        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val scheme = request.url.scheme ?: return false
            // Only web pages open here; app links (intent:, market:) are ignored instead of leaving SIDM.
            return scheme != "http" && scheme != "https"
        }
    }
    // A page's own download links (a "Download" button on a site) are saved by SIDM.
    setDownloadListener { url, _, contentDisposition, mimeType, contentLength ->
        if (Links.isDrm(url)) return@setDownloadListener
        val name = URLUtil.guessFileName(url, contentDisposition, mimeType)
        app.engine.addBrowserDownload(url, name, mimeType, contentLength, model.pageUrl.ifBlank { null })
        model.toast = "brFileCaught" to listOf(name)
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun BrowserScreen(app: SidmApp, model: AppModel) {
    val focus = LocalFocusManager.current
    var address by remember { mutableStateOf(model.pageUrl) }
    var showFound by remember { mutableStateOf(false) }
    val onPage = model.pageUrl.startsWith("http")

    fun load(input: String) {
        focus.clearFocus()
        val url = toAddress(input)
        address = url
        model.pageUrl = url
        model.webView?.loadUrl(url)
    }

    LaunchedEffect(model.pageUrl) { address = model.pageUrl }
    LaunchedEffect(model.browserUrl) {
        model.browserUrl?.let {
            model.browserUrl = null
            load(it)
        }
    }
    BackHandler(enabled = model.canGoBack) { model.webView?.goBack() }

    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = { model.webView?.goBack() }, enabled = model.canGoBack) { Icon(Icons.Filled.ArrowBack, t("brBack")) }
            OutlinedTextField(
                value = address,
                onValueChange = { address = it },
                modifier = Modifier.weight(1f),
                placeholder = { Text(t("brHint"), maxLines = 1) },
                singleLine = true,
                shape = RoundedCornerShape(24.dp),
                textStyle = MaterialTheme.typography.bodyMedium,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Go),
                keyboardActions = KeyboardActions(onGo = { if (address.isNotBlank()) load(address) }),
            )
            if (onPage) {
                IconButton(onClick = { model.webView?.reload() }) { Icon(Icons.Filled.Refresh, t("brReload")) }
                IconButton(onClick = {
                    model.webView?.stopLoading()
                    model.webView?.loadUrl("about:blank")
                    model.pageUrl = ""
                    model.found.clear()
                    model.canGoBack = false
                }) { Icon(Icons.Filled.Home, t("brHomePage")) }
            }
        }
        if (onPage && model.pageLoading in 1..99) {
            LinearProgressIndicator(progress = { model.pageLoading / 100f }, modifier = Modifier.fillMaxWidth())
        }
        Box(Modifier.weight(1f).fillMaxWidth()) {
            AndroidView(
                factory = { ctx ->
                    val wv = model.webView ?: createWebView(ctx, app, model).also { model.webView = it }
                    (wv.parent as? ViewGroup)?.removeView(wv)
                    wv
                },
                modifier = Modifier.fillMaxSize(),
            )
            if (!onPage) {
                Column(
                    Modifier
                        .fillMaxSize()
                        .background(MaterialTheme.colorScheme.background)
                        .padding(16.dp)
                        .verticalScroll(rememberScrollState()),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primaryContainer)) {
                        Column(Modifier.padding(16.dp)) {
                            Text(t("brStartTitle"), fontWeight = FontWeight.SemiBold, style = MaterialTheme.typography.titleMedium)
                            Spacer(Modifier.height(4.dp))
                            Text(t("brStartBody"), style = MaterialTheme.typography.bodyMedium)
                        }
                    }
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        QUICK_SITES.forEach { (name, url) -> AssistChip(onClick = { load(url) }, label = { Text(name) }) }
                    }
                }
            } else {
                val drm = Links.isDrm(model.pageUrl)
                ExtendedFloatingActionButton(
                    onClick = {
                        when {
                            drm -> model.toast = "brDrm" to emptyList()
                            model.found.isEmpty() -> model.analyze(model.pageUrl)
                            else -> showFound = true
                        }
                    },
                    icon = { Icon(SidmIcons.Download, null) },
                    text = { Text(if (model.found.isEmpty()) t("download") else "${t("download")} (${model.found.size})") },
                    containerColor = if (drm) MaterialTheme.colorScheme.surfaceVariant else MaterialTheme.colorScheme.primary,
                    contentColor = if (drm) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onPrimary,
                    modifier = Modifier.align(Alignment.BottomEnd).padding(16.dp),
                )
            }
        }
    }

    if (showFound) {
        val sheet = rememberModalBottomSheetState()
        ModalBottomSheet(onDismissRequest = { showFound = false }, sheetState = sheet) {
            Column(Modifier.fillMaxWidth().padding(bottom = 16.dp).navigationBarsPadding()) {
                Text(t("brFoundTitle"), fontWeight = FontWeight.SemiBold, style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp))
                FoundRow(t("brPageVideo"), Links.hostOf(model.pageUrl), SidmIcons.Video) {
                    showFound = false
                    model.analyze(model.pageUrl)
                }
                HorizontalDivider()
                Text(t("brFound", model.found.size), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp))
                model.found.toList().reversed().take(30).forEach { u ->
                    FoundRow(Links.fileNameFromUrl(u) ?: u, Links.hostOf(u), if (Links.extensionOf(u) in setOf("mp3", "m4a", "aac", "ogg", "opus")) SidmIcons.Music else SidmIcons.Video) {
                        showFound = false
                        model.analyze(u, referer = model.pageUrl)
                    }
                }
            }
        }
    }
}

@Composable
private fun FoundRow(title: String, sub: String, icon: androidx.compose.ui.graphics.vector.ImageVector, onClick: () -> Unit) {
    Row(Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 20.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(icon, null, tint = MaterialTheme.colorScheme.primary)
        Spacer(Modifier.width(14.dp))
        Column(Modifier.weight(1f)) {
            Text(title, maxLines = 1, overflow = TextOverflow.Ellipsis, fontWeight = FontWeight.Medium)
            Text(sub, maxLines = 1, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}
