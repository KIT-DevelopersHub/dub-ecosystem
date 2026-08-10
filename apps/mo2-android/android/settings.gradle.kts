// MO2 Android — standalone Gradle build. NOT part of the pnpm/turbo monorepo
// graph (kind=mobile native app); opened directly in Android Studio / built via
// ./gradlew from this directory.
pluginManagement {
    repositories {
        google {
            content {
                includeGroupByRegex("com\\.android.*")
                includeGroupByRegex("com\\.google.*")
                includeGroupByRegex("androidx.*")
            }
        }
        mavenCentral()
        gradlePluginPortal()
    }
}
plugins {
    // Auto-provision the JDK 17 toolchain when the build machine lacks it.
    id("org.gradle.toolchains.foojay-resolver-convention") version "0.8.0"
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "mo2-android"

include(":app")
include(":core:common")
include(":core:model")
include(":core:network")
include(":core:database")
include(":feature:home")
include(":feature:tasks")
include(":feature:events")
include(":feature:gantt")
include(":feature:chat")
include(":feature:inbox")
include(":feature:preferences")
include(":feature:devices")
