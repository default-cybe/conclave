# Conclave

Your own hub for AI agents. Chat and code with any model, from any device. Your chats, code and keys stay on your hardware.

Website and full guide: https://conclave.dymnitguys.com

Releases now live in [default-cybe/conclave](https://github.com/default-cybe/conclave/releases/latest). This repo (conclave-releases) only keeps copies for installs made before 0.4.16, which still look for updates here. It will be archived once those have moved.

## 1. Run the hub

The hub is the part that runs all the time, on a server, a mini PC, a NAS or a Proxmox box. Pick one.

**Docker**

```sh
curl -fsSLO https://github.com/default-cybe/conclave/releases/latest/download/docker-compose.yml
docker compose up -d
```

Then open http://localhost:7717 on that machine.

**Proxmox (LXC container)**, on the Proxmox host:

```sh
curl -fsSLO https://github.com/default-cybe/conclave/releases/latest/download/conclave-lxc.sh
sh conclave-lxc.sh
```

**Linux or macOS**, without Docker:

```sh
curl -fsSL https://github.com/default-cybe/conclave/releases/latest/download/install.sh | sh
```

## 2. Install the apps

| Device | File |
| --- | --- |
| Windows | `Conclave_<version>_x64-setup.exe` or `.msi` |
| Mac, Apple silicon | `Conclave_<version>_aarch64.dmg` |
| Mac, Intel | `Conclave_<version>_x64.dmg` |
| Linux | `.AppImage`, `.deb` or `.rpm` |
| Android | `conclave-<version>.apk` |
| iPhone | Open your hub in Safari, then Share, Add to Home Screen |

The apps are not signed by Apple or Microsoft yet. On a Mac, right click the app and choose Open the first time. On Windows, choose More info, then Run anyway.

## 3. Pair a device

In the hub's web app, open Devices, Pair a device, and scan the code with the app, or type the code it shows.
