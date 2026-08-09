// feature:tasks (S5/S6) — my-tasks list + task detail with optimistic status
// change and HTTP 409 rollback/refetch (theme3 D4). Android library (Compose UI).
// TaskRepository + TasksViewModel mirror task-repository.ts and are unit-tested
// on the JVM (src/test) with a fake MobileBffClient.
plugins {
    alias(libs.plugins.android.library)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.compose.compiler)
}

android {
    namespace = "jp.developershub.dub.mo2.feature.tasks"
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
