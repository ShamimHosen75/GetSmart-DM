package com.sidm.app

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.sidm.core.Units

/** The progress notification (while downloading) and one notification per finished or failed download. */
object Notifications {
    const val CHANNEL_PROGRESS = "progress"
    const val CHANNEL_DONE = "done"
    const val PROGRESS_ID = 1

    fun createChannels(context: Context, lang: String) {
        val nm = context.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_PROGRESS, Strings.get(lang, "notifChannelProgress"), NotificationManager.IMPORTANCE_LOW)
        )
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_DONE, Strings.get(lang, "notifChannelDone"), NotificationManager.IMPORTANCE_DEFAULT)
        )
    }

    private fun appIntent(context: Context, tab: String = "downloads"): PendingIntent {
        val intent = Intent(context, MainActivity::class.java)
            .putExtra(MainActivity.EXTRA_TAB, tab)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        return PendingIntent.getActivity(context, 0, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    fun progress(context: Context, items: List<DownloadItem>, lang: String): Notification {
        val running = items.filter { it.status == Status.RUNNING }
        val title = if (running.size == 1) Strings.get(lang, "notifRunningOne", running[0].title)
        else Strings.get(lang, "notifRunning", running.size.coerceAtLeast(items.count { it.active }))
        val total = running.sumOf { it.totalBytes.coerceAtLeast(0) }
        val done = running.sumOf { it.doneBytes.coerceAtLeast(0) }
        val speed = running.sumOf { it.speed }
        val text = buildString {
            if (total > 0) append(Strings.get(lang, "dlOf", Units.bytes(done), Units.bytes(total))) else append(Units.bytes(done))
            if (speed > 0) append(" · ").append(Units.speed(speed))
        }
        val pause = PendingIntent.getService(
            context, 1, Intent(context, DownloadService::class.java).setAction(DownloadService.ACTION_PAUSE_ALL),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return NotificationCompat.Builder(context, CHANNEL_PROGRESS)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setContentText(text)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setContentIntent(appIntent(context))
            .setProgress(100, if (total > 0) (done * 100 / total).toInt() else 0, total <= 0)
            .addAction(0, Strings.get(lang, "notifPauseAll"), pause)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .build()
    }

    private fun canPost(context: Context) = Build.VERSION.SDK_INT < 33 ||
        ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    fun finished(context: Context, item: DownloadItem, lang: String) {
        if (!canPost(context)) return
        val open = item.contentUri?.let { uri ->
            val view = Intent(Intent.ACTION_VIEW).setDataAndType(Uri.parse(uri), item.mime)
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
            PendingIntent.getActivity(context, item.id.hashCode(), view, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        } ?: appIntent(context)
        val n = NotificationCompat.Builder(context, CHANNEL_DONE)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(Strings.get(lang, "notifDone"))
            .setContentText(item.fileName)
            .setAutoCancel(true)
            .setContentIntent(open)
            .build()
        runCatching { NotificationManagerCompat.from(context).notify(item.id.hashCode(), n) }
    }

    fun failed(context: Context, item: DownloadItem, lang: String) {
        if (!canPost(context)) return
        val n = NotificationCompat.Builder(context, CHANNEL_DONE)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(Strings.get(lang, "notifFailed"))
            .setContentText(item.title)
            .setStyle(NotificationCompat.BigTextStyle().bigText(item.title + "\n" + Strings.error(lang, item.error)))
            .setAutoCancel(true)
            .setContentIntent(appIntent(context))
            .build()
        runCatching { NotificationManagerCompat.from(context).notify(item.id.hashCode(), n) }
    }
}
