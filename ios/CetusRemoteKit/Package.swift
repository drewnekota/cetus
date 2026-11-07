// swift-tools-version: 5.10
import PackageDescription

// Protocol + crypto shared by the Cetus iOS app and the macOS probe CLI used to
// test it against a running Cetus (see Sources/cetus-remote-probe).
let package = Package(
    name: "CetusRemoteKit",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "CetusRemoteKit", targets: ["CetusRemoteKit"]),
        .executable(name: "cetus-remote-probe", targets: ["cetus-remote-probe"]),
    ],
    targets: [
        .target(name: "CetusRemoteKit"),
        .executableTarget(name: "cetus-remote-probe", dependencies: ["CetusRemoteKit"]),
    ]
)
