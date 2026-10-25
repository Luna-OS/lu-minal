// swift-tools-version:5.9
// The lu-minal macOS app: a native AppKit window per session that hosts lu-minal in SwiftTerm's
// terminal view, in the Moon look. Build the .app with scripts/bundle-app.sh (see README.md).
import PackageDescription

let package = Package(
    name: "LuMinal",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "LuMinal", targets: ["LuMinal"]),
    ],
    dependencies: [
        // SwiftTerm 1.10.x: Swift tools 5.9, no resources or build plugins. Later releases add a
        // Metal shader resource (1.12+) and need Swift tools 6.0 (1.20) or 6.2 (1.99+), which ties
        // the build to particular Xcode versions; see README.md before moving this forward.
        .package(url: "https://github.com/migueldeicaza/SwiftTerm", .upToNextMinor(from: "1.10.1")),
    ],
    targets: [
        .executableTarget(
            name: "LuMinal",
            dependencies: [
                .product(name: "SwiftTerm", package: "SwiftTerm"),
            ],
            path: "Sources/LuMinal"
        ),
    ]
)
