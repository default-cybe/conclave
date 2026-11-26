import UIKit
import XCTest

/// CI screenshots of the mock hub (`-mockHub`), run by the Screenshots scheme. simctl cannot turn
/// the simulator and an iPad app cannot turn itself, so the UI test turns the device.
/// Settings come from xcodebuild's TEST_RUNNER_ variables: SHOTS (output folder), SHOT_PREFIX,
/// SHOT_ORIENTATIONS and SHOT_APPEARANCES (comma lists).
final class ScreenshotTests: XCTestCase {
    @MainActor
    func testMockHubScreens() throws {
        let env = ProcessInfo.processInfo.environment
        guard let dir = env["SHOTS"] else { throw XCTSkip("SHOTS is not set") }
        let prefix = env["SHOT_PREFIX"] ?? "ipad"
        let orientations = (env["SHOT_ORIENTATIONS"] ?? "landscape,portrait").split(separator: ",")
        let appearances = (env["SHOT_APPEARANCES"] ?? "light,dark").split(separator: ",")

        let app = XCUIApplication()
        app.launchArguments = ["-mockHub", "-openChat", "s1"]
        for a in appearances {
            XCUIDevice.shared.appearance = a == "dark" ? .dark : .light
            for o in orientations {
                XCUIDevice.shared.orientation = o == "landscape" ? .landscapeLeft : .portrait
                app.launch()
                XCTAssert(app.staticTexts["Here is the icon colour."].waitForExistence(timeout: 30))
                sleep(2)
                let url = URL(fileURLWithPath: dir).appendingPathComponent("\(prefix)-\(o)-\(a).png")
                try Self.upright(XCUIScreen.main.screenshot().image).write(to: url)
                // element frames, to check layout in CI without a Mac
                try app.debugDescription.write(to: url.deletingPathExtension().appendingPathExtension("txt"), atomically: true, encoding: .utf8)
            }
        }
    }

    /// The screen's pixels stay portrait with an EXIF turn; drawing applies it, so a landscape shot is landscape.
    private static func upright(_ image: UIImage) -> Data {
        let format = UIGraphicsImageRendererFormat()
        format.scale = image.scale
        return UIGraphicsImageRenderer(size: image.size, format: format).pngData { _ in image.draw(at: .zero) }
    }
}
