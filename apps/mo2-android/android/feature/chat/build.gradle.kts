// feature:chat (S10) — channel list + per-channel message thread with optimistic
// send and DO-direct realtime reconcile. Android library (Compose UI). The
// ChatRepository mirrors chat.ts (single-source-is-MO3 boundary, optimistic send,
// realtime dedupe/promote) and is unit-tested on the JVM (src/test) with a fake
// MobileBffClient + a stub ChatRealtimeTransport. The production OkHttp WebSocket
// transport is supplied by the :app module (it owns the network deps).
plugins {
    alias(libs.plugins.android.library)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.compose.compiler)
}

android {
    namespace = "jp.developershub.dub.mo2.feature.chat"
    compileSdk = 36

    defaultConfig {
        minSdk = 26
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    buildFeatures {
        compose = true
    }
}

kotlin {
    jvmToolchain(17)
}

dependencies {
    api(project(":core:network"))
    api(project(":core:model"))
    api(project(":core:common"))

    implementation(libs.kotlinx.coroutines.core)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)

    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.ui.tooling.preview)
    debugImplementation(libs.androidx.compose.ui.tooling)

    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.turbine)
}
