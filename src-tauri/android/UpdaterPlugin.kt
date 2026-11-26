package dev.still.app

import android.app.Activity
import android.app.DownloadManager
import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.Settings
import androidx.core.content.FileProvider
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import org.json.JSONObject
import java.io.File
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.Executors
import java.util.zip.ZipFile
import javax.net.ssl.HttpsURLConnection

/** OS-owned downloads survive WebView/process death; installation is always user-confirmed. */
@TauriPlugin
class UpdaterPlugin(private val activity: Activity) : Plugin(activity) {
  private val preferences = activity.getSharedPreferences("still-updates-v1", Context.MODE_PRIVATE)
  private val downloads = activity.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
  private val worker = Executors.newSingleThreadExecutor()
  private var verifiedFile: String? = null
  private val repository = "https://github.com/Dummy-pixel-hash/still-app"
  private val interval = 6 * 60 * 60 * 1000L
  private val maximumApkBytes = 512 * 1024 * 1024L

  @Command
  fun checkUpdate(invoke: Invoke) = perform(invoke) {
    disabled()?.let { return@perform it }
    if (preferences.contains("downloadId")) return@perform status()
    val now = System.currentTimeMillis()
    val previous = preferences.getLong("lastCheck", 0)
    if (!invoke.getArgs().optBoolean("force") && previous <= now && now - previous < interval) {
      return@perform response("idle", "No newer stable release found.")
    }
    val manifest = readManifest()
    require(manifest.getString("channel") == "stable") { "The update feed is not a stable release." }
    val version = manifest.getString("version")
    require(Regex("(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)").matches(version)) {
      "Invalid stable release version."
    }
    val packages = manifest.getJSONArray("packages")
    val matches = (0 until packages.length()).map { packages.getJSONObject(it) }.filter {
      it.optString("platform") == "android" && it.optString("architecture") == "arm64"
    }
    require(matches.size == 1) { "This stable release has no unique Android ARM64 package." }
    val entry = matches.single().put("version", version)
    validateMetadata(entry)
    if (entry.getLong("versionCode") <= versionCode(installedPackage())) {
      preferences.edit().putLong("lastCheck", now).apply()
      return@perform response("idle", "No newer stable release found.")
    }
    require(entry.getInt("minSdk") <= Build.VERSION.SDK_INT) { "The update requires a newer Android version." }
    val file = apkFile(entry)
    if (file.exists()) require(file.delete()) { "Could not remove an incomplete update. Retry after restarting Still." }
    val request = DownloadManager.Request(Uri.parse(entry.getString("url")))
      .setTitle("Still $version")
      .setDescription("App update — installation requires your confirmation")
      .setMimeType("application/vnd.android.package-archive")
      // Do not advertise an installable completion notification before our
      // checksum/package/signer checks have run. Still shows readiness itself.
      .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE)
      .setAllowedOverMetered(preferences.getBoolean("allowCellular", false))
      .setAllowedOverRoaming(false)
      .setDestinationInExternalFilesDir(activity, Environment.DIRECTORY_DOWNLOADS, file.name)
    val id = downloads.enqueue(request)
    if (!preferences.edit().putString("pending", entry.toString()).putLong("downloadId", id)
        .putLong("lastCheck", now).commit()) {
      downloads.remove(id)
      error("Could not save update download state.")
    }
    status()
  }

  @Command
  fun updateStatus(invoke: Invoke) = perform(invoke) { disabled() ?: status() }

  @Command
  fun setCellular(invoke: Invoke) = perform(invoke) {
    require(invoke.getArgs().has("allowCellular")) { "A cellular download preference is required." }
    val allowed = invoke.getArgs().getBoolean("allowCellular")
    val changed = allowed != preferences.getBoolean("allowCellular", false)
    if (changed) {
      // DownloadManager does not expose a safe way to change a queued request's policy.
      // Discard it and let the next check enqueue it with the new policy.
      clearDownload()
      require(preferences.edit().putBoolean("allowCellular", allowed).remove("lastCheck").commit()) {
        "Could not save the download preference."
      }
    }
    response("idle", "Download preference saved. Check for updates to apply it.")
  }

  @Command
  fun installUpdate(invoke: Invoke) = perform(invoke) {
    disabled()?.let { return@perform it }
    val current = status()
    require(current.getString("phase") == "ready") { "Download and verify the update before installing it." }
    val entry = JSONObject(preferences.getString("pending", null) ?: error("No downloaded update."))
    val file = verifyApk(entry) // Recheck immediately before handing the file to another process.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !activity.packageManager.canRequestPackageInstalls()) {
      activity.runOnUiThread {
        try {
          activity.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${activity.packageName}")))
          invoke.resolve(response("ready", "Allow updates from Still, then return and choose Install update again.", entry))
        } catch (failure: Exception) { invoke.reject(failure.message ?: "Could not open installation permissions.") }
      }
    } else {
      val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", file)
      activity.runOnUiThread {
        try {
          activity.startActivity(Intent(Intent.ACTION_VIEW)
            .setDataAndType(uri, "application/vnd.android.package-archive")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION))
          invoke.resolve(response("ready", "Confirm installation in Android. If cancelled, the update stays ready.", entry))
        } catch (failure: Exception) { invoke.reject(failure.message ?: "Could not open Android's package installer.") }
      }
    }
    null // The UI-thread callback resolves this invocation.
  }

  private fun perform(invoke: Invoke, action: () -> JSObject?) {
    worker.execute {
      try { action()?.let { invoke.resolve(it) } }
      catch (failure: Exception) { invoke.reject(failure.message ?: "Update failed. Check your connection and retry.") }
    }
  }

  private fun disabled(): JSObject? {
    if (activity.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0) {
      return response("disabled", "Automatic updates are disabled in debug builds. Install a production-signed build first.")
    }
    if (!Build.SUPPORTED_ABIS.contains("arm64-v8a")) {
      return response("disabled", "Automatic Android updates currently support ARM64 devices only.")
    }
    return null
  }

  private fun status(): JSObject {
    val raw = preferences.getString("pending", null) ?: return response("idle", "Ready to check for updates.")
    val entry = JSONObject(raw)
    validateMetadata(entry)
    if (entry.getLong("versionCode") <= versionCode(installedPackage())) {
      clearDownload()
      return response("idle", "The downloaded update is already installed.")
    }
    val id = preferences.getLong("downloadId", -1)
    downloads.query(DownloadManager.Query().setFilterById(id)).use { cursor ->
      if (cursor == null || !cursor.moveToFirst()) {
        clearDownload()
        return response("failed", "The download was removed. Check for updates to download it again.")
      }
      val state = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS))
      val received = cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR))
      if (state == DownloadManager.STATUS_FAILED) {
        val reason = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON))
        clearDownload()
        return response("failed", "Android could not download the update (code $reason). Check storage/network and retry.")
      }
      if (state == DownloadManager.STATUS_SUCCESSFUL) {
        try {
          val file = apkFile(entry)
          val identity = "${file.absolutePath}:${file.length()}:${file.lastModified()}"
          if (verifiedFile != identity) { verifyApk(entry); verifiedFile = identity }
          return response("ready", "Verified and ready to install.", entry).also { it.put("progress", 100) }
        } catch (failure: Exception) {
          clearDownload()
          return response("failed", "Update verification failed: ${failure.message}. Check for updates to retry.")
        }
      }
      val paused = state == DownloadManager.STATUS_PAUSED || state == DownloadManager.STATUS_PENDING
      return response(if (paused) "waiting" else "downloading",
        if (paused) "Waiting for an allowed network or Android's download service." else "Downloading in the background.", entry)
        .also { it.put("progress", (received * 100 / entry.getLong("bytes")).coerceIn(0, 99)) }
    }
  }

  private fun response(phase: String, message: String, entry: JSONObject? = null): JSObject = JSObject().apply {
    put("phase", phase)
    put("message", message)
    put("allowCellular", preferences.getBoolean("allowCellular", false))
    entry?.let { put("version", it.getString("version")) }
  }

  private fun validateMetadata(entry: JSONObject) {
    val version = entry.getString("version")
    require(Regex("(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)").matches(version)) { "Invalid stable version." }
    require(entry.getString("applicationId") == activity.packageName) { "Update package identity does not match Still." }
    require(entry.getString("architecture") == "arm64" && entry.getString("platform") == "android") { "Unsupported update architecture." }
    require(entry.getLong("versionCode") in 1..2_100_000_000L) { "Invalid Android version code." }
    require(entry.getLong("bytes") in 1..maximumApkBytes) { "Invalid update size." }
    require(entry.getInt("minSdk") in 24..Build.VERSION.SDK_INT) { "Unsupported minimum Android version." }
    require(Regex("[a-fA-F0-9]{64}").matches(entry.getString("sha256"))) { "Invalid update checksum." }
    val url = entry.getString("url")
    val prefix = "$repository/releases/download/v$version/"
    require(url.startsWith(prefix) && Regex("[A-Za-z0-9._-]+\\.apk").matches(url.removePrefix(prefix))) {
      "The APK URL is not a version-pinned Still release asset."
    }
  }

  private fun apkFile(entry: JSONObject): File {
    val folder = activity.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) ?: error("Download storage is unavailable.")
    return File(folder, "still-update-${entry.getLong("versionCode")}.apk")
  }

  private fun verifyApk(entry: JSONObject): File {
    validateMetadata(entry)
    val file = apkFile(entry)
    require(file.isFile && file.length() == entry.getLong("bytes")) { "The downloaded APK has the wrong size." }
    val digest = MessageDigest.getInstance("SHA-256")
    file.inputStream().buffered().use { stream ->
      val buffer = ByteArray(64 * 1024)
      while (true) {
        val count = stream.read(buffer)
        if (count < 0) break
        digest.update(buffer, 0, count)
      }
    }
    val hash = digest.digest().joinToString("") { "%02x".format(it) }
    require(hash.equals(entry.getString("sha256"), true)) { "The APK checksum does not match." }
    val archive = activity.packageManager.getPackageArchiveInfo(file.absolutePath, signatureFlags()) ?: error("Not a valid APK.")
    require(archive.packageName == activity.packageName) { "The APK belongs to another application." }
    require(archive.applicationInfo?.flags?.and(ApplicationInfo.FLAG_DEBUGGABLE) == 0) { "Debug APKs cannot be production updates." }
    require(archive.versionName == entry.getString("version") && versionCode(archive) == entry.getLong("versionCode")) { "The APK version does not match the release metadata." }
    require(versionCode(archive) > versionCode(installedPackage())) { "Android downgrades are not supported." }
    val expected = signers(installedPackage())
    require(expected.isNotEmpty() && signers(archive) == expected) { "The APK was not signed with this app's signing identity." }
    ZipFile(file).use { zip ->
      require(zip.entries().asSequence().any { it.name.startsWith("lib/arm64-v8a/") && it.name.endsWith(".so") }) { "The APK does not contain ARM64 native code." }
    }
    return file
  }

  @Suppress("DEPRECATION")
  private fun signatureFlags() = if (Build.VERSION.SDK_INT >= 28) PackageManager.GET_SIGNING_CERTIFICATES else PackageManager.GET_SIGNATURES

  @Suppress("DEPRECATION")
  private fun installedPackage() = activity.packageManager.getPackageInfo(activity.packageName, signatureFlags())

  @Suppress("DEPRECATION")
  private fun versionCode(info: PackageInfo): Long = if (Build.VERSION.SDK_INT >= 28) info.longVersionCode else info.versionCode.toLong()

  @Suppress("DEPRECATION")
  private fun signers(info: PackageInfo): Set<String> {
    val signatures = if (Build.VERSION.SDK_INT >= 28) info.signingInfo?.apkContentsSigners else info.signatures
    return signatures.orEmpty().map { signature ->
      MessageDigest.getInstance("SHA-256").digest(signature.toByteArray()).joinToString("") { "%02x".format(it) }
    }.toSet()
  }

  private fun clearDownload() {
    val id = preferences.getLong("downloadId", -1)
    if (id >= 0) downloads.remove(id)
    preferences.edit().remove("downloadId").remove("pending").remove("lastCheck").commit()
    verifiedFile = null
  }

  private fun readManifest(): JSONObject {
    var url = URL("$repository/releases/latest/download/build-manifest.json")
    repeat(6) {
      require(url.protocol == "https" && url.userInfo == null && (url.port == -1 || url.port == 443) &&
        url.host in setOf("github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com")) { "Unsafe update feed redirect." }
      val connection = url.openConnection() as HttpsURLConnection
      connection.instanceFollowRedirects = false
      connection.connectTimeout = 15_000
      connection.readTimeout = 15_000
      connection.setRequestProperty("Accept", "application/json")
      try {
        val code = connection.responseCode
        if (code in setOf(301, 302, 303, 307, 308)) {
          url = URL(url, connection.getHeaderField("Location") ?: error("The update feed redirected without a location."))
        } else {
          require(code == 200) { "The update feed is unavailable (HTTP $code). Try again later." }
          val text = StringBuilder()
          connection.inputStream.bufferedReader(Charsets.UTF_8).use { reader ->
            val buffer = CharArray(4096)
            while (true) {
              val count = reader.read(buffer)
              if (count < 0) break
              require(text.length + count <= 256 * 1024) { "The update manifest is too large." }
              text.append(buffer, 0, count)
            }
          }
          return JSONObject(text.toString())
        }
      } finally { connection.disconnect() }
    }
    error("Too many update feed redirects.")
  }
}
