// swift-tools-version: 6.0
import PackageDescription

// The hub client for the iPad and iPhone app: a port of packages/android/client.
// Foundation and CryptoKit only, so it builds and tests with `swift test` on a Mac.
let package = Package(
    name: "ConclaveKit",
    platforms: [.iOS(.v18), .macOS(.v15)],
    products: [
        .library(name: "ConclaveKit", targets: ["ConclaveKit"]),
    ],
    targets: [
        .target(name: "ConclaveKit"),
        .testTarget(name: "ConclaveKitTests", dependencies: ["ConclaveKit"], resources: [.copy("Fixtures")]),
    ]
)
