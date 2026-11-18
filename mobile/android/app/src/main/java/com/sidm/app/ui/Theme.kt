package com.sidm.app.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

// SIDM's own palette, the same as the extension's ui.css.
private val Light = lightColorScheme(
    primary = Color(0xFF6C3FF0),
    onPrimary = Color.White,
    primaryContainer = Color(0xFFEFE9FF),
    onPrimaryContainer = Color(0xFF2A1470),
    secondary = Color(0xFF2FB884),
    onSecondary = Color.White,
    secondaryContainer = Color(0xFFDDF7EC),
    onSecondaryContainer = Color(0xFF0B3D2A),
    background = Color(0xFFF7F6FB),
    onBackground = Color(0xFF1D1A29),
    surface = Color(0xFFFFFFFF),
    onSurface = Color(0xFF1D1A29),
    surfaceVariant = Color(0xFFF1EFF8),
    onSurfaceVariant = Color(0xFF6B6780),
    surfaceContainer = Color(0xFFF1EFF8),
    surfaceContainerHigh = Color(0xFFEAE7F4),
    surfaceContainerLow = Color(0xFFFFFFFF),
    outline = Color(0xFFD9D5E6),
    outlineVariant = Color(0xFFE6E3EF),
    error = Color(0xFFD93848),
    errorContainer = Color(0xFFFDE7EA),
    onErrorContainer = Color(0xFF5C0D17),
)

private val Dark = darkColorScheme(
    primary = Color(0xFF9B7BFF),
    onPrimary = Color(0xFF1A0B4D),
    primaryContainer = Color(0xFF2D2547),
    onPrimaryContainer = Color(0xFFE6DEFF),
    secondary = Color(0xFF4FD8A3),
    onSecondary = Color(0xFF00281A),
    secondaryContainer = Color(0xFF173B2E),
    onSecondaryContainer = Color(0xFFC8F5E2),
    background = Color(0xFF15131C),
    onBackground = Color(0xFFECE9F5),
    surface = Color(0xFF1E1B28),
    onSurface = Color(0xFFECE9F5),
    surfaceVariant = Color(0xFF272334),
    onSurfaceVariant = Color(0xFFA29DB5),
    surfaceContainer = Color(0xFF272334),
    surfaceContainerHigh = Color(0xFF302B40),
    surfaceContainerLow = Color(0xFF1E1B28),
    outline = Color(0xFF3B3550),
    outlineVariant = Color(0xFF332E45),
    error = Color(0xFFFF6B7A),
    errorContainer = Color(0xFF4A1720),
    onErrorContainer = Color(0xFFFFD9DE),
)

@Composable
fun SidmTheme(theme: String, content: @Composable () -> Unit) {
    val dark = when (theme) {
        "light" -> false
        "dark" -> true
        else -> isSystemInDarkTheme()
    }
    MaterialTheme(colorScheme = if (dark) Dark else Light, content = content)
}
