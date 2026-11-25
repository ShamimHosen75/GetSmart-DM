package com.sidm.app

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import com.sidm.app.ui.AppModel
import com.sidm.app.ui.MainScreen
import com.sidm.app.ui.SidmTheme
import com.sidm.app.ui.Tab
import com.sidm.app.ui.WelcomeScreen
import com.sidm.core.Links

class MainActivity : ComponentActivity() {
    private lateinit var model: AppModel

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val app = application as SidmApp
        model = AppModel(app)
        // After the system restarts SIDM (memory, a setting change) or it is opened
        // from Recents, Android hands back the intent that first opened it: that is
        // an old share, and acting on it again would download an earlier video.
        if (savedInstanceState == null) handle(intent)
        setContent {
            val settings by app.settings.state.collectAsState()
            CompositionLocalProvider(LocalLang provides settings.language) {
                SidmTheme(settings.theme) {
                    if (!settings.welcomeDone) WelcomeScreen(app) else MainScreen(app, model)
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handle(intent)
    }

    /** A link shared from another app, an "Open with SIDM" link, or a tap on a notification. */
    private fun handle(intent: Intent?) {
        intent ?: return
        if (intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY != 0) return
        intent.getStringExtra(EXTRA_TAB)?.let { if (it == "downloads") model.tab = Tab.DOWNLOADS }
        val text = when (intent.action) {
            Intent.ACTION_SEND -> intent.getStringExtra(Intent.EXTRA_TEXT) ?: intent.getStringExtra(Intent.EXTRA_SUBJECT)
            Intent.ACTION_VIEW -> intent.dataString
            else -> null
        } ?: return
        val link = Links.firstLink(text) ?: return
        model.tab = Tab.HOME
        model.link = link
        model.analyze(link)
        // Handled: a later configuration change must not start it again.
        intent.action = null
    }

    companion object {
        const val EXTRA_TAB = "tab"
    }
}
