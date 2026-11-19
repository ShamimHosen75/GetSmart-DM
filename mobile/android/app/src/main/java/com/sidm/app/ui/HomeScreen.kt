package com.sidm.app.ui

import android.content.ClipboardManager
import android.content.Context
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
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Clear
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.sidm.app.DownloadItem
import com.sidm.app.SidmApp
import com.sidm.app.Updates
import com.sidm.app.VideoTools
import com.sidm.app.t

@Composable
fun HomeScreen(app: SidmApp, model: AppModel, items: List<DownloadItem>) {
    val context = LocalContext.current
    val focus = LocalFocusManager.current
    val engineState by app.engine.video.state.collectAsState()
    val appUpdate by app.updates.app.collectAsState()

    fun go() {
        focus.clearFocus()
        model.analyze(model.link)
    }

    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        // Brand header
        Box(
            Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(20.dp))
                .background(Brush.linearGradient(listOf(Color(0xFF7C4DFF), Color(0xFF5E35B1))))
                .padding(20.dp),
        ) {
            Column {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(SidmIcons.Download, null, tint = Color.White, modifier = Modifier.size(28.dp))
                    Spacer(Modifier.width(8.dp))
                    Text(t("appName"), color = Color.White, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
                }
                Spacer(Modifier.height(4.dp))
                Text(t("tagline"), color = Color.White.copy(alpha = 0.85f), style = MaterialTheme.typography.bodyMedium)
            }
        }

        val update = appUpdate
        if (update is Updates.AppState.Available) {
            Card(
                Modifier.fillMaxWidth().clickable { model.showAbout = true },
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.secondaryContainer),
            ) {
                Text(t("aboutUpdate", update.version), Modifier.padding(16.dp), fontWeight = FontWeight.SemiBold)
            }
        }

        Text(t("homeTitle"), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
        OutlinedTextField(
            value = model.link,
            onValueChange = { model.link = it },
            modifier = Modifier.fillMaxWidth(),
            placeholder = { Text(t("homeHint")) },
            singleLine = true,
            shape = RoundedCornerShape(14.dp),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Go),
            keyboardActions = KeyboardActions(onGo = { go() }),
            trailingIcon = {
                if (model.link.isNotEmpty()) {
                    IconButton(onClick = { model.link = ""; model.cancelAnalysis() }) { Icon(Icons.Filled.Clear, t("homeClear")) }
                } else {
                    IconButton(onClick = {
                        val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                        val text = cm.primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.coerceToText(context)?.toString()
                        if (!text.isNullOrBlank()) model.link = text.trim()
                    }) { Icon(SidmIcons.Paste, t("homePaste")) }
                }
            },
        )
        Button(
            onClick = { go() },
            enabled = model.link.isNotBlank() && !model.analyzing,
            modifier = Modifier.fillMaxWidth().height(52.dp),
            shape = RoundedCornerShape(14.dp),
        ) {
            Icon(SidmIcons.Download, null)
            Spacer(Modifier.width(8.dp))
            Text(t("homeDownload"), style = MaterialTheme.typography.titleMedium)
        }

        if (model.analyzing) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                Spacer(Modifier.width(12.dp))
                Text(
                    if (engineState is VideoTools.State.Starting) t("homeEngineStarting") else t("homeAnalyzing"),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.weight(1f),
                )
                TextButton(onClick = { model.cancelAnalysis() }) { Text(t("cancel")) }
            }
        }

        val recent = items.take(3)
        if (recent.isNotEmpty()) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(t("homeRecent"), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                TextButton(onClick = { model.tab = Tab.DOWNLOADS }) { Text(t("homeSeeAll")) }
            }
            recent.forEach { DownloadRow(app, model, it, compact = true) }
        }

        Card(
            Modifier.fillMaxWidth(),
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainer),
        ) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(t("homeTipsTitle"), fontWeight = FontWeight.SemiBold)
                Tip(t("homeTipShare"))
                Tip(t("homeTipBrowser"))
                Tip(t("homeTipFolder"))
            }
        }
    }
}

@Composable
private fun Tip(text: String) {
    Row {
        Box(
            Modifier
                .padding(top = 7.dp)
                .size(6.dp)
                .clip(RoundedCornerShape(3.dp))
                .background(MaterialTheme.colorScheme.secondary),
        )
        Spacer(Modifier.width(10.dp))
        Text(text, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}
