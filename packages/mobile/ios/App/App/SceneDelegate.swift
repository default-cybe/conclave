import UIKit
import Capacitor
import WebKit

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = AppViewController()
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}

/// The web view shows the app's ground (Ground in Assets.xcassets, light or
/// dark with the system) until the page paints, so the launch never flashes
/// the other theme. Added by packages/mobile/scripts/ios-assets.ts.
class AppViewController: CAPBridgeViewController {
    private let ground = UIColor(named: "Ground") ?? .systemBackground

    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        webView?.backgroundColor = ground
        webView?.scrollView.backgroundColor = ground
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        view.window?.backgroundColor = ground
    }
}
