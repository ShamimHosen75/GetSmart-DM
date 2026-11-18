package com.sidm.app.ui

import android.Manifest
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
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
import androidx.compose.material3.Button
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.sidm.app.SidmApp
import com.sidm.app.Strings
import com.sidm.app.t

/** First start: language, notification permission, and the one-time responsibility notice. */
@Composable
fun WelcomeScreen(app: SidmApp) {
    val s by app.settings.state.collectAsState()
    var step by rememberSaveable { mutableIntStateOf(0) }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { step = 2 }

    Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background).safeDrawingPadding()) {
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Spacer(Modifier.height(24.dp))
            Box(
                Modifier.size(88.dp).clip(RoundedCornerShape(24.dp))
                    .background(Brush.verticalGradient(listOf(Color(0xFF7C4DFF), Color(0xFF5E35B1)))),
                contentAlignment = Alignment.Center,
            ) { Icon(SidmIcons.Download, null, tint = Color.White, modifier = Modifier.size(48.dp)) }
            when (step) {
                0 -> {
                    Text(t("welcomeTitle"), style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold, textAlign = TextAlign.Center)
                    Text(t("tagline"), color = MaterialTheme.colorScheme.primary, textAlign = TextAlign.Center)
                    Text(t("welcomeBody"), textAlign = TextAlign.Center, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Spacer(Modifier.height(8.dp))
                    Text(t("welcomeLanguage"), fontWeight = FontWeight.SemiBold)
                    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        Strings.LANGUAGES.forEach { code ->
                            FilterChip(
                                selected = s.language == code,
                                onClick = { app.settings.update { it.copy(language = code) } },
                                label = { Text(Strings.languageName(code), modifier = Modifier.padding(8.dp)) },
                            )
                        }
                    }
                    Spacer(Modifier.height(16.dp))
                    Button(onClick = { step = 1 }, modifier = Modifier.fillMaxWidth().height(52.dp)) { Text(t("welcomeNext")) }
                }
                1 -> {
                    Text(t("welcomePermTitle"), style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold, textAlign = TextAlign.Center)
                    Text(t("welcomePermBody"), textAlign = TextAlign.Center, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Spacer(Modifier.height(16.dp))
                    val wanted = buildList {
                        if (Build.VERSION.SDK_INT >= 33) add(Manifest.permission.POST_NOTIFICATIONS)
                        if (Build.VERSION.SDK_INT <= 28) add(Manifest.permission.WRITE_EXTERNAL_STORAGE)
                    }
                    Button(
                        onClick = { if (wanted.isEmpty()) step = 2 else permission.launch(wanted.toTypedArray()) },
                        modifier = Modifier.fillMaxWidth().height(52.dp),
                    ) { Text(if (Build.VERSION.SDK_INT <= 28) t("welcomeStorageAllow") else t("welcomePermAllow")) }
                    TextButton(onClick = { step = 2 }) { Text(t("welcomeSkip")) }
                }
                else -> {
                    Text(t("welcomeNoticeTitle"), style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold, textAlign = TextAlign.Center)
                    Text(t("welcomeNoticeBody"), textAlign = TextAlign.Center)
                    Spacer(Modifier.height(16.dp))
                    Button(
                        onClick = { app.settings.update { it.copy(welcomeDone = true) } },
                        modifier = Modifier.fillMaxWidth().height(52.dp),
                    ) { Text(t("welcomeAgree")) }
                }
            }
        }
    }
}
