# Conclave for iPad and iPhone

The native SwiftUI client. `project.yml` generates the Xcode project with XcodeGen; CI
(`.github/workflows/ios.yml`) builds and tests it, and `.github/workflows/ios-release.yml` builds the
installable IPA.

## Install on iPad with SideStore

SideStore installs apps with a free Apple ID and signs them on the iPad itself. CI builds an
unsigned `Conclave.ipa` and a SideStore source that points at it, so updates come straight from
GitHub with no Mac.

### 1. Set up SideStore (once)

You need a computer one time, to install SideStore and make the iPad's pairing file. Follow the
official guide, which has the current steps for Windows, macOS, Linux and ChromeOS:
https://docs.sidestore.io/docs/installation/prerequisites

In short: set a passcode on the iPad, install iloader (https://iloader.app/) on the computer,
connect the iPad by cable and sign in with your Apple ID, then let iloader install SideStore and
its pairing file. On the iPad, install LocalDevVPN from the App Store. SideStore needs that VPN
switched on whenever it installs, updates or refreshes an app. After this you do not need the
computer again.

### 2. Add the Conclave source

In SideStore, open **Sources**, tap **+** and add:

```
https://github.com/default-cybe/conclave/releases/download/ios-preview/sidestore-source.json
```

That is the preview source. CI rebuilds it on every push to `feat/ios-native`. Once the app ships
in a normal Conclave release (`v*` tag), use the release source instead:

```
https://github.com/default-cybe/conclave/releases/latest/download/sidestore-source.json
```

### 3. Install Conclave

Open the source, tap **Conclave**, then **Free** (or **Install**). With LocalDevVPN on, SideStore
downloads the IPA, signs it with your Apple ID and installs it. A newer CI build shows up as an
update in SideStore's **My Apps**.

### 4. Keep it running

- A free Apple ID signs apps for 7 days. SideStore refreshes them by itself in the background
  (and when you open it) while LocalDevVPN is on. Open SideStore now and then; when an app
  expires, open SideStore and tap **Refresh All**.
- A free Apple ID can have at most 3 sideloaded apps active at a time, and SideStore counts as
  one, so Conclave and SideStore leave room for one more.

### 5. Pair with your hub

On first launch Conclave shows **Connect to your hub**. On the hub, open **Devices** and tap
**Pair a device** to show the pairing QR code. In the app, tap **Scan QR code** and point the
camera at it. Without a camera, use **Use address and password** instead.
