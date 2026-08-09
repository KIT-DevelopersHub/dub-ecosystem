// core:database — EncryptedDataStore session vault (§3). Android library because
// the concrete impl uses androidx.security EncryptedSharedPreferences (AndroidX
// Keystore-backed). The SessionStore contract itself lives in core:common so
// JVM modules can depend on it without pulling Android in. Mirrors session-store.ts.
plugins {
    alias(libs.plugins.android.library)
    alias(libs.plugins.kotlin.android)
}

android {
    namespace = "jp.developershub.dub.mo2.core.database"
    compileSdk = 36

    defaultConfig {
        minSdk = 26
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin {
    jvmToolchain(17)
}

dependencies {
    api(project(":core:common"))
    implementation(libs.androidx.security.crypto)
}
