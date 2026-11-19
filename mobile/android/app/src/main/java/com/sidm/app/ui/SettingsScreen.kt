package com.sidm.app.ui

import android.webkit.CookieManager
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.sidm.app.LocalLang
import com.sidm.app.SettingsRepo
import com.sidm.app.SidmApp
import com.sidm.app.Strings
import com.sidm.app.VideoTools
import com.sidm.app.t
import com.sidm.core.Units
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

@Composable
fun SettingsScreen(app: SidmApp, model: AppModel) {
    val s by app.settings.state.collectAsState()
    val lang = LocalLang.current
    val engineVersion by app.engine.video.version.collectAsState()
    val scope = rememberCoroutineScope()
    var updating by remember { mutableStateOf(false) }
    var ytDialog by remember { mutableStateOf(false) }

    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(t("navSettings"), style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)

        Section(t("setGeneral")) {
            ChoiceRow(t("setLanguage"), Strings.languageName(s.language), Strings.LANGUAGES, s.language, { Strings.languageName(it) }) { v ->
                app.settings.update { it.copy(language = v) }
            }
            HorizontalDivider()
            ChoiceRow(
                t("setTheme"), t("theme" + s.theme.replaceFirstChar { it.uppercase() }), listOf("system", "light", "dark"), s.theme,
                { Strings.get(lang, "theme" + it.replaceFirstChar { c -> c.uppercase() }) },
            ) { v -> app.settings.update { it.copy(theme = v) } }
        }

        Section(t("setDownloads")) {
            InfoRow(t("setFolder"), t("setFolderValue"))
            HorizontalDivider()
            SwitchRow(t("setWifiOnly"), t("setWifiOnlyHint"), s.wifiOnly) { v -> app.settings.update { it.copy(wifiOnly = v) } }
            HorizontalDivider()
            ChoiceRow(t("setConnections"), s.connections.toString(), SettingsRepo.CONNECTION_CHOICES, s.connections, { it.toString() }, t("setConnectionsHint")) { v ->
                app.settings.update { it.copy(connections = v) }
            }
            HorizontalDivider()
            ChoiceRow(t("setParallel"), s.parallel.toString(), SettingsRepo.PARALLEL_CHOICES, s.parallel, { it.toString() }) { v ->
                app.settings.update { it.copy(parallel = v) }
            }
            HorizontalDivider()
            val speedText: (Long) -> String = { if (it == 0L) Strings.get(lang, "speedOff") else Units.speed(it) }
            ChoiceRow(t("setSpeed"), speedText(s.speedLimit), SettingsRepo.SPEED_CHOICES, s.speedLimit, speedText) { v ->
                app.settings.update { it.copy(speedLimit = v) }
            }
        }

        Section(t("setVideo")) {
            SwitchRow(t("setAlwaysBest"), t("setAlwaysBestHint"), s.alwaysBest) { v -> app.settings.update { it.copy(alwaysBest = v) } }
            HorizontalDivider()
            SwitchRow(t("setYouTube"), t("setYouTubeHint"), s.allowYouTube) { v ->
                if (v) ytDialog = true else app.settings.update { it.copy(allowYouTube = false) }
            }
        }

        Section(t("setEngine")) {
            InfoRow(t("setEngineVersion", engineVersion ?: "…"), null)
            HorizontalDivider()
            SwitchRow(t("setEngineAuto"), t("setEngineAutoHint"), s.autoUpdateEngine) { v -> app.settings.update { it.copy(autoUpdateEngine = v) } }
            HorizontalDivider()
            Row(Modifier.fillMaxWidth().padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                OutlinedButton(enabled = !updating, onClick = {
                    updating = true
                    scope.launch {
                        val msg = try {
                            val v = withContext(Dispatchers.IO) { app.updates.updateEngineNow() }
                            if (v.isEmpty()) "setEngineUpToDate" to emptyList() else "setEngineUpdated" to listOf<Any>(v)
                        } catch (e: VideoTools.BusyException) {
                            "setEngineBusy" to emptyList()
                        } catch (e: Exception) {
                            "setEngineFailed" to listOf<Any>(e.message ?: "")
                        }
                        updating = false
                        model.toast = msg
                    }
                }) { Text(if (updating) t("setEngineUpdating") else t("setEngineUpdate")) }
                if (updating) {
                    Spacer(Modifier.width(12.dp))
                    CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                }
            }
        }

        Section(t("setSignedIn")) {
            Text(
                t("setClearCookies"),
                Modifier
                    .fillMaxWidth()
                    .clickable {
                        CookieManager.getInstance().removeAllCookies(null)
                        CookieManager.getInstance().flush()
                        model.toast = "setCookiesCleared" to emptyList()
                    }
                    .padding(16.dp),
                color = MaterialTheme.colorScheme.error,
            )
        }

        Section(t("setAbout")) {
            Text(
                t("setAbout"),
                Modifier.fillMaxWidth().clickable { model.showAbout = true }.padding(16.dp),
                color = MaterialTheme.colorScheme.primary,
            )
        }
    }

    if (ytDialog) {
        AlertDialog(
            onDismissRequest = { ytDialog = false },
            title = { Text(t("ytDialogTitle")) },
            text = { Text(t("ytDialogBody")) },
            confirmButton = {
                TextButton(onClick = {
                    ytDialog = false
                    app.settings.update { it.copy(allowYouTube = true) }
                }) { Text(t("ytDialogAccept")) }
            },
            dismissButton = { TextButton(onClick = { ytDialog = false }) { Text(t("cancel")) } },
        )
    }
}

@Composable
fun Section(title: String, content: @Composable () -> Unit) {
    Column {
        Text(title, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary, modifier = Modifier.padding(start = 4.dp, bottom = 6.dp))
        Card(
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
            shape = RoundedCornerShape(16.dp),
        ) { Column { content() } }
    }
}

@Composable
private fun InfoRow(title: String, value: String?) {
    Row(Modifier.fillMaxWidth().padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(title, modifier = Modifier.weight(1f))
        if (value != null) Text(value, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun SwitchRow(title: String, hint: String?, checked: Boolean, onChange: (Boolean) -> Unit) {
    Row(
        Modifier.fillMaxWidth().clickable { onChange(!checked) }.padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(title)
            if (hint != null) Text(hint, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Spacer(Modifier.width(12.dp))
        Switch(checked = checked, onCheckedChange = onChange)
    }
}

@Composable
private fun <T> ChoiceRow(
    title: String,
    value: String,
    choices: List<T>,
    current: T,
    label: (T) -> String,
    hint: String? = null,
    onPick: (T) -> Unit,
) {
    var open by remember { mutableStateOf(false) }
    Row(Modifier.fillMaxWidth().clickable { open = true }.padding(horizontal = 16.dp, vertical = 14.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(title)
            if (hint != null) Text(hint, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Text(value, color = MaterialTheme.colorScheme.primary, fontWeight = FontWeight.Medium)
    }
    if (open) {
        AlertDialog(
            onDismissRequest = { open = false },
            title = { Text(title) },
            text = {
                Column {
                    choices.forEach { c ->
                        Row(
                            Modifier.fillMaxWidth().clickable { open = false; onPick(c) }.padding(vertical = 4.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            RadioButton(selected = c == current, onClick = { open = false; onPick(c) })
                            Text(label(c))
                        }
                    }
                }
            },
            confirmButton = { TextButton(onClick = { open = false }) { Text(t("cancel")) } },
        )
    }
}
