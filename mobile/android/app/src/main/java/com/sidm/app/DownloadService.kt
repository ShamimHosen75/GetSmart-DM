package com.sidm.app

import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.ServiceCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Keeps SIDM alive while something downloads (screen off, other apps open) and
 * shows the progress notification. Stops itself when the queue is empty.
 */
class DownloadService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var loop: Job? = null
    private var wakeLock: PowerManager.WakeLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val app = application as SidmApp
        if (intent?.action == ACTION_PAUSE_ALL) app.engine.pauseAll()
        val lang = app.settings.value.language
        val notification = Notifications.progress(this, app.engine.store.items.value, lang)
        val type = if (Build.VERSION.SDK_INT >= 29) ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC else 0
        try {
            ServiceCompat.startForeground(this, Notifications.PROGRESS_ID, notification, type)
        } catch (e: Exception) {
            // Android refused a foreground service (for example started from the background); downloads still run while SIDM is open.
            stopSelf()
            return START_NOT_STICKY
        }
        if (wakeLock == null) {
            wakeLock = (getSystemService(POWER_SERVICE) as PowerManager)
                .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "SIDM:downloads").apply { acquire(6 * 60 * 60 * 1000L) }
        }
        if (loop == null) {
            loop = scope.launch {
                while (true) {
                    delay(1000)
                    val items = app.engine.store.items.value
                    if (items.none { it.status == Status.RUNNING || it.status == Status.QUEUED }) {
                        ServiceCompat.stopForeground(this@DownloadService, ServiceCompat.STOP_FOREGROUND_REMOVE)
                        stopSelf()
                        break
                    }
                    runCatching {
                        NotificationManagerCompat.from(this@DownloadService)
                            .notify(Notifications.PROGRESS_ID, Notifications.progress(this@DownloadService, items, app.settings.value.language))
                    }
                }
            }
        }
        return START_NOT_STICKY
    }

    override fun onTimeout(startId: Int, fgsType: Int) {
        // Android 15 limits dataSync services to 6 hours a day: pause instead of being killed.
        (application as SidmApp).engine.pauseAll()
        stopSelf()
    }

    override fun onDestroy() {
        scope.cancel()
        wakeLock?.let { if (it.isHeld) it.release() }
        super.onDestroy()
    }

    companion object {
        const val ACTION_PAUSE_ALL = "com.sidm.app.PAUSE_ALL"
    }
}
