package com.sidm.app

import android.app.Application
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

class SidmApp : Application() {
    lateinit var settings: SettingsRepo
        private set
    lateinit var engine: Engine
        private set
    lateinit var updates: Updates
        private set

    val appScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    override fun onCreate() {
        super.onCreate()
        settings = SettingsRepo(this)
        Notifications.createChannels(this, settings.value.language)
        val video = VideoTools(this)
        engine = Engine(this, DownloadStore(this), settings, video)
        updates = Updates(this, settings, video)
        appScope.launch {
            video.init()
            updates.dailyEngineUpdate()
            engine.schedule()
        }
        appScope.launch { updates.dailyAppCheck() }
    }
}
