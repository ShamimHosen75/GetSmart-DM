package com.sidm.app.ui

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.sidm.app.BuildConfig
import com.sidm.app.SidmApp
import com.sidm.app.Updates
import com.sidm.app.t
import kotlinx.coroutines.launch

@Composable
fun AboutScreen(app: SidmApp, onBack: () -> Unit) {
    val context = LocalContext.current
    val state by app.updates.app.collectAsState()
    val site = app.updates.siteUrl

    fun open(url: String) {
        runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
    }

    Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background).safeDrawingPadding()) {
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = onBack) { Icon(Icons.Filled.ArrowBack, t("aboutBack")) }
                Text(t("setAbout"), style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
            }
            Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
                Box(
                    Modifier.size(72.dp).clip(RoundedCornerShape(20.dp))
                        .background(Brush.verticalGradient(listOf(Color(0xFF7C4DFF), Color(0xFF5E35B1)))),
                    contentAlignment = Alignment.Center,
                ) { Icon(SidmIcons.Download, null, tint = Color.White, modifier = Modifier.size(40.dp)) }
                Spacer(Modifier.height(8.dp))
                Text("SIDM - Smart Internet Download Manager", fontWeight = FontWeight.SemiBold)
                Text(t("tagline"), color = MaterialTheme.colorScheme.primary)
                Text(t("aboutVersion", BuildConfig.VERSION_NAME), color = MaterialTheme.colorScheme.onSurfaceVariant)
            }

            Section(t("aboutCheck")) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    when (val s = state) {
                        is Updates.AppState.Available -> {
                            Text(t("aboutUpdate", s.version), fontWeight = FontWeight.SemiBold)
                            Text(t("aboutUpdateBody"), color = MaterialTheme.colorScheme.onSurfaceVariant)
                            Button(onClick = { app.appScope.launch { app.updates.downloadAndInstall(s.version) } }) { Text(t("aboutInstall")) }
                        }
                        is Updates.AppState.Downloading -> Text(t("aboutDownloadingUpdate", "${s.percent}%"))
                        Updates.AppState.Checking -> Text(t("aboutChecking"))
                        Updates.AppState.UpToDate -> Text(t("aboutUpToDate"))
                        Updates.AppState.NoSite -> Text(t("aboutNoSite"))
                        Updates.AppState.NeedsPermission -> Text(t("aboutAllowInstall"))
                        is Updates.AppState.Failed -> Text(t("errNetwork", s.message), color = MaterialTheme.colorScheme.error)
                        Updates.AppState.Idle -> Unit
                    }
                    if (state !is Updates.AppState.Available && state !is Updates.AppState.Downloading) {
                        OutlinedButton(onClick = { app.appScope.launch { app.updates.checkApp() } }) { Text(t("aboutCheck")) }
                    }
                    if (state is Updates.AppState.NeedsPermission) {
                        val v = app.settings.value.latestAppVersion
                        if (v != null) Button(onClick = { app.appScope.launch { app.updates.downloadAndInstall(v) } }) { Text(t("aboutInstall")) }
                    }
                }
            }

            Section(t("aboutWebsite")) {
                if (site.isNotEmpty()) {
                    LinkRow(t("aboutWebsite")) { open(site) }
                    HorizontalDivider()
                    LinkRow(t("aboutPrivacy")) { open("$site/privacy.html") }
                    HorizontalDivider()
                    LinkRow(t("aboutTerms")) { open("$site/terms.html") }
                    HorizontalDivider()
                }
                LinkRow(t("aboutSource")) { open(BuildConfig.SOURCE_URL) }
            }

            Section(t("aboutLicenses")) {
                Text(t("aboutLicensesBody"), Modifier.padding(16.dp), style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}

@Composable
private fun LinkRow(text: String, onClick: () -> Unit) {
    Text(text, Modifier.fillMaxWidth().clickable(onClick = onClick).padding(16.dp), color = MaterialTheme.colorScheme.primary)
}
