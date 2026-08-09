// core:common — framework-agnostic config + the SessionStore contract.
// Pure Kotlin/JVM so it is consumable by both JVM and Android modules and
// unit-tested without a device (mirrors config.ts / session-store.ts).
plugins {
    alias(libs.plugins.kotlin.jvm)
}

java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}

kotlin {
    jvmToolchain(17)
}

dependencies {
    testImplementation(libs.junit)
}
