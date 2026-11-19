@file:OptIn(ExperimentalMaterial3Api::class)

package com.sidm.app.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.sidm.app.Analysis
import com.sidm.app.LocalLang
import com.sidm.app.SidmApp
import com.sidm.app.Strings
import com.sidm.app.t
import com.sidm.core.Quality
import com.sidm.core.Units
import com.sidm.core.VideoFormats

/** The quality picker, the "download this file?" sheet and error messages, for Home and the browser alike. */
@Composable
fun ResultSheets(app: SidmApp, model: AppModel) {
    when (val r = model.result) {
        is Analysis.Video -> QualitySheet(r, model)
        is Analysis.FileLink -> FileSheet(r, model)
        is Analysis.Error -> ErrorDialog(r.code, model)
        null -> Unit
    }
}

/** The label a quality shows in the user's language. */
@Composable
fun qualityLabel(q: Quality): String = when {
    q.id == VideoFormats.BEST_ID && q.height > 0 -> "${VideoFormats.label(q.height)} · ${t("qualityBest")}"
    q.id == VideoFormats.BEST_ID -> t("qualityBest")
    q.id == "m4a" -> t("qualityAudioM4a")
    q.id == "mp3" -> t("qualityAudioMp3")
    else -> VideoFormats.label(q.height)
}

@Composable
private fun QualitySheet(v: Analysis.Video, model: AppModel) {
    val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    var selected by remember(v) { mutableStateOf(v.info.qualities.first()) }
    val labels = v.info.qualities.associateWith { qualityLabel(it) }
    ModalBottomSheet(onDismissRequest = { model.result = null }, sheetState = sheet) {
        Column(
            Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 20.dp)
                .navigationBarsPadding(),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(v.info.title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold, maxLines = 3, overflow = TextOverflow.Ellipsis)
            val meta = listOfNotNull(v.info.site.takeIf { it.isNotBlank() }, v.info.durationSec.takeIf { it > 0 }?.let { Units.duration(it) })
            if (meta.isNotEmpty()) Text(meta.joinToString(" · "), color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall)
            if (v.info.entries > 1) Text(t("qualityMore", v.info.entries), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Spacer(Modifier.height(4.dp))
            Text(t("qualityTitle"), fontWeight = FontWeight.SemiBold)
            v.info.qualities.forEach { q ->
                val isSel = q == selected
                Surface(
                    shape = RoundedCornerShape(12.dp),
                    border = BorderStroke(if (isSel) 2.dp else 1.dp, if (isSel) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outline),
                    color = if (isSel) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surface,
                    modifier = Modifier.fillMaxWidth().clickable { selected = q },
                ) {
                    Row(Modifier.padding(horizontal = 8.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                        RadioButton(selected = isSel, onClick = { selected = q })
                        Icon(if (q.audioOnly) SidmIcons.Music else SidmIcons.Video, null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
                        Spacer(Modifier.width(10.dp))
                        Text(labels[q] ?: q.label, modifier = Modifier.weight(1f), fontWeight = if (isSel) FontWeight.SemiBold else FontWeight.Normal)
                        if (q.approxBytes > 0) {
                            Text(t("qualityAbout", Units.bytes(q.approxBytes)), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            Spacer(Modifier.width(8.dp))
                        }
                    }
                }
            }
            Spacer(Modifier.height(8.dp))
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                TextButton(onClick = { model.result = null }, modifier = Modifier.weight(1f)) { Text(t("cancel")) }
                Button(
                    onClick = { model.downloadVideo(v, selected, labels[selected] ?: selected.label) },
                    modifier = Modifier.weight(2f).height(48.dp),
                    shape = RoundedCornerShape(12.dp),
                ) {
                    Icon(SidmIcons.Download, null)
                    Spacer(Modifier.width(8.dp))
                    Text(t("download"))
                }
            }
            Spacer(Modifier.height(16.dp))
        }
    }
}

@Composable
private fun FileSheet(f: Analysis.FileLink, model: AppModel) {
    val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(onDismissRequest = { model.result = null }, sheetState = sheet) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp).navigationBarsPadding(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(t("fileTitle"), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(fileIcon(f.probe.fileName ?: ""), null, tint = MaterialTheme.colorScheme.primary)
                Spacer(Modifier.width(12.dp))
                Column(Modifier.weight(1f)) {
                    Text(f.probe.fileName ?: f.url, maxLines = 2, overflow = TextOverflow.Ellipsis, fontWeight = FontWeight.Medium)
                    Text(
                        if (f.probe.size > 0) t("fileSize", Units.bytes(f.probe.size)) else t("fileSizeUnknown"),
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                TextButton(onClick = { model.result = null }, modifier = Modifier.weight(1f)) { Text(t("cancel")) }
                Button(onClick = { model.downloadFile(f) }, modifier = Modifier.weight(2f).height(48.dp), shape = RoundedCornerShape(12.dp)) {
                    Icon(SidmIcons.Download, null)
                    Spacer(Modifier.width(8.dp))
                    Text(t("download"))
                }
            }
            Spacer(Modifier.height(16.dp))
        }
    }
}

@Composable
private fun ErrorDialog(code: String, model: AppModel) {
    val lang = LocalLang.current
    val needsBrowser = code == "errLogin" || code == "errUnsupported" || code == "errWebPage"
    AlertDialog(
        onDismissRequest = { model.result = null },
        text = { Text(Strings.error(lang, code)) },
        confirmButton = {
            TextButton(onClick = { model.result = null }) { Text(t("ok")) }
        },
        dismissButton = if (needsBrowser && model.link.isNotBlank()) {
            {
                TextButton(onClick = {
                    model.result = null
                    model.browserUrl = model.link
                    model.tab = Tab.BROWSER
                }) { Text(t("navBrowser")) }
            }
        } else null,
    )
}
