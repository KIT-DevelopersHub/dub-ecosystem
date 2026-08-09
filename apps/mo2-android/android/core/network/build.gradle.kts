// core:network — Retrofit/OkHttp transport, AuthInterceptor (single-token 401 ->
// refresh once), @dub/errors envelope -> AppError mapper, and the MobileBffClient
// (all /m/v1/* endpoints). Pure Kotlin/JVM: Retrofit + OkHttp + coroutines are
// JVM libraries, so the interceptor and mapper are unit-tested without a device
// (MockWebServer). Mirrors http.ts / errors.ts / auth-interceptor.ts / bff-client.ts.
plugins {
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.kotlin.serialization)
}

java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}

kotlin {
    jvmToolchain(17)
}

dependencies {
    api(project(":core:model"))
    api(project(":core:common"))
    api(libs.kotlinx.coroutines.core)
    implementation(libs.retrofit)
    implementation(libs.retrofit.serialization)
    implementation(libs.okhttp)
    implementation(libs.okhttp.logging)
    implementation(libs.kotlinx.serialization.json)

    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.okhttp.mockwebserver)
}
