import com.android.build.api.dsl.ApplicationExtension

// Applied by the tracked build hook to Tauri's regenerated Android project.
// Secret values never enter source files or Gradle properties on disk.
val releaseRequested = gradle.startParameter.taskNames.any { it.contains("release", ignoreCase = true) }
val signingNames = listOf("STILL_ANDROID_KEYSTORE", "ANDROID_KEYSTORE_PASSWORD", "ANDROID_KEY_ALIAS", "ANDROID_KEY_PASSWORD")
if (releaseRequested) {
    check(signingNames.all { !System.getenv(it).isNullOrBlank() }) {
        "Production Android builds require the release keystore and all Android signing environment variables."
    }
}

extensions.configure<ApplicationExtension> {
    compileSdk = 36
    defaultConfig {
        minSdk = 24
        targetSdk = 36
    }
    val key = System.getenv("STILL_ANDROID_KEYSTORE")
    if (!key.isNullOrBlank()) {
        val production = signingConfigs.maybeCreate("stillRelease").apply {
            storeFile = file(key)
            storeType = "PKCS12"
            storePassword = System.getenv("ANDROID_KEYSTORE_PASSWORD")
            keyAlias = System.getenv("ANDROID_KEY_ALIAS")
            keyPassword = System.getenv("ANDROID_KEY_PASSWORD")
        }
        buildTypes.getByName("release").signingConfig = production
    }
}
