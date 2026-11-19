// swift-tools-version: 5.9
import PackageDescription

let package = Package(
  name: "AITurnMeter",
  platforms: [
    .macOS(.v13),
  ],
  products: [
    .library(name: "AITurnMeterCore", targets: ["AITurnMeterCore"]),
    .executable(name: "AITurnMeterApp", targets: ["AITurnMeterApp"]),
  ],
  targets: [
    .target(
      name: "AITurnMeterCore",
      path: "Sources/AITurnMeterCore"
    ),
    .executableTarget(
      name: "AITurnMeterApp",
      dependencies: ["AITurnMeterCore"],
      path: "Sources/AITurnMeterApp"
    ),
    .testTarget(
      name: "AITurnMeterCoreTests",
      dependencies: ["AITurnMeterCore"],
      path: "Tests/AITurnMeterCoreTests"
    ),
  ]
)
