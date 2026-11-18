package com.sidm.app.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import com.sidm.app.LocalLang
import com.sidm.app.SidmApp
import com.sidm.app.Strings
import com.sidm.app.t

@Composable
fun MainScreen(app: SidmApp, model: AppModel) {
    val items by app.engine.store.items.collectAsState()
    val lang = LocalLang.current
    val snackbar = remember { SnackbarHostState() }
    val active = items.count { it.active }

    LaunchedEffect(model.toast) {
        model.toast?.let { (key, args) ->
            snackbar.showSnackbar(Strings.get(lang, key, *args.toTypedArray()))
            model.toast = null
        }
    }
    BackHandler(enabled = model.showAbout) { model.showAbout = false }
    BackHandler(enabled = !model.showAbout && model.tab != Tab.HOME && model.tab != Tab.BROWSER) { model.tab = Tab.HOME }

    if (model.showAbout) {
        AboutScreen(app) { model.showAbout = false }
        return
    }

    Scaffold(
        snackbarHost = { SnackbarHost(snackbar) },
        bottomBar = {
            NavigationBar(containerColor = MaterialTheme.colorScheme.surface) {
                NavigationBarItem(
                    selected = model.tab == Tab.HOME, onClick = { model.tab = Tab.HOME },
                    icon = { Icon(Icons.Filled.Home, null) }, label = { Text(t("navHome")) },
                )
                NavigationBarItem(
                    selected = model.tab == Tab.BROWSER, onClick = { model.tab = Tab.BROWSER },
                    icon = { Icon(SidmIcons.Globe, null) }, label = { Text(t("navBrowser")) },
                )
                NavigationBarItem(
                    selected = model.tab == Tab.DOWNLOADS, onClick = { model.tab = Tab.DOWNLOADS },
                    icon = {
                        BadgedBox(badge = { if (active > 0) Badge { Text(active.toString()) } }) {
                            Icon(SidmIcons.Download, null)
                        }
                    },
                    label = { Text(t("navDownloads")) },
                )
                NavigationBarItem(
                    selected = model.tab == Tab.SETTINGS, onClick = { model.tab = Tab.SETTINGS },
                    icon = { Icon(Icons.Filled.Settings, null) }, label = { Text(t("navSettings")) },
                )
            }
        },
    ) { padding ->
        Box(Modifier.padding(padding)) {
            when (model.tab) {
                Tab.HOME -> HomeScreen(app, model, items)
                Tab.BROWSER -> BrowserScreen(app, model)
                Tab.DOWNLOADS -> DownloadsScreen(app, model, items)
                Tab.SETTINGS -> SettingsScreen(app, model)
            }
        }
    }
    ResultSheets(app, model)
}
