package com.sidm.app.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.sidm.app.DownloadItem
import com.sidm.app.Kind
import com.sidm.app.LocalLang
import com.sidm.app.Saver
import com.sidm.app.SidmApp
import com.sidm.app.Status
import com.sidm.app.Strings
import com.sidm.app.t
import com.sidm.core.FileNames
import com.sidm.core.Units

private enum class Filter(val key: String) { ALL("dlFilterAll"), VIDEO("dlFilterVideo"), MUSIC("dlFilterMusic"), DOCS("dlFilterDocs"), OTHER("dlFilterOther") }

private fun DownloadItem.kindOf(): FileNames.Kind =
    if (kind == Kind.VIDEO && !audioOnly && status != Status.DONE) FileNames.Kind.VIDEO
    else if (kind == Kind.VIDEO && audioOnly && status != Status.DONE) FileNames.Kind.MUSIC
    else FileNames.kindOf(fileName)

private fun matches(item: DownloadItem, f: Filter) = when (f) {
    Filter.ALL -> true
    Filter.VIDEO -> item.kindOf() == FileNames.Kind.VIDEO
    Filter.MUSIC -> item.kindOf() == FileNames.Kind.MUSIC
    Filter.DOCS -> item.kindOf() == FileNames.Kind.DOCUMENT
    Filter.OTHER -> item.kindOf() !in setOf(FileNames.Kind.VIDEO, FileNames.Kind.MUSIC, FileNames.Kind.DOCUMENT)
}

fun fileIcon(name: String): ImageVector = when (FileNames.kindOf(name)) {
    FileNames.Kind.VIDEO -> SidmIcons.Video
    FileNames.Kind.MUSIC -> SidmIcons.Music
    FileNames.Kind.DOCUMENT -> SidmIcons.Doc
    FileNames.Kind.ARCHIVE, FileNames.Kind.PROGRAM -> SidmIcons.Archive
    FileNames.Kind.IMAGE -> SidmIcons.Image
    FileNames.Kind.OTHER -> SidmIcons.File
}

@Composable
fun DownloadsScreen(app: SidmApp, model: AppModel, items: List<DownloadItem>) {
    var filter by rememberSaveable { mutableStateOf(Filter.ALL) }
    val shown = items.filter { matches(it, filter) }
    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 8.dp, top = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(t("navDownloads"), style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
            if (items.any { it.status == Status.DONE }) TextButton(onClick = { app.engine.clearFinished() }) { Text(t("dlClearFinished")) }
        }
        LazyRow(contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            items(Filter.entries) { f ->
                FilterChip(selected = filter == f, onClick = { filter = f }, label = { Text(t(f.key)) })
            }
        }
        if (shown.isEmpty()) {
            Column(Modifier.fillMaxSize().padding(32.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
                Icon(SidmIcons.Download, null, Modifier.size(56.dp), tint = MaterialTheme.colorScheme.primary)
                Spacer(Modifier.height(12.dp))
                Text(t("dlEmptyTitle"), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                Spacer(Modifier.height(4.dp))
                Text(t("dlEmptyBody"), textAlign = TextAlign.Center, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        } else {
            LazyColumn(contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                items(shown, key = { it.id }) { DownloadRow(app, model, it) }
            }
        }
    }
}

@Composable
fun statusLine(item: DownloadItem): String {
    val lang = LocalLang.current
    return when (item.status) {
        Status.RUNNING -> when {
            item.phase == "merging" -> t("stMerging")
            item.phase == "starting" && item.doneBytes == 0L -> t("stStarting")
            else -> buildList {
                if (item.totalBytes > 0) add(Strings.get(lang, "dlOf", Units.bytes(item.doneBytes), Units.bytes(item.totalBytes)))
                else add(Units.bytes(item.doneBytes))
                if (item.speed > 0) add(Units.speed(item.speed))
                if (item.etaSec > 0) add(Strings.get(lang, "dlLeft", Units.duration(item.etaSec)))
            }.joinToString(" · ")
        }
        Status.QUEUED -> t("stQueued")
        Status.PAUSED -> listOf(t("stPaused"), if (item.totalBytes > 0) Strings.get(lang, "dlOf", Units.bytes(item.doneBytes), Units.bytes(item.totalBytes)) else "")
            .filter { it.isNotEmpty() }.joinToString(" · ")
        Status.WAITING_NETWORK -> if (item.error == "wifi") t("stWaitingNetwork") else t("stWaitingOnline")
        Status.DONE -> listOfNotNull(Units.bytes(item.totalBytes.takeIf { it > 0 } ?: item.doneBytes), item.qualityLabel, item.site).joinToString(" · ")
        Status.FAILED -> Strings.error(lang, item.error)
    }
}

@Composable
fun DownloadRow(app: SidmApp, model: AppModel, item: DownloadItem, compact: Boolean = false) {
    val context = LocalContext.current
    val lang = LocalLang.current
    var menu by remember { mutableStateOf(false) }
    var confirmDelete by remember { mutableStateOf(false) }
    fun report(key: String?) {
        if (key != null) model.toast = key to emptyList()
    }

    Card(
        Modifier.fillMaxWidth().clickable(enabled = item.status == Status.DONE) { report(Saver.open(context, item)) },
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        shape = RoundedCornerShape(14.dp),
    ) {
        Column(Modifier.padding(start = 14.dp, top = 12.dp, bottom = 12.dp, end = 4.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(40.dp), contentAlignment = Alignment.Center) {
                    val icon = when {
                        item.kind == Kind.VIDEO && item.status != Status.DONE -> if (item.audioOnly) SidmIcons.Music else SidmIcons.Video
                        else -> fileIcon(item.fileName)
                    }
                    Icon(icon, null, tint = MaterialTheme.colorScheme.primary)
                }
                Spacer(Modifier.width(8.dp))
                Column(Modifier.weight(1f)) {
                    Text(
                        if (item.status == Status.DONE) item.fileName else item.title,
                        maxLines = if (compact) 1 else 2, overflow = TextOverflow.Ellipsis, fontWeight = FontWeight.Medium,
                    )
                    Text(
                        statusLine(item), style = MaterialTheme.typography.bodySmall, maxLines = if (item.status == Status.FAILED) 4 else 1,
                        overflow = TextOverflow.Ellipsis,
                        color = if (item.status == Status.FAILED) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                when (item.status) {
                    Status.RUNNING, Status.QUEUED, Status.WAITING_NETWORK ->
                        IconButton(onClick = { app.engine.pause(item.id) }) { Icon(SidmIcons.Pause, t("dlPause")) }
                    Status.PAUSED -> IconButton(onClick = { app.engine.resume(item.id) }) { Icon(Icons.Filled.PlayArrow, t("dlResume")) }
                    Status.FAILED -> IconButton(onClick = { app.engine.resume(item.id) }) { Icon(Icons.Filled.Refresh, t("dlRetry")) }
                    Status.DONE -> Unit
                }
                Box {
                    IconButton(onClick = { menu = true }) { Icon(Icons.Filled.MoreVert, null) }
                    DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                        if (item.status == Status.DONE) {
                            DropdownMenuItem(text = { Text(t("dlOpen")) }, onClick = { menu = false; report(Saver.open(context, item)) })
                            DropdownMenuItem(text = { Text(t("dlShare")) }, onClick = { menu = false; report(Saver.share(context, item)) })
                        }
                        DropdownMenuItem(text = { Text(t("dlCopyLink")) }, onClick = {
                            menu = false
                            val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                            cm.setPrimaryClip(ClipData.newPlainText("link", item.url))
                            report("dlCopied")
                        })
                        if (item.active || item.status == Status.PAUSED) {
                            DropdownMenuItem(
                                text = { Text(t("dlCancel")) }, leadingIcon = { Icon(Icons.Filled.Close, null) },
                                onClick = { menu = false; app.engine.cancel(item.id) },
                            )
                        } else {
                            DropdownMenuItem(text = { Text(t("dlRemove")) }, onClick = { menu = false; app.engine.remove(item.id, deleteFile = false) })
                            if (item.status == Status.DONE) {
                                DropdownMenuItem(text = { Text(t("dlDeleteFile")) }, onClick = { menu = false; confirmDelete = true })
                            }
                        }
                    }
                }
            }
            if (item.status == Status.RUNNING || item.status == Status.PAUSED) {
                Spacer(Modifier.height(8.dp))
                val p = item.progress
                if (p >= 0f && item.phase != "merging") {
                    LinearProgressIndicator(progress = { p }, modifier = Modifier.fillMaxWidth().padding(end = 10.dp))
                } else if (item.status == Status.RUNNING) {
                    LinearProgressIndicator(modifier = Modifier.fillMaxWidth().padding(end = 10.dp))
                }
            }
        }
    }

    if (confirmDelete) {
        AlertDialog(
            onDismissRequest = { confirmDelete = false },
            text = { Text(Strings.get(lang, "dlDeleteConfirm", item.fileName)) },
            confirmButton = {
                TextButton(onClick = { confirmDelete = false; app.engine.remove(item.id, deleteFile = true) }) {
                    Text(t("dlDelete"), color = MaterialTheme.colorScheme.error)
                }
            },
            dismissButton = { TextButton(onClick = { confirmDelete = false }) { Text(t("cancel")) } },
        )
    }
}
