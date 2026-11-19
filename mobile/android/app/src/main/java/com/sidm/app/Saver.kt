package com.sidm.app

import android.content.ActivityNotFoundException
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.media.MediaScannerConnection
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import androidx.core.content.FileProvider
import com.sidm.core.FileNames
import java.io.File

/**
 * Moves finished files into the phone's shared Downloads/SIDM folder, where the
 * Files app and the Gallery see them, and opens or shares them.
 */
object Saver {
    const val FOLDER = "SIDM"

    /** Copies [source] to Downloads/SIDM as [fileName] and returns its content:// address. */
    fun publish(context: Context, source: File, fileName: String): Pair<Uri, String> {
        val name = FileNames.clean(fileName)
        val mime = FileNames.mimeFor(name)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val resolver = context.contentResolver
            val values = ContentValues().apply {
                put(MediaStore.MediaColumns.DISPLAY_NAME, name)
                put(MediaStore.MediaColumns.MIME_TYPE, mime)
                put(MediaStore.MediaColumns.RELATIVE_PATH, "${Environment.DIRECTORY_DOWNLOADS}/$FOLDER")
                put(MediaStore.MediaColumns.IS_PENDING, 1)
            }
            val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                ?: throw IllegalStateException("MediaStore refused the file")
            try {
                resolver.openOutputStream(uri)!!.use { out -> source.inputStream().use { it.copyTo(out, 256 * 1024) } }
                values.clear()
                values.put(MediaStore.MediaColumns.IS_PENDING, 0)
                resolver.update(uri, values, null, null)
            } catch (e: Exception) {
                resolver.delete(uri, null, null)
                throw e
            }
            return uri to mime
        }
        @Suppress("DEPRECATION")
        val dir = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), FOLDER)
        dir.mkdirs()
        val target = uniqueFile(dir, name)
        if (!source.renameTo(target)) {
            source.inputStream().use { input -> target.outputStream().use { input.copyTo(it, 256 * 1024) } }
        }
        MediaScannerConnection.scanFile(context, arrayOf(target.absolutePath), arrayOf(mime), null)
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.files", target)
        return uri to mime
    }

    private fun uniqueFile(dir: File, name: String): File {
        var f = File(dir, name)
        if (!f.exists()) return f
        val base = name.substringBeforeLast('.', name)
        val ext = name.substringAfterLast('.', "").let { if (it.isEmpty() || it == name) "" else ".$it" }
        var i = 1
        while (f.exists()) {
            f = File(dir, "$base ($i)$ext")
            i++
        }
        return f
    }

    /** The name the file really got (Android adds " (1)" when the name is taken). */
    fun displayName(context: Context, uri: Uri): String? = try {
        context.contentResolver.query(uri, arrayOf(android.provider.OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
            if (c.moveToFirst()) c.getString(0) else null
        }
    } catch (_: Exception) {
        null
    }

    fun exists(context: Context, uri: String?): Boolean {
        if (uri == null) return false
        return try {
            context.contentResolver.openFileDescriptor(Uri.parse(uri), "r")?.use { true } ?: false
        } catch (_: Exception) {
            false
        }
    }

    /** Opens the file in another app. Returns a message key when it can't. */
    fun open(context: Context, item: DownloadItem): String? {
        val uri = item.contentUri ?: return "dlFileMissing"
        if (!exists(context, uri)) return "dlFileMissing"
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(Uri.parse(uri), item.mime ?: FileNames.mimeFor(item.fileName))
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        return try {
            context.startActivity(intent)
            null
        } catch (_: ActivityNotFoundException) {
            "dlNoApp"
        }
    }

    fun share(context: Context, item: DownloadItem): String? {
        val uri = item.contentUri ?: return "dlFileMissing"
        if (!exists(context, uri)) return "dlFileMissing"
        val send = Intent(Intent.ACTION_SEND).apply {
            type = item.mime ?: FileNames.mimeFor(item.fileName)
            putExtra(Intent.EXTRA_STREAM, Uri.parse(uri))
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        context.startActivity(Intent.createChooser(send, item.fileName).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        return null
    }

    /** Deletes the saved file (only when the user asks for it). */
    fun delete(context: Context, item: DownloadItem): Boolean {
        val uri = item.contentUri ?: return false
        return try {
            context.contentResolver.delete(Uri.parse(uri), null, null) > 0
        } catch (_: Exception) {
            false
        }
    }

    /** Where SIDM keeps unfinished downloads (private to the app). */
    fun workDir(context: Context): File =
        File(context.getExternalFilesDir(null) ?: context.filesDir, "work").apply { mkdirs() }
}
