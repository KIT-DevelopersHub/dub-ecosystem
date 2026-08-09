// core:model — the wire model (OpenAPI-generation target, §5/§8 #3). Pure
// Kotlin/JVM; kotlinx.serialization data classes mirror the frozen @dub/types
// `mobile` + referenced namespaces 1:1. Hand-writing divergent wire types is
// forbidden — these stay in lockstep with @dub/types (owner = MO3 / OpenAPI).
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
    api(libs.kotlinx.serialization.json)
    testImplementation(libs.junit)
}
