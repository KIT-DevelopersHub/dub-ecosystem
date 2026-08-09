// swift-tools-version:5.9
import PackageDescription

// MO1 iOS native app (SwiftUI, MVVM + Repository). The production target is
// iOS 17+, but the package also builds on macOS 14+ so the platform-agnostic
// Core + ViewModel logic can be compiled and unit-tested with `swift test` on a
// developer machine or CI runner that has only the Swift toolchain (no Xcode).
//
// Layering (mirrors apps/mo1-ios/src/*.ts 1:1):
//   Mo1Core  — contracts + networking + error model + pure domain logic (no UI)
//   Mo1UI    — SwiftUI views + ObservableObject ViewModels (depends on Mo1Core)
//   Mo1App   — @main app entry (depends on Mo1UI)
let package = Package(
    name: "Mo1",
    platforms: [
        .iOS(.v17),
        .macOS(.v14), // enables `swift test` off-device; not a shipping target
    ],
    products: [
        .library(name: "Mo1Core", targets: ["Mo1Core"]),
        .library(name: "Mo1UI", targets: ["Mo1UI"]),
    ],
    targets: [
        .target(name: "Mo1Core"),
        .target(name: "Mo1UI", dependencies: ["Mo1Core"]),
        .executableTarget(name: "Mo1App", dependencies: ["Mo1UI"]),
        .testTarget(name: "Mo1CoreTests", dependencies: ["Mo1Core"]),
        .testTarget(name: "Mo1UITests", dependencies: ["Mo1UI"]),
    ]
)
