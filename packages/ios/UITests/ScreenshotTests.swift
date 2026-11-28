import UIKit
import XCTest

/// CI screenshots, run by the Screenshots scheme. simctl cannot turn the simulator and an iPad app
/// cannot turn itself, so the UI test turns the device. One test per shot: each gets its own time
/// allowance, and a slow launch fails one shot, not the run.
/// Settings come from xcodebuild's TEST_RUNNER_ variables: SHOTS (output folder), SHOT_PREFIX,
/// SHOT_ORIENTATIONS and SHOT_APPEARANCES (comma lists), SHOT_CONNECT (1: the connect screen too).
final class ScreenshotTests: XCTestCase {
    private let env = ProcessInfo.processInfo.environment

    override func setUp() {
        continueAfterFailure = false
        executionTimeAllowance = 120
    }

    // the mock hub's chat: sidebar, transcript, approval and question cards, composer with a file
    @MainActor func testLandscapeLight() throws { try chat("landscape", "light") }
    @MainActor func testLandscapeDark() throws { try chat("landscape", "dark") }
    @MainActor func testPortraitLight() throws { try chat("portrait", "light") }
    @MainActor func testPortraitDark() throws { try chat("portrait", "dark") }

    /// The model picker open from the composer's chip, makers with their logos (iPad landscape).
    @MainActor func testPickerLight() throws { try picker("light") }
    @MainActor func testPickerDark() throws { try picker("dark") }

    /// The chat from its first message: your bubble, the thought, the tool folds (the second one
    /// open), the code block and the table (iPad landscape).
    @MainActor func testTopLight() throws { try top("light") }
    @MainActor func testTopDark() throws { try top("dark") }

    @MainActor
    private func top(_ appearance: String) throws {
        let dir = try folder()
        guard prefix == "ipad", list("SHOT_APPEARANCES", "light,dark").contains(appearance) else { throw XCTSkip("not asked for") }
        try shoot(dir, "\(prefix)-top-\(appearance)", "landscape", appearance, ["-mockHub", "-openChat", "s1", "-scrollTop"]) { app in
            // folds: the thought, then the tools; open the first tool
            let fold = app.buttons.matching(identifier: "fold").element(boundBy: 1)
            if fold.waitForExistence(timeout: 12) { sleep(1); fold.tap() }
            return app.staticTexts["The plan"]
        }
    }

    /// The answer's end: the list, the code block, the table and the quote (iPad landscape).
    @MainActor func testAnswerLight() throws { try answer("light") }
    @MainActor func testAnswerDark() throws { try answer("dark") }

    @MainActor
    private func answer(_ appearance: String) throws {
        let dir = try folder()
        guard prefix == "ipad", list("SHOT_APPEARANCES", "light,dark").contains(appearance) else { throw XCTSkip("not asked for") }
        try shoot(dir, "\(prefix)-answer-\(appearance)", "landscape", appearance, ["-mockHub", "-openChat", "s1", "-scrollTo", "m2"]) { app in
            // the answer's end (m2: code block, table, quote) just above the composer
            // the composer's chip is always there; the wait lets the scroll to the answer's end land
            let chip = app.buttons["Model"]
            if chip.waitForExistence(timeout: 12) { sleep(2) }
            return chip
        }
    }

    // phase 4 screens: iPad landscape light and dark, iPhone portrait light
    @MainActor func testViewerLight() throws { try viewer("light") }
    @MainActor func testViewerDark() throws { try viewer("dark") }
    @MainActor func testFilesLight() throws { try page("files", "light", ["-openChat", "s1", "-inspectorTab", "files"]) { $0.staticTexts["ipad-plan.pdf"] } }
    @MainActor func testFilesDark() throws { try page("files", "dark", ["-openChat", "s1", "-inspectorTab", "files"]) { $0.staticTexts["ipad-plan.pdf"] } }
    @MainActor func testTasksLight() throws { try page("tasks", "light", ["-openChat", "s1", "-inspectorTab", "tasks"]) { $0.staticTexts["4 tasks, 2 running, 1 failed"] } }
    @MainActor func testTasksDark() throws { try page("tasks", "dark", ["-openChat", "s1", "-inspectorTab", "tasks"]) { $0.staticTexts["4 tasks, 2 running, 1 failed"] } }
    @MainActor func testInboxLight() throws { try page("inbox", "light", ["-openPage", "inbox"]) { $0.buttons["Open chat"].firstMatch } }
    @MainActor func testInboxDark() throws { try page("inbox", "dark", ["-openPage", "inbox"]) { $0.buttons["Open chat"].firstMatch } }
    @MainActor func testDevicesLight() throws { try page("devices", "light", ["-openPage", "devices"]) { $0.staticTexts["MacBook Pro"] } }
    @MainActor func testDevicesDark() throws { try page("devices", "dark", ["-openPage", "devices"]) { $0.staticTexts["MacBook Pro"] } }
    @MainActor func testPairLight() throws { try pair("light") }
    @MainActor func testPairDark() throws { try pair("dark") }
    @MainActor func testSettingsLight() throws { try page("settings", "light", ["-openPage", "settings"]) { $0.staticTexts["0.4.107"] } }
    @MainActor func testSettingsDark() throws { try page("settings", "dark", ["-openPage", "settings"]) { $0.staticTexts["0.4.107"] } }

    /// The account row's menu: the person (Kai, Owner, conclave), Settings, Devices, Appearance, versions, Sign out.
    @MainActor func testAccountLight() throws { try account("light") }
    @MainActor func testAccountDark() throws { try account("dark") }
    /// The Code and Assistant modes' own lists.
    @MainActor func testCodeLight() throws { try mode("Code", "light") }
    @MainActor func testAssistantLight() throws { try mode("Assistant", "light") }

    @MainActor
    private func account(_ appearance: String) throws {
        try page("account", appearance, prefix == "ipad" ? ["-openChat", "s1"] : []) { app in
            let row = app.buttons["account"]
            if row.waitForExistence(timeout: 12) { sleep(1); row.tap() }
            return app.buttons["Sign out"]
        }
    }

    @MainActor
    private func mode(_ name: String, _ appearance: String) throws {
        guard prefix == "ipad" else { throw XCTSkip("iPad only") }
        // the mode as a launch argument, not a tap: a tap would be saved and every later shot would open in it
        try page(name.lowercased(), appearance, ["-openChat", name == "Code" ? "s2" : "a1", "-sideMode", name.lowercased()]) { app in
            // a session row is a Button with its title as the label, not a StaticText
            name == "Code" ? app.buttons["Kener status page theme"] : app.staticTexts["History"]
        }
    }

    /// A screen of phase 4: iPad landscape in light and dark, iPhone portrait in light only.
    @MainActor
    private func page(_ name: String, _ appearance: String, _ args: [String], ready: (XCUIApplication) -> XCUIElement) throws {
        let dir = try folder()
        guard list("SHOT_APPEARANCES", "light,dark").contains(appearance), prefix == "ipad" || appearance == "light" else { throw XCTSkip("not asked for") }
        try shoot(dir, "\(prefix)-\(name)-\(appearance)", prefix == "ipad" ? "landscape" : "portrait", appearance, ["-mockHub"] + args, ready: ready)
    }

    /// The media viewer, opened by a tap on the picture at the chat's end.
    /// `-scrollTo m4`: on a phone the approval and question cards push m4 (the picture) off screen,
    /// and the lazy transcript never builds a row that far up, so there is nothing to tap.
    @MainActor
    private func viewer(_ appearance: String) throws {
        try page("viewer", appearance, ["-openChat", "s1", "-scrollTo", "m4"]) { app in
            let pic = app.buttons.matching(identifier: "picture").firstMatch
            if pic.waitForExistence(timeout: 12) { sleep(1); pic.tap() }
            return app.buttons["Save to Photos"]
        }
    }

    /// Devices, then Pair a device: the QR code, the code and its countdown.
    @MainActor
    private func pair(_ appearance: String) throws {
        try page("pair", appearance, ["-openPage", "devices"]) { app in
            let b = app.buttons["pair-device"]
            if b.waitForExistence(timeout: 12) { b.tap() }
            return app.staticTexts["K7QM-4XPD"]
        }
    }

    /// The chat list with no chat open: on iPhone the drawer, as Android's side panel.
    @MainActor func testDrawerLight() throws { try drawer("light") }
    @MainActor func testDrawerDark() throws { try drawer("dark") }

    /// The first screen, with no hub paired (the simulator's keychain is empty).
    @MainActor func testConnectLight() throws { try connect("light") }
    @MainActor func testConnectDark() throws { try connect("dark") }

    @MainActor
    private func chat(_ orientation: String, _ appearance: String) throws {
        let dir = try folder()
        guard list("SHOT_ORIENTATIONS", "landscape,portrait").contains(orientation),
              list("SHOT_APPEARANCES", "light,dark").contains(appearance) else { throw XCTSkip("not asked for") }
        // the last things the transcript draws: the approval and question cards from the mock hub
        try shoot(dir, "\(prefix)-\(orientation)-\(appearance)", orientation, appearance, ["-mockHub", "-openChat", "s1"]) { $0.buttons["Allow once"] }
    }

    @MainActor
    private func picker(_ appearance: String) throws {
        let dir = try folder()
        guard prefix == "ipad", list("SHOT_ORIENTATIONS", "landscape,portrait").contains("landscape"),
              list("SHOT_APPEARANCES", "light,dark").contains(appearance) else { throw XCTSkip("not asked for") }
        try shoot(dir, "\(prefix)-picker-\(appearance)", "landscape", appearance, ["-mockHub", "-openChat", "s1"]) { app in
            let chip = app.buttons["Model"]
            if chip.waitForExistence(timeout: 10) { chip.tap() }
            return app.staticTexts["OpenAI"]
        }
    }

    @MainActor
    private func drawer(_ appearance: String) throws {
        let dir = try folder()
        guard prefix == "iphone", list("SHOT_APPEARANCES", "light,dark").contains(appearance) else { throw XCTSkip("not asked for") }
        try shoot(dir, "\(prefix)-drawer-\(appearance)", "portrait", appearance, ["-mockHub"]) { $0.buttons["New chat"] }
    }

    @MainActor
    private func connect(_ appearance: String) throws {
        let dir = try folder()
        guard env["SHOT_CONNECT"] == "1", list("SHOT_APPEARANCES", "light,dark").contains(appearance) else { throw XCTSkip("not asked for") }
        try shoot(dir, "\(prefix)-connect-\(appearance)", "portrait", appearance, []) { $0.staticTexts["Connect to your hub"] }
    }

    private var prefix: String { env["SHOT_PREFIX"] ?? "ipad" }
    private func list(_ key: String, _ fallback: String) -> [String] { (env[key] ?? fallback).split(separator: ",").map(String.init) }

    private func folder() throws -> String {
        guard let dir = env["SHOTS"] else { throw XCTSkip("SHOTS is not set") }
        return dir
    }

    /// Launches, waits at most 15 s for `ready`, then writes NAME.png and NAME.txt (element frames,
    /// to check layout in CI without a Mac). On a miss: fail-NAME.png and an attachment, then fail.
    @MainActor
    private func shoot(_ dir: String, _ name: String, _ orientation: String, _ appearance: String,
                       _ args: [String], ready: (XCUIApplication) -> XCUIElement) throws {
        XCUIDevice.shared.appearance = appearance == "dark" ? .dark : .light
        XCUIDevice.shared.orientation = orientation == "landscape" ? .landscapeLeft : .portrait
        let app = XCUIApplication()
        app.launchArguments = args + ["-appearance", appearance]
        app.launch()
        let folder = URL(fileURLWithPath: dir)
        guard ready(app).waitForExistence(timeout: 15) else {
            let screen = XCUIScreen.main.screenshot()
            let shot = XCTAttachment(screenshot: screen)
            shot.name = "fail-\(name)"
            shot.lifetime = .keepAlways
            add(shot)
            add(XCTAttachment(string: app.debugDescription))
            // also in the shots artifact, which is easier to open than the xcresult
            try? Self.upright(screen.image).write(to: folder.appendingPathComponent("fail-\(name).png"))
            XCTFail("\(name): what it waits for did not show in 15 s")
            return
        }
        sleep(2)
        try Self.upright(XCUIScreen.main.screenshot().image).write(to: folder.appendingPathComponent("\(name).png"))
        try app.debugDescription.write(to: folder.appendingPathComponent("\(name).txt"), atomically: true, encoding: .utf8)
    }

    /// The screen's pixels stay portrait with an EXIF turn; drawing applies it, so a landscape shot is landscape.
    private static func upright(_ image: UIImage) -> Data {
        let format = UIGraphicsImageRendererFormat()
        format.scale = image.scale
        return UIGraphicsImageRenderer(size: image.size, format: format).pngData { _ in image.draw(at: .zero) }
    }
}
