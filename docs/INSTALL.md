# Installing Conclave

There are two things to install:

- **The hub**, on your home server or a computer that stays on: Docker
  Compose, a Proxmox container, or any Linux container or VM (section 1),
  then the setup in the web app (sections 2 and 3). It
  holds every chat, the memory, the scheduler and your provider keys, and
  serves the web app. It can also sign in to the AI plans you already pay for
  (Claude, ChatGPT, Google, Grok, Kimi, Muse) through CLIProxyAPI, a separate
  program it downloads and runs for you (section 4).
- **The desktop app**, on each PC and Mac: sign in with a pairing code (or
  a name and password) and leave **Let the hub use this computer** on
  (section 5). The app carries the daemon, the small program that lets the
  hub use this computer's files, shells and coding tools. It connects out
  to the hub, so it opens no ports.

With one computer and no server, the desktop app can be the hub as well:
choose **Run the hub on this computer** on its first page (section 1d).

Phones install the app and scan the code (section 6). The desktop app also
puts the terminal app on your PATH as `conclave`, signed in to the same hub
(section 5, The terminal command). Without the desktop app, the terminal app
and a daemon come from an install script (section 5, Without the desktop
app). Section 7 covers the desktop app day to day.

Devices reach the hub with nothing else to install. On the same Wi-Fi they
connect straight away. Away from home the hub can run its own Cloudflare
tunnel and get an https address, with no account, the way Claude Code reaches
its own servers. Tailscale and your own reverse proxy still work if you prefer
them (section 2).

Do the sections in order. Replace `https://hub.example.com` with your hub's
address throughout. Settings > Remote access shows it, and so does
`conclave remote`.

## 1. Server

Pick one of four ways to run the hub:

- **Docker Compose**, on any machine with Docker (1a).
- **A Proxmox container (LXC)**, made by one script on the Proxmox host (1b).
- **Any other LXC container or a VM**: Incus, LXD, plain LXC, or a virtual
  machine with Debian 12 or 13 or Ubuntu 24.04 (1c).
- **The desktop app**, on the one computer you use, when there is no server
  (1d). You can move to a server later.

The containers and VMs run the hub as a systemd service with
`scripts/lxc/setup.sh`. The table at the end of this section says where code
and data live in each case.

### 1a. Docker Compose

You need Docker with the Compose plugin. The compose file pulls the image
`ghcr.io/default-cybe/conclave`:

```sh
mkdir conclave && cd conclave
curl -fsSLO https://github.com/default-cybe/conclave/releases/latest/download/docker-compose.yml
docker compose up -d
```

From a checkout of the source, `docker compose up -d --build` builds the
image instead.

The hub keeps its data in the `conclave_conclave-data` volume. Compose
publishes port 7717 on `127.0.0.1` only, so other devices reach it through
remote access (section 2). To let phones on your Wi-Fi in as well, change the
port line in `docker-compose.yml` to `"7717:7717"`. Inside Docker the hub
cannot see the server's own Wi-Fi address, so pairing codes leave it out: on
the phone, type `http://<server address>:7717` with the code, or turn on
remote access. Run Conclave commands
inside it with `docker compose exec hub conclave <command>`.

To update later: `docker compose pull && docker compose up -d` with the
published image, or `git pull && docker compose up -d --build` from a clone.
The hub shows the command in Settings, About when a new release is out
(section 14).

The hub runs as the `conclave` user. Its home is `/data/home`, in the same
volume, and `/home/conclave` links to it. Sessions with no folder picked start
there. Harness logins (`~/.claude`, `~/.codex`), git config and anything else
in home survive an update or a new container. To give the hub folders from the
server, add bind mounts under it in `docker-compose.yml`, for example
`- /srv/projects:/data/home/projects`, writable by the hub's user
(`docker compose exec hub id` shows its uid).

**Updating from an image older than this.** Older images kept home in
`/home/conclave`, outside the volume, and lost it whenever the container was
made again. To keep what is in it, copy it out before you update and back in
after:

```sh
docker compose cp hub:/home/conclave/. ./conclave-home
git pull && docker compose up -d --build
docker compose cp ./conclave-home/. hub:/data/home/
docker compose exec -u root hub chown -R conclave:conclave /data/home
```

Otherwise sign in to Claude Code, Codex and other harnesses once more (only
needed when you turned one on as an engine, section 3), and set your git
config again. Sessions that used `/home/conclave` as their folder keep
working through the link.

### 1b. Proxmox LXC

On the Proxmox VE host, as root:

```sh
git clone https://github.com/default-cybe/conclave.git
sh conclave/scripts/proxmox/conclave-lxc.sh --dry-run   # shows every command
sh conclave/scripts/proxmox/conclave-lxc.sh
```

Without git on the host, download the one script. It fetches `setup.sh` and
`install.sh` from GitHub itself:

```sh
curl -fsSLO https://github.com/default-cybe/conclave/releases/latest/download/conclave-lxc.sh
sh conclave-lxc.sh
```

It makes an unprivileged Debian container (CT), starts it, copies
`scripts/lxc/setup.sh` into it with `pct push` and runs it with `pct exec`.
The template is the newest Debian standard one: Debian 13 on Proxmox VE 9,
Debian 12 on Proxmox VE 8. `pveam` downloads it when it is missing. The
defaults, each with its flag and environment variable:

| Setting | Default | Flag | Variable |
| --- | --- | --- | --- |
| CT id | the next free id (`pvesh get /cluster/nextid`) | `--id` | `CT_ID` |
| Hostname | `conclave` | `--hostname` | `CT_HOSTNAME` |
| CPU cores | 2 | `--cores` | `CT_CORES` |
| Memory | 4096 MB, swap 512 MB | `--memory`, `--swap` | `CT_MEMORY`, `CT_SWAP` |
| Disk | 16 GB on `local-lvm` (else `local-zfs`, else the first storage for containers) | `--disk`, `--storage` | `CT_DISK`, `CT_STORAGE` |
| Network | bridge `vmbr0`, DHCP | `--bridge`, `--ip 192.168.1.50/24 --gw 192.168.1.1`, `--vlan` | `CT_BRIDGE`, `CT_IP`, `CT_GW`, `CT_VLAN` |
| Start at boot | on | `--no-onboot` | `CT_ONBOOT=0` |
| Root login key | none (use `pct enter`) | `--ssh-key FILE` | `CT_SSH_KEY` |

The CT always has `features: nesting=1`, which systemd in Debian 12 and 13
needs. `sh conclave-lxc.sh --help` lists every option.

It asks two questions before it starts:

- **Install the root helper?** (default yes). Then the hub can add the system
  packages it needs by itself, such as the browser's libraries, from a button
  in Settings. Section 16 says what it is and how to remove it.
  `--root-helper` or `--no-root-helper` answers it ahead, `CT_ROOT_HELPER=1`
  or `0` too.
- **Install the browser's libraries now?** (default no: about 150 MB). The hub
  can do it later. `--browser-libs` or `--no-browser-libs`, `CT_BROWSER_LIBS`.

An update (`conclave-lxc.sh update <id>`) asks nothing and keeps the CT's
answers.

**Where to run things.** Commands for the hub run inside its CT, as root
there, never on the Proxmox host itself. Three ways in:

- From the Proxmox host shell, put `pct exec <id> --` in front of the
  command, where `<id>` is the CT's number:
  `pct exec <id> -- conclave system-helper install`.
- `pct enter <id>` opens a root shell in the CT; type the commands there and
  `exit` when done.
- In the Proxmox web UI, pick the CT in the tree and open its **Console**.

The page that needs a command says which one and where, and fills in the CT
id when it can tell it from inside the CT (from the CT's disk name on
LVM-thin, ZFS and btrfs storage). Elsewhere it shows `<CTID>`.

When it is done, `setup.sh` prints the hub's address on your network, such as
`http://192.168.1.50:7717`. The CT has its own address on your LAN, so phones
and computers on the same network can use it right away. For the first run
(section 3), open a shell in the CT and run the commands there:

```sh
pct enter <id>
conclave remote          # the address and a login link for your browser
conclave pair-phone      # a pairing code and QR code for the apps
conclave password set    # optional: a hub password
```

`pct exec <id> -- conclave remote` works too, for commands that ask nothing.
Logs: `journalctl -u conclave-hub -f` in the CT.

To update: **Update now** in Settings, About of the web app (section 14), or
`sh conclave-lxc.sh update <id>`. That copies the current `setup.sh` into the
CT and runs it again, which updates Conclave in place and keeps the choices of
the first run. A CT set up before updates from the app needs that once.

**A projects folder from the host.** `--projects /tank/projects` bind mounts
that host folder at `/home/conclave/projects` in the CT. The CT is
unprivileged, so uid N inside is uid 100000+N on the host. The `conclave`
user is uid 1000 inside, so on the host it is uid 101000. A new folder is made
with that owner. A folder that exists already is left as it is. Either give
it to that uid:

```sh
chown -R 101000:101000 /tank/projects
```

or map uid 1000 straight through, so the hub writes files as your own host
user 1000. Add these lines to `/etc/pve/lxc/<id>.conf`, add the line
`root:1000:1` to both `/etc/subuid` and `/etc/subgid`, and restart the CT:

```
lxc.idmap: u 0 100000 1000
lxc.idmap: g 0 100000 1000
lxc.idmap: u 1000 1000 1
lxc.idmap: g 1000 1000 1
lxc.idmap: u 1001 101001 64535
lxc.idmap: g 1001 101001 64535
```

**A big drive for Move to hub.** Move to hub copies a session's whole folder
(node_modules and build output too) to `projects.hubRoot` on the hub, by
default `/srv/conclave-projects` when that folder is there and writable. Give
it a folder of a big drive instead of the CT's root disk. On the Proxmox host,
for CT 135 and a drive at `/mnt/external2`:

```sh
mkdir -p /mnt/external2/conclave-projects
chown 101000:101000 /mnt/external2/conclave-projects   # uid 1000 in the unprivileged CT
pct set 135 -mp0 /mnt/external2/conclave-projects,mp=/srv/conclave-projects
pct reboot 135
```

Use the next free `mpN` if `mp0` is taken (`pct config 135`). With the uid
1000 mapping above, chown to `1000:1000` instead. Check it in the CT with
`df -h /srv/conclave-projects`; Devices, the hub, Projects drive shows the
folder in use and takes another path.

**Release or source.** `setup.sh` installs the newest GitHub release for the
CT's CPU when there is one, with `scripts/install.sh`. Until the first
release, or with `--from git`, it clones `main` from GitHub, runs
`bun install` and builds the web app, which takes a few minutes. For a fork
or a private copy, `--source-dir` copies a checkout on the host into the CT
and installs that, with no GitHub access from the CT:
`sh conclave/scripts/proxmox/conclave-lxc.sh --source-dir conclave`.
`--repo-url` and `--ref` pick another git URL or branch.

### 1c. Incus, LXD, plain LXC or a VM

`scripts/lxc/setup.sh` runs as root in a Debian 12 or 13 or Ubuntu 24.04
system container with systemd, or in a VM. With Incus, from a checkout:

```sh
incus launch images:debian/12 conclave
incus file push scripts/lxc/setup.sh conclave/root/
incus exec conclave -- sh /root/setup.sh
```

A projects folder from the host, with the owner ids shifted so files keep
your host uids (this needs idmapped mounts in the kernel and filesystem):

```sh
incus config device add conclave projects disk source=/srv/projects path=/home/conclave/projects shift=true
```

On the default `incusbr0` network the container has a private address that
other devices cannot reach. Give it an address on your LAN, for example
`incus config device add conclave eth0 nic nictype=macvlan parent=eno1` (the
host itself then cannot reach it), or a bridged NIC, or use remote access
(section 2). `incus exec conclave -- conclave remote` prints the address and a
login link, and `incus exec conclave -- bash` opens a shell for the rest of
section 3.

LXD works the same with `lxc` in place of `incus`, for example
`lxc launch ubuntu:24.04 conclave`. For plain LXC, copy `setup.sh` into the
container's rootfs and run `lxc-attach -n conclave -- sh /root/setup.sh`. In a
VM, copy it over and run `sudo sh setup.sh`, or fetch it there:

```sh
curl -fsSLO https://github.com/default-cybe/conclave/releases/latest/download/setup.sh
sudo sh setup.sh
```

To update, press **Update now** in Settings, About (section 14), or run
`setup.sh` again: it keeps the choices of the last run.
`sh setup.sh --help` lists its options, such as `--from`, `--version`,
`--ref`, `--source-dir`, `--port` and `--projects`. On its first run it asks
the two questions of section 1b (the root helper, default yes; the browser's
libraries, default no), or takes `--root-helper`, `--browser-libs` and their
`--no-` forms; later runs keep the answers.

### 1d. The desktop app as your hub

With one computer and no server, the desktop app (section 5) can run the hub
itself. On its first page choose **Run the hub on this computer**, or turn on
the same switch later in the app's **Settings**, and press **Start the hub**:

1. The app downloads the hub of its own version from the release
   (`conclave-<system>.tar.gz`, or `conclave-windows-x64.zip`, about 40 MB),
   checks it against its `.sha256` and unpacks it into its data folder. Only
   the first start, and the first start after an app update, download.
2. It runs the hub (`conclave serve`) with its own data folder, on port 7717,
   or on the next free port when another program has 7717. The hub listens on
   this computer only (127.0.0.1) until you let phones on your Wi-Fi in
   (below).
3. It signs in to the hub as the owner with no code, and pairs this computer
   so the hub can use it at once (**Let the hub use this computer**, on by
   default).
4. The hub's setup in the web app takes over: keys, models and the rest, as
   in section 3, with no commands to type.

**When it fits.** One computer that you use and that is often on. The hub
runs while the app does, in the window or in the tray: while the computer
sleeps or is off, phones cannot reach it, routines do not run and
notifications wait. **Start at login** is on by default, so the hub is back
when you log in. **Quit** in the tray stops it. For a hub that is always up,
use a server (1a to 1c); you can move there later (below).

**Phones.** **Pair a phone** in the app's Settings or in the tray shows the QR
code. Phones reach the hub through remote access: **Remote access** next to
it opens the hub's **Settings > Remote access**, where a quick tunnel needs
no account (section 2); that works at home and away. To let phones on the
same Wi-Fi connect directly, turn on **Let phones on this Wi-Fi connect**
under the hub's switch in the app's Settings: the hub starts again and
listens on every address of this computer, and its own **Devices on this
network** decides who may use it. It is off by default, so a laptop that
joins a cafe's Wi-Fi does not offer its hub there; leave it off on networks
you do not trust.

**When something goes wrong**, the app's Settings and the first line of the
tray menu say what the hub is doing:

- Port 7717 is taken by another program: the hub uses the next free port and
  says so, and keeps that port from then on.
- You already run `conclave serve` yourself when you first turn the switch
  on: the app uses that hub instead of starting a second one, and never stops
  it. It does so only when that hub runs on the port its own config.json
  sets (7717 unless `server.port` says otherwise).
- The hub stops on its own: the app starts it again after 1, 2, 4 and up to 32
  seconds, with its last error, then waits for **Try again**.
- The download fails (no internet, a version not in the release yet): the app
  says why. A hub that is there already keeps running until the new one
  can be downloaded.
- **Show logs** opens the hub's log folder: `hub.log` (what it printed) and
  `hub-<day>.jsonl` (its own log files, section 12). The folder and its files
  are yours only, and the owner token is not in them.

Its data folder (`CONCLAVE_HOME`) is `hub` in the app's data folder:

- Linux: `~/.local/share/dev.conclave.desktop/hub`
- macOS: `~/Library/Application Support/dev.conclave.desktop/hub`
- Windows: `%LOCALAPPDATA%\dev.conclave.desktop\hub`

`conclave` in a terminal (section 5, The terminal command) signs in to this
hub by itself while the app runs it. A command that works on the hub's own
files takes that folder as `CONCLAVE_HOME`, for example
`CONCLAVE_HOME=~/.local/share/dev.conclave.desktop/hub conclave secret anthropic`.
A build of the app made by hand has no release to download from: set
`CONCLAVE_HUB_BIN` to a `conclave` binary (from `bun scripts/build-cli.ts`,
with `web/` next to it) before starting the app.

**Moving to a server later:**

1. In the hub, open **Settings > About** and **Download a backup**, with
   **Keys and secrets** on.
2. Set up the server (1a to 1c). On the first page of its setup in the web
   app, choose **Restore from a backup** and pick the file. Sessions, notes,
   tasks, settings, agents, routines and keys come over; watch items and goals
   are not in backups yet.
3. In the desktop app, open **Change hub...** in the tray, choose **Connect
   to a hub** and connect to the server with a pairing code. That stops the
   hub on this computer. Its data folder stays until you delete it.
4. Pair phones and other computers with the server again: it has its own
   key, and tokens are not in backups.

### Where code and data live

| | Docker Compose | LXC container or VM (`setup.sh`) | Desktop app (1d) |
| --- | --- | --- | --- |
| Code | in the image, `/app` | `/opt/conclave`: `release/` for a release, `src/` for the source | `hub-bin/v<version>` in the app's data folder |
| Hub data (`CONCLAVE_HOME`): config, secrets, database | the `conclave_conclave-data` volume, at `/data` | `/var/lib/conclave` | `hub` in the app's data folder |
| Hub user's home: harness logins, git config, sessions with no folder | `/data/home`, in the same volume | `/home/conclave` | your own home |
| Projects | bind mounts you add | `/home/conclave/projects`, or a bind mount or disk device there | your own folders |
| Environment, such as provider keys | `.env` next to `docker-compose.yml` | `/etc/conclave/env`, then `systemctl restart conclave-hub` | the app's environment, with your login shell's PATH; keys go in the web app |
| Logs | `/data/logs/hub-<day>.jsonl` (section 12), and `docker compose logs hub` | `/var/lib/conclave/logs/hub-<day>.jsonl` (section 12), and `journalctl -u conclave-hub` | `hub/logs/hub-<day>.jsonl` (section 12), and `hub/logs/hub.log` |
| Conclave commands | `docker compose exec hub conclave ...` | `conclave ...` as root in the container | `conclave ...` (section 5, The terminal command), with `CONCLAVE_HOME` set to the data folder for its files |
| Backup | the volume | the whole CT (Proxmox backup), or `/var/lib/conclave` and `/home/conclave` | Settings > About > Download a backup, or the `hub` folder while the hub is stopped |

In a container or VM the code belongs to root, so the hub and its sessions
cannot change it. `conclave` run as root switches to the `conclave` user, so
the hub can still read what it writes. The unit is
`scripts/systemd/conclave-hub.service`, run as a system service through the
drop-in `/etc/systemd/system/conclave-hub.service.d/10-setup.conf`. Put your
own changes in another drop-in (`systemctl edit conclave-hub`); `setup.sh`
leaves it alone.

On a machine with no Docker and no container, the install script (section 5,
Without the desktop app) installs Conclave for your own user. Run
`conclave serve`, or use `scripts/systemd/conclave-hub.service` as a systemd
user unit.

## 2. Remote access

Pick one way in. You can change it any time in the web app under
**Settings > Remote access**, in setup step 1, or with `conclave remote`.
Pairing codes, the login link and notification links always carry the best
address the hub has: a stable tunnel, then a quick tunnel, then your own URL,
then the same network. Paired apps and computers keep every address and try
the next one when one stops answering.

### Same network (on by default)

The hub listens on every interface and answers devices on private networks
(home and office Wi-Fi, 10.x, 172.16 to 31, 192.168.x, link-local and
100.64/10). Phones on the same Wi-Fi scan the pairing code and connect. The
internet is never answered directly. This is plain http, so keep it to
networks you trust.

To answer only this computer, turn **Devices on this network** off in
Settings > Remote access, run `conclave remote lan off`, or start the hub with
`conclave serve --host 127.0.0.1`. A `--host`, `CONCLAVE_HOST` or a
`server.host` other than `127.0.0.1` pins the address and turns this filter
off.

### Quick tunnel (built in, no account)

```sh
conclave remote quick
# Docker: docker compose exec hub conclave remote quick
```

The first time, the hub downloads `cloudflared` from Cloudflare's GitHub
releases into `~/.conclave/bin` (in Docker, `/data/bin`). It checks the size
and the SHA-256 that GitHub publishes for the file, that it is a program for
this computer, and that it starts, before it uses it. When GitHub's API does
not answer, it checks everything but the SHA-256, and Settings > Remote
access says so. It never runs anything from a temp folder. To use a
`cloudflared` you installed yourself, set `server.remote.cloudflared` to its
path. Then the hub runs a quick tunnel, reads the
`https://<words>.trycloudflare.com` address it prints, restarts it if it
stops, and stops it with the hub. If the hub is killed, the next start stops
the `cloudflared` it left behind.

Cloudflare carries the traffic and its https ends at Cloudflare, as for any
site behind Cloudflare. Your hub token still guards everything (see below).
For traffic only your devices can see, use Tailscale.

The address changes whenever the tunnel restarts, which includes every hub
restart. Apps and computers that are connected get the new address before the
old one stops, and follow it. One that was away falls back to the same
network, or you scan a new code. For an address that never changes, use the
stable option. To start it on every boot without the web app, set
`CONCLAVE_REMOTE=quick` in the hub's environment (for Docker, in `.env`).

### Stable address on your Cloudflare domain

For a fixed name such as `https://conclave.example.com`, you need a domain on
a Cloudflare account (the free plan works).

1. In the Cloudflare dashboard open **My Profile > API Tokens > Create
   Token**, start from **Create Custom Token**, and give it two permissions:
   **Account, Cloudflare Tunnel, Edit** and **Zone, DNS, Edit** (for the
   domain you want to use).
2. In Settings > Remote access pick **Stable address on your domain**, paste
   the token, pick the domain and a name, and press **Set up**. From a
   terminal: `conclave remote stable --cf-token <token> --zone example.com
   --name conclave`.

The hub makes a named tunnel and a DNS name on that domain, keeps the token in
its secrets store, and runs the tunnel itself. **Remove** deletes both at
Cloudflare and forgets the token.

### Tailscale

If every device already runs Tailscale:

1. On the hub, log in (`sudo tailscale up`) and turn on **HTTPS Certificates**
   on the DNS page of the Tailscale admin console (once per tailnet).
2. Serve the hub on the tailnet: `sudo tailscale serve --bg 7717`.
3. Pick **Tailscale** in Settings > Remote access and press **Find it**, or run
   `conclave remote tailscale`.

### Your own URL

Behind a reverse proxy you run (Caddy, nginx, Traefik), a Cloudflare tunnel
you already run, or a domain you already point at the hub:
`conclave remote url https://hub.example.com`, or **My own URL** in Settings.
Have the proxy set `X-Forwarded-For` so rate limits see the real client
address (cloudflared sets it and `CF-Connecting-IP` on its own).

With your own Cloudflare tunnel, add a public hostname to it (Zero Trust >
Networks > Tunnels > your tunnel > Public Hostname): the name you want, type
HTTP, URL `localhost:7717` when cloudflared runs on the hub's machine, or the
hub's address such as `192.168.1.50:7717` when it runs elsewhere. Do not put
Cloudflare Access in front of it: the apps cannot pass its login page, and the
hub checks every request itself.

The hub believes these headers only from this machine. When the proxy or
cloudflared runs on another machine, list its address, or every visitor
counts as that one machine and a stranger's wrong tokens lock everyone out
for a while:

```sh
conclave config set server.trustedProxies '["192.168.1.20"]'
```

### Friends

Friends (another owner's Conclave hub, see `docs/design/FRIENDS.md`) reach
your hub at its outside address, so they need a quick or stable tunnel or your
own URL. Tailscale serves only your tailnet, and with remote access off only
your own network answers. `conclave friends invite` prints a link and a QR
code that one friend can use for 24 hours; it warns when friends cannot reach
the hub. A hub that friends cannot reach still fetches what they hold for it
whenever it can reach theirs.

### What an outside address exposes

Anyone who learns the address can reach the hub, so everything there checks
first:

- **The web app** loads the sign-in screen. Nothing in it works without a
  token.
- **The API and live updates** (`/api`) need the hub token or a paired
  device's token.
- **The MCP server** (`/mcp`) needs a token, a gateway key, or an OAuth
  token from an app you allowed (claude.ai, ChatGPT). An app can only use
  the tools its scopes allow, and its token works nowhere else.
- **App sign in** (`/.well-known/oauth-protected-resource`,
  `/.well-known/oauth-authorization-server`, `/oauth/register`,
  `/oauth/authorize`, `/oauth/token`, `/oauth/revoke`): anyone can read the
  sign in details and register an app, but an app gets nothing until you
  press Allow on the consent page while signed in to the hub. Codes work
  once for 10 minutes, access tokens last an hour and refresh tokens change
  on every use. Over plain http these refuse to work, except on this
  computer. Settings > Connected apps lists the apps and revokes them.
- **The model gateway** (`/gw`) needs a gateway key. Calls from the internet
  cannot pass on their own provider login without one, unless you set
  `gateway.relay` to `open`.
- **Pairing codes** work once and expire after 10 minutes. Ten wrong codes
  from one address block it, for longer each time.
- **Password login** (`/api/login`) is off until you set a hub password.
  Wrong passwords count with wrong pairing codes, so ten from one address
  block it the same way. Apps send a password only over https or to an
  address on your own network.
- **The identity check** (`/api/identity`) needs nothing. It only signs the
  random value an app sends, with the hub's key, so the app knows it reached
  your hub before it sends its sign-in.
- **Friends' hubs** (`/peer/v1`) need a request signed by a friend's hub key,
  checked for its age, its recipient and a fresh nonce. The one exception is
  the friend request, which needs one of your invites: each works for one
  hub for 24 hours, at most 3 requests wait, and wrong invites count like
  wrong pairing codes.
- **Wrong tokens**: twenty different ones from one address in 10 minutes
  block it for a minute, then two, four, up to an hour. An app that keeps
  retrying one old token counts once, so it cannot lock out the rest of your
  home. Wrong OAuth tokens, codes and refresh tokens count the same way.
  Requests through a tunnel or proxy always count, whatever their headers
  say; only this computer itself is never blocked.

Blocks, wrong pairing codes and passwords, new pairings and logins, app
registrations, consents, revokes and every remote access change go in the
audit log (Settings > Audit log).

## 3. First run: keys and login

The commands here are for Docker. In an LXC container or VM (sections 1b and
1c), run them as root in the container without `docker compose exec hub`, for
example `conclave secret anthropic`.

1. Add a key for at least one model provider. You are asked for the key, and
   it is not echoed:

   ```sh
   docker compose exec hub conclave secret anthropic
   ```

   Other provider names: `openai`, `google`, `zai`, `openrouter`.

   `zai` is the Z.ai Coding Plan over Chat Completions at
   `https://api.z.ai/api/coding/paas/v4`, as opencode uses it. Before 0.4.21
   it used the Anthropic endpoint `/api/anthropic`, which drops tools from long
   tool lists. A config that names the old address moves to the new one when
   the hub loads it.

   Keys set as environment variables on the hub (`ANTHROPIC_API_KEY` and the
   like) and the hub's own `CONCLAVE_TOKEN` are never passed to the shells,
   hooks and tools that sessions start, so a session cannot read them. If you
   need one of them in your shells anyway, name it in `CONCLAVE_PASS_ENV`
   (comma separated).

2. Get your login link and open it in your computer's browser:

   ```sh
   docker compose exec hub conclave remote
   ```

   It prints the hub's address and a login link for it. (`docker compose logs
   hub | grep Login` shows the one from the last start.) The link carries the
   hub's admin token. Do not share it.

3. Everything else is paired with a one-time code (valid 10 minutes). Make
   one on the **Devices** page of the web app, or on the server with
   `docker compose exec hub conclave pair-phone`, which also shows a QR code.

   The hub has its own key, made on first start and kept in its data folder
   (`hub-key.pem`). `conclave pair-phone` and Settings show its fingerprint, eight
   groups of four characters. The QR code carries it, and each app keeps the
   key: before it sends its sign-in to an address, it checks that the hub
   there holds the key. A machine that now answers at an old address (a
   reused Wi-Fi address, an old tunnel name) gets nothing, and the app says
   "This address is not your hub."

4. Optional: a hub password, for logging in without a code (a phone with no
   camera at hand). It is off until you set one:

   ```sh
   docker compose exec hub conclave password set
   ```

   It asks twice and does not echo, and needs 12 characters or more. Apps
   then log in with the hub's https address and the password, and show the
   hub's fingerprint once: check that it matches the one in Settings.
   `conclave password clear` turns it off.

**Start.** The top bar has three choices: **Chat** (a plain chat with the
web and your memory), **Assistant** (your assistant on the hub: your day,
goals and setup, no folder) and **Code** (the coding agent in a folder on
your computer; it hands work to its subagents itself). In the desktop app
Code starts on that computer while the hub may use it; in a browser it
starts on the hub ("madx (hub)") unless you picked another device in that
browser before; on a phone it starts on the last computer you used. It asks
for the folder before the first message. Everything else (attach, web and memory, another
agent, the device, a GitHub repository, Ultra) is under **+** in the box;
the other pages are under **More**.

**Claude Code, Codex, Gemini CLI and OpenCode as engines are optional and
off.** Conclave runs its own agent loop. To run a session through one of
them with its own login, turn it on in **Settings > Providers** (Coding
agents as engines) or in setup step 4, then pick it in the model picker.
`conclave config set providers.claude-code.enabled true` does the same.
Importing their past chats works either way. A hub from before v0.4.2 kept
on, once, the ones you had turned on by hand or used in the last 30 days.

### Web search

WebSearch uses DuckDuckGo until you set up an engine, and DuckDuckGo often
answers a hub with a bot check. Open **Settings > Web search** (owner only),
pick an engine, follow its numbered sign-up steps, paste the key, press
**Save**, then **Test** (one real search). The engines listed have a free
allowance for personal use: Tavily (1,000 credits a month, no card), Exa
($10 of credit a month, no card), Brave Search ($5 of credit a month, about
1,000 searches, card needed) and Jina (a one-time 10M tokens,
non-commercial). SearXNG takes the address of your own server instead of a
key. **Automatic** uses the first engine with a key or address; **Use** pins
one. Keys are hub secrets (`search.<engine>`), never written to config.json
and never sent back to an app. The environment variables still work:
`TAVILY_API_KEY`, `EXA_API_KEY`, `BRAVE_API_KEY`, `JINA_API_KEY`,
`SEARXNG_URL`.

## 4. Subscriptions: sign in to Claude, ChatGPT and more

The hub can use the plans you already pay for instead of API keys. Setup
step 2 ("Sign in to your AI subscriptions") and **Settings > Models >
Subscriptions** show one row each for Claude, ChatGPT, Google, Grok, Kimi
and Muse. Sign in, and every model those accounts give shows up in the model
picker, as `cliproxy/<model>`. It is off until you sign in or pick a mode,
so a hub that never uses it is unchanged.

A model your plan and your API key both give shows once in the pickers
(web, Android and `conclave models`), under its maker, by its plain name
("Opus 5.5"), with the route as a quiet hint: "your Claude plan, then API
key". The call goes to the first account in your order below that has it,
and to the next when that one is at its limit, signed out or out of
budget. Sessions and agents that name `anthropic/claude-opus-5-5` or
`cliproxy/claude-opus-5-5` keep working and show as that one entry; the
usage rows still say which plan or key paid. A person on your hub (section
13) sees only the routes they may use.

### How it works

[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) is a separate
open source project (MIT license). The hub does not include it; on first use
it downloads release **8.0.32** for your system into `~/.conclave/bin`
(`/data/bin` in Docker) and checks it before it runs:

- the release's `checksums.txt` lists the archive, with the SHA-256 that
  Conclave pins for that version;
- the archive has the pinned size and that SHA-256;
- the program inside is a program for this computer and `cli-proxy-api -h`
  prints version 8.0.32.

It is unpacked next to its final place and renamed in, never run from a temp
folder. On Linux it is the static `no-plugin` build, so it runs on any
distribution and in the Docker image.

The hub writes its config to `~/.conclave/cliproxy/config.yaml` and keeps
the signed in accounts in `~/.conclave/cliproxy/auth` (both readable only by
the hub's user). It runs CLIProxyAPI on `127.0.0.1` on a free port, starts it
again when it stops, stops it with the hub, and stops one a crashed hub left
behind. Settings shows the version, the program and whether its checksum
matched.

### Signing in

**Sign in** opens the provider's own sign-in page in a new tab:

- **Claude, ChatGPT, Google**: at the end the provider sends your browser to
  a `localhost` address. When the browser runs on the hub's own computer the
  hub answers there and the sign-in finishes by itself. Anywhere else (your
  laptop with the hub on a server, a phone, a hub in Docker) that last page
  does not load. That is expected: copy its address from the browser bar,
  paste it into the box under the row, and press **Finish sign-in**.
- **Grok, Kimi, Muse**: the page asks for a short code, which Conclave shows.
  The row updates when you are done.

You can sign in to more than one account of the same plan. They are used
in your order (below), one at a time. An account with a short name (set in
Settings > Models > Accounts) also shows its models as
`neu/claude-opus-5-5` and so on, under "Second account" in Settings.
**Remove** signs an account out; **Refresh** asks the provider for a new
token now.

Claude models go to CLIProxyAPI's Anthropic endpoint (`/v1/messages`), so
thinking and prompt caching work as with an API key. GPT models use the
Responses endpoint (`/v1/responses`), so an image a tool returns stays inside
that tool's result. Gemini models (bare ids, not `neu/gemini-*`) use the
native Gemini endpoint (`/v1beta/models/...`), so tool results pair by name
and thought signatures survive. The rest use Chat Completions.

### New models without an update

The model list comes from your accounts: CLIProxyAPI's list, then each
signed in account's own list, and for Codex and the other coding agents the
models the agent reports for your login. A model your account offers before
Conclave knows it (Codex's "Daybreak", for example) shows by its own name.
For a ChatGPT plan the hub also reads the plan's own model list, the way
the Codex app does. CLIProxyAPI serves only the models in its catalog, so
when the plan lists one the catalog lacks, the CLIProxyAPI the hub runs for
you gets it added to that plan's part of its catalog, and the model shows
and answers. Your own CLIProxyAPI's catalog is left alone: there such a
model shows once CLIProxyAPI's catalog has it.
The lists are read again every 10 minutes and on every coding agent turn. To
read them now, press **Refresh models** in **Settings > Models >
Subscriptions** (Models). It also starts each coding agent that is on, once,
to ask for its list. One that cannot be asked keeps its last list, then the
built-in one, and the message says which.

### Accounts and their order

**Settings > Models > Accounts** lists every signed in plan and every API
key, per vendor, in the order the hub uses them. The first takes the call;
the next takes over when it is at a limit, resting after errors, or paused.
Plans come before API keys unless you move them. So with Account 1, then
Account 2, then the Claude API key, `opus`, `sonnet`, `claude-sonnet-5-5`
and `anthropic/claude-sonnet-5-5` all go to Account 1 while it has room, and
to the key only when both plans are blocked. A line at the top says which
account takes the next call and when its window resets.

Each row shows the plan, small meters for the 5 hour window, the week, the
week for Opus and Fable, with their reset times, and the models it reaches.
A signed in plan also has a **Short name** field with **Save**. The hub writes
the name to CLIProxyAPI as the plan's prefix, so its models also read
`neu/claude-opus-5-5`, which only that plan serves; Refusal fallback and the
Window starter use it to pick the plan. A name is 1 to 24 lowercase letters,
digits and dashes, and each plan's is its own; the field suggests one from
the email (the part before @) or the plan's name, and empty removes it. When
two or more plans of one vendor have none, a line at the top asks for them.
**Use when a model refuses** (off by default) sends a refused reply to this
plan or key first, with the same model and the same messages, before the
Refusal fallback list (below). Turn it on for a plan that refuses less, such
as one verified for a cyber program. A plan without a short name gets the
suggested one when you turn it on, so a refusal can reach it alone; that
needs CLIProxyAPI's management key, like short names.
**Pause** takes an account out of the order (CLIProxyAPI stops using it too),
**Try now** clears a cooldown so the next call tries it, and the arrows move
it. The hub writes the order to CLIProxyAPI as priorities. With your own
CLIProxyAPI it changes nothing there until you set an order here, and you
need `routing.strategy: fill-first` and `routing.session-affinity: true` in
its config.yaml for the order to hold (the hub's own CLIProxyAPI has them).

An API key can have a budget: dollars per month, week or day, the day and
hour it resets (for example the 22nd at 00:00), a time zone, when to tell
you (80% by default), and whether calls stop when it is spent. Spend comes
from Conclave's own cost records for that key. The Usage page shows limits
and spend by account.

**A second Claude account.** Two ways, and a refusal fallback step can be
kept on either:

- **Another plan.** Sign in again under **Settings > Models >
  Subscriptions** (Claude) with the other login. To keep a step on exactly
  that plan, give it a short name in **Settings > Models > Accounts** (for
  example `neu`). Its models then also show as `neu/claude-opus-5-5`.
  Without a short name CLIProxyAPI picks which plan answers a model both have.
- **Another API key.** Add a second Anthropic provider and its key:
  `conclave config set providers.anthropic-neu '{"type":"anthropic","name":"Anthropic neu"}'`
  then `conclave secret anthropic-neu`. It shows in Accounts as its own API
  key (id `api-anthropic-neu`); **Rename** it to "neu".

### Refusal fallback ("safety priority")

When a model refuses, Conclave can ask again elsewhere with the same
messages. The simple way: in **Settings > Models > Accounts**, turn on **Use
when a model refuses** for the plans or keys you trust with such requests.
A refused reply then goes to the same model on each of them (of that
model's maker), in your account order, skipping the one that refused and
any that is paused or at a limit. The line at the top of **Settings > Models
> Refusal fallback** names them ("Tried first: personal-claude on Claude.").

After those, Conclave can ask the next model on your list.
**Settings > Models > Refusal fallback** holds the list: add
a model, pick an account for it if that step should stay on one plan or key
("Your order" follows Accounts), and drag rows or use the arrows. For
example: Opus 5.5 on neu, Opus 5.5 on personal, GLM-5.3, then a ChatGPT
model on personal.

- **Try the next model on its own** (off by default): after a refusal the
  turn runs again on the marked plans, then the next step of the list, until
  one answers or none is left. Off, a refused reply shows **Try the next
  model** instead, which goes the same way.
- **Stay on the model that answered** (off by default): otherwise the next
  message goes to the chat's own model again.

Only a refusal the provider reports counts (Claude's refusal stop, OpenAI's
refusal or content filter, Gemini's safety stops, Z.ai's sensitive stop),
never the wording of a reply. Your message is never changed and nothing is
added to it. Each step shows as one line in the chat, such as "Opus 5.5
(neu) declined. Answered by Opus 5.5 (personal).", and the Usage page names
the account that answered. An agent can have its own list
(`refusalFallback:` in its frontmatter, docs/EXTENSIONS.md). In config.json:

```json
"models": {
  "refusalFallback": {
    "enabled": true,
    "entries": [
      { "model": "cliproxy/claude-opus-5-5", "account": "claude-me@neu.edu" },
      { "model": "cliproxy/claude-opus-5-5", "account": "claude-me@example.com" },
      { "model": "zai/glm-5.3" },
      { "model": "cliproxy/gpt-6-astra", "account": "codex-me@example.com" }
    ]
  }
}
```

A marked account is `"refusal": true` on it in `models.accounts`.

### Window starter

A plan's 5-hour window starts with your first request after it resets. If
you are not using the account right then, the next window starts later and
resets later. The window starter sends one tiny request right after each
reset, so the next window starts at once. The idea comes from
[Lamplighter](https://github.com/PosvdM/cpa-plugin-lamplighter), a plugin
for CLIProxyAPI.

Turn it on per account under **Settings > Models > Accounts**: each signed in
plan has a **Window starter** switch, off by default. Some providers limit
automated use of subscription accounts. This sends one tiny request per
window. Use at your own risk.

- **When.** 3 seconds after the 5-hour reset, between 07:00 and 22:30 in your
  time zone (Settings > Assistant). A reset outside those hours waits for
  07:00. **Change** sets other hours, another time zone, or a model.
- **What.** It asks for "OK", with no tools and at most 4 tokens, on the
  plan's cheapest model: the newest Haiku for Claude, the smallest GPT for
  ChatGPT. It counts only once the window shows a new reset time. The Usage
  page lists these requests as **Window starter**.
- **Which account.** The request must reach that account alone. With one
  account per vendor that is automatic. With two or more, give each one a
  short name in **Settings > Models > Accounts** (for example `neu`);
  without one the row says it cannot reach the account alone.
- **When it stops.** A 429, a failed sign-in, a model the plan refuses, or a
  window that does not start stop it for that account until the next day,
  and you get one notification. Network or server errors try again after 5
  and 15 minutes, and the third stops it for the day. It waits while the
  weekly limit is used up, and never runs on a plan without a 5-hour window.
- **Which plans.** Claude and ChatGPT, whose usage the hub reads. For other
  plans the row says it waits for a usage read.

The row says what it is doing: "Next start 14:03", "Started 09:00",
"Stopped until tomorrow: 429". The Android app shows the same line on the
plan's limit card in Usage.

In `config.json` it sits on the account:

```json
"models": {
  "accounts": [
    { "id": "claude-me", "vendor": "anthropic", "kind": "subscription", "credential": "claude-me.json",
      "starter": { "enabled": true, "start": "07:00", "end": "22:30" } }
  ]
}
```

### Already running CLIProxyAPI

Pick **I already run CLIProxyAPI** (in setup, or the mode in Settings) and
give its address, a client key from its `access.api-keys`, and optionally its
management key. Nothing is installed and your other tools keep using it.
Models work with the client key alone. Signing in and the accounts list need
the management key, and CLIProxyAPI only allows that from another computer
when its config has `management.allow-remote: true`. If you had pointed
`providers.cliproxy` at it by hand, the form starts from that address and
your `cliproxy/<model>` ids keep working. Older CLIProxyAPI versions that
only have `/v0/management` work too.

In `config.json` it looks like this; keys pasted in the web app go to
`secrets.json`, and the config holds a reference:

```json
"models": {
  "cliproxy": {
    "mode": "external",
    "url": "http://192.168.1.10:8317",
    "key": "${secret:cliproxy.external.key}",
    "managementKey": "${secret:cliproxy.external.managementKey}"
  }
}
```

`mode` is `off` (the default), `builtin` or `external`. For builtin,
`binary` runs your own copy instead of the download and `port` fixes the
port.

### Updates

A Conclave update can pin a newer CLIProxyAPI. Settings then offers
**Update**: the hub downloads and checks the new version, starts it, and goes
back to the old one when the new one does not start. The hub never installs
a version it has no pin for.

### What stays private

- The management API listens on `127.0.0.1` only and refuses remote use. The
  hub's own `/api`, `/gw` and `/v1` routes keep their usual checks and never
  pass anything to it.
- The management key and the client key are random, kept in `secrets.json`,
  and never sent to the web app. The config file holds only the management
  key's bcrypt hash.
- CLIProxyAPI starts with almost none of the hub's environment: no hub token,
  no provider keys, no `MANAGEMENT_PASSWORD`.
- Sessions cannot read or change `~/.conclave/cliproxy`: file tools, searches
  and shell commands that name it are refused. (A script that tries hard can
  still get there, since it runs as the same user, so treat the hub's user
  account as yours alone.)
- Sign in, remove, refresh, mode changes and updates go in the audit log.

## 5. PC and Mac: install the desktop app

The desktop app is the window, tray, quick ask and notifications, and it
carries the daemon. Download the file for your system from the latest GitHub
release:

- **Mac with Apple silicon**: `Conclave_<version>_aarch64.dmg`. **Intel Mac**:
  `Conclave_<version>_x64.dmg`. Drag Conclave to Applications. The app is not
  notarized, so clear the download flag once:
  `xattr -dr com.apple.quarantine /Applications/Conclave.app`
- **Windows**: `Conclave_<version>_x64-setup.exe`. If SmartScreen warns,
  choose **More info**, then **Run anyway**.
- **Linux**: `Conclave_<version>_amd64.AppImage` (or the `.deb` or `.rpm`).
  The AppImage needs FUSE 2 (`sudo pacman -S fuse2` on Arch). Then
  `chmod +x Conclave_*.AppImage` and run it. On first start it adds itself
  to your app menu (`~/.local/share/applications/conclave.desktop`, kept
  pointing at the AppImage when you move it).

On first launch, choose **Connect to a hub**, or **Run the hub on this
computer** when this computer is the hub (section 1d). To connect, enter the
hub's address and pick how to sign in:

- **Pairing code**: a code from the **Devices** page, from **Pair** on
  Devices in the Android app (section 6), or from
  `docker compose exec hub conclave pair-phone`.
- **Password**: the hub's password, or, on a hub with several people, your
  sign-in name or email and your own password (section 13). The owner sets a
  member's password in **Settings > People**, or the member picks one with
  an invite link. A password goes only to an https address or one on your
  own network. Before anything is kept, the app shows the hub's
  fingerprint: check it against **Settings > Remote access** on the hub, or
  ask its owner, then press **Continue**. **Not my hub** signs that login
  out again. Only the token is kept, never the password.
- **Token**: the hub's owner token, printed by `conclave serve`.

Under them, **Let the hub use this computer** is already on, with one line
on what it allows: the hub can read and change your files here and run
commands and coding tools as you. Turn it off right there if this computer
should only show the app. Press **Connect** (**Log in** for a password).
That one press:

1. pairs the app with the hub (or logs in, then waits for **Continue**),
2. pairs this computer as a device, with the app's own pairing (no second
   code),
3. installs a service that starts the daemon at login and starts it now,
4. waits until the hub sees the computer, then opens your hub.

The computer then shows as online on the Devices page. The service is the
usual one for each system, for your user only, and needs no admin rights:

- **Linux**: a systemd user unit, `~/.config/systemd/user/conclave-daemon.service`.
  It runs while you are logged in. To keep it running after you log out:
  `loginctl enable-linger $USER`. Logs: `journalctl --user -u conclave-daemon -f`.
- **macOS**: a LaunchAgent, `~/Library/LaunchAgents/dev.conclave.daemon.plist`.
  Logs: `~/.conclave/logs/daemon.log`.
- **Windows**: it starts when you sign in (a Run entry for your user) and
  opens no window. Logs: `%USERPROFILE%\.conclave\logs\daemon.log`.

The daemon gets the PATH of your login shell, so git, claude, codex and your
other tools are found as in a terminal. If you add a tool to your PATH later,
turn the switch off and on again.

**Changing it later.** Open **Settings...** in the tray menu, or **Settings >
This computer** in the app, which opens the same switch. Turning it off stops
the daemon, removes the service, and removes this computer from the hub's
Devices page, and the app says whether the hub confirmed it. Turning it on
again pairs it again, with no code.

**Updates.** The app looks for a new version when it starts and once a day.
When there is one, the tray menu and the app's Settings say **Update to X and
restart** (section 14). Installing the new version over the old one by hand
works too. On its next start the app replaces its copy of the daemon and
restarts the service, so the daemon is never left on an old version.

Revoking the desktop app on the hub (`DELETE /api/clients/<id>` with the hub
token) also removes the computer it shared.

### The terminal command

The desktop app puts the terminal app on your PATH, so `conclave` works in a
terminal right after you install the app. It does this on its first start
and after each update. The command is the `conclave` CLI of the app's own
version: the same download as **Run the hub on this computer** (section 1d,
about 40 MB), fetched once in the background.

- **macOS and Linux**: `~/.local/bin/conclave`. It is a link the app points
  at each new version, so an update needs no new link. When a new terminal
  window would not have `~/.local/bin` on its PATH, the app adds one line
  that ends in `# added by Conclave` to the file that window reads: zsh
  `~/.zprofile` on a Mac and `~/.zshrc` on Linux, bash `~/.bash_profile` (or
  the `~/.bash_login` or `~/.profile` you have) on a Mac and `~/.bashrc` on
  Linux, fish `~/.config/fish/conf.d/conclave.fish`. Nothing goes in
  `/usr/local/bin`.
- **Windows**: `%LOCALAPPDATA%\Conclave\bin\conclave.exe`, with that folder
  on your user PATH.

Then open a new terminal window and type `conclave`.

**Signed in.** It talks to the hub the app uses, with no `conclave login`.
The app pairs it as an app of its own (the hub lists it by this computer's
name with "(terminal)", and **Sign out** there revokes it) and saves
`~/.conclave/client.json` the way `conclave login` does. A login you made
yourself stays as it is, and so does a terminal that runs its own hub
(`~/.conclave/config.json`). After `conclave logout`, the app does not sign
it in again until you press **Reinstall**. When the app moves to another hub
(**Change hub...**), its login moves with it.

**Left alone.** When the install script's `~/.local/bin/conclave` is there
(below), or any other `conclave` is on your PATH, the app leaves it in place
and Settings says so. Update the script's copy with the script.

**Settings > Terminal command** in the app says where `conclave` is, with
**Remove** and **Reinstall**. Remove deletes only what the app made, by its
mark: the link, the line ending in `# added by Conclave`, and the login it
saved, which is also signed out on the hub. On Windows it deletes the copy,
the note next to it (`added-by-conclave.txt`) and the PATH entry. Updates do
not bring it back; **Install** does. Before you delete the app, press
Remove: on macOS and Linux nothing else takes those files away.

### Without the desktop app

For a computer without a desktop (a server, a headless box): in a terminal
where your usual tools (git, claude, codex and so on) are on the PATH:

```sh
curl -fsSL https://github.com/default-cybe/conclave/releases/latest/download/install.sh | sh
```

It installs to `~/.local/share/conclave` and links `~/.local/bin/conclave`.
Run it again to update, or let the hub update the daemon from the Devices page
(section 14). With the desktop app you have the terminal app already (The
terminal command, above). If you install both, the script's
`~/.local/bin/conclave` is the one you get, and the app leaves it alone.

On the **Devices** page of the web app, create a device pairing code (or in
the Android app: Devices, **Pair**, **Command line**), then:

```sh
conclave daemon pair https://hub.example.com ABCD-EFGH
conclave daemon install --start
```

`conclave daemon install --start` writes the same service as the desktop app,
with your current PATH, and starts it. Without `--start` it prints the command
that starts it. `--dry-run` shows the unit and the commands and changes
nothing. `conclave daemon status` says whether it is paired, installed and
running. `conclave daemon uninstall` stops and removes the service, and
`conclave daemon unpair` removes the computer from the hub.

The desktop app and the script use the same files (`~/.conclave/device.json`)
and the same service, so a computer has one daemon either way. Turning on the
switch in the app takes over a daemon set up with the script.

### The daemon alone

The daemon in the desktop app is `conclave-daemon`, a small native program
(about 5 MB, and about 7 MB of memory while it waits). Each release also has it
on its own, one file per system: `conclave-daemon-x86_64-unknown-linux-gnu`,
`conclave-daemon-aarch64-unknown-linux-gnu`, `conclave-daemon-aarch64-apple-darwin`,
`conclave-daemon-x86_64-apple-darwin` and `conclave-daemon-x86_64-pc-windows-msvc.exe`,
each with a `.sha256`. Use it on a computer that should only lend its files
and tools to the hub, with no app and no terminal client:

```sh
install -m 755 conclave-daemon-x86_64-unknown-linux-gnu ~/.local/bin/conclave-daemon
conclave-daemon pair --hub https://hub.example.com --code ABCD-EFGH
conclave-daemon install
```

`install` writes the same service as above with your login shell's PATH and
starts it (`--dry-run` shows it and changes nothing). `conclave-daemon status`
says whether it is paired, installed and running, and `conclave-daemon
uninstall` stops it, removes the service and removes the computer from the
hub. Put the file where it stays: the service runs it from that path. On a
Mac, a file downloaded with a browser needs its download flag cleared once:
`xattr -d com.apple.quarantine ~/.local/bin/conclave-daemon`.

It uses the same files and service as `conclave daemon`, so you can switch
between the two without pairing again. `conclave daemon` (the TypeScript
daemon from the install script) keeps working; the two do the same work.

The same install gives you the terminal app. Log in once with a pairing code
(or `--password` for the hub password), then run `conclave`:

```sh
conclave login https://hub.example.com --code ABCD-EFGH
```

## 6. Phone

### Android

1. Open the latest release on the project's GitHub **Releases** page and
   download the `.apk` file. (Builds between releases are on the **Actions**
   tab: open the latest Android run and download its artifact.)
2. Open the file and allow installing apps from your browser when asked.
3. Open Conclave and scan the QR code from `conclave pair-phone` (or the Devices
   page), or type the hub address and a pairing code.
4. Allow notifications when the app asks. **Notify this device** in the app's
   Settings is on by default. The app keeps its own connection to the hub, so
   there is nothing else to install.

From then on the app updates itself from the releases: Settings, About says
**Update available**, and Android asks you to tap Install (section 14).

**Pair another device from the phone.** Settings > Devices > **Pair** makes a
pairing code, as **Pair a device** on the web's Devices page does. Pick
**App** for the Conclave app on another phone or on a computer (the desktop
app), or a browser, or **Command line** for a computer without the desktop
app. The sheet shows the code in large type with **Copy**, its QR code, the
hub's fingerprint and the time left. A code works for 10 minutes; then
**Make a new code**. For a command line it also shows the three lines to run
on the computer (install, `conclave daemon pair` with the code, and
`conclave daemon install --start`). Once the new app or computer shows up,
it says **Paired** and its name. The owner and members both have it, and the
code is yours: a member who makes one pairs that app or computer to their
own account (docs/design/ACCOUNTS.md).

### iPhone

The iPhone uses the web app, installed to the home screen:

1. In Safari, open the hub's address. Use the stable option or your own URL
   here: a home screen app keeps the address it was added with, and a quick
   tunnel address changes when the hub restarts.
2. Tap **Share**, then **Add to Home Screen**.
3. Open Conclave from the home screen, not from Safari (home screen apps keep
   their own login), and enter a pairing code.
4. Open Settings > Notifications and turn on **Notify this device**. iOS
   only sends web notifications to home screen apps.

A native iPhone build is possible too; see `packages/mobile/README.md`.

## 7. Desktop app: day to day

Install it and sign in as in section 5. After that the app opens straight
into your hub.

- Closing the window keeps Conclave in the tray. The tray menu starts with a
  line on the hub ("Hub: hub.example.com", or "Hub on this computer: running
  on port 7717"), then New chat, Show/Hide, Quick ask, Settings, Pair a phone,
  Change hub, Start at login and Quit.
- **Settings** is the app's own page: the hub it uses, **Run the hub on this
  computer** with what it is doing (section 1d), **Let the hub use
  this computer** with what it is doing now ("On. The hub sees this computer
  as arch-desktop."), Start at login, **Pair a phone**, which shows a
  pairing QR code from the hub, and **Terminal command**, which says where
  `conclave` is, with Remove and Reinstall (section 5). In the hub's pages, **Settings >
  This computer** shows the same state and opens it. The switches live in the
  app, not in the hub's pages, so nothing the hub shows can turn them on by
  itself.
- With Start at login on, the app starts in the tray when you log in, and a
  hub on this computer starts with it. The daemon does not need the app to
  run: its service starts at login on its own.
- **Quick ask**: `Ctrl+Shift+Space` (`Cmd+Shift+Space` on a Mac) opens a
  small window that stays on top. On Wayland desktops apps cannot grab global
  keys, so bind a shortcut in your desktop's settings that runs the app with
  `--quick` (for example `~/Applications/Conclave.AppImage --quick`).
- Pairing QR codes are `conclave://` links. Opening one on the computer pairs
  the desktop app directly, trying the hub's other addresses when the first
  does not answer.
- When the hub gets a new address (a quick tunnel that restarted), the app
  follows it while it runs. On start it tries the hub's other addresses, such
  as the same network, when the saved one does not answer.
- Notifications show as system notifications while the app runs, also from
  the tray. Settings > Notifications turns them off for this computer.

## 8. Notifications

Conclave sends its own notifications. There is no outside service to sign up
for. Each device turns them on for itself under Settings > Notifications >
**Notify this device**, which also has **Send a test**:

- **Browsers and the installed web app** use Web Push. The hub makes its own
  keys. Approvals have Allow and Deny right on the notification. Browsers only
  allow this on an https address (or on the hub's own computer), so open
  Conclave at its remote access address, not at a plain http one on your
  network.
- **The desktop app** shows them while it runs, also from the tray.
- **The Android app** keeps its own connection to the hub and has the switch
  in its own Settings.

The same page picks what is worth a notification. While you are using
Conclave on any device, the hub holds everything but approvals, questions and
failures (**Hold notifications**), so your phone stays quiet while you are at
the desk. When you switch away, the hold ends at once.

What can notify you, each with its switch (`notifications.on` in config.json):
approvals and questions (`approvalNeeded`), failures (`errors`), limit resets
(`limitReset`), routine runs (`routineDone`), finished sessions
(`sessionDone`), friends' messages (`friendMessage`), stuck sessions (`stuck`)
and file conflicts (`fileConflict`).

### Alerts: stuck sessions and file conflicts

Both wait in the Inbox, under Alerts, until you answer them or they clear
themselves.

- **Stuck sessions.** A running session made no progress for 5 minutes, or
  one tool failed the same way 3 times in a row. **Stop** ends the turn.
  **Keep waiting** doubles the wait for that turn, from then on. A command that still runs
  inside its own timeout is not stuck. The alert goes away when the session
  makes progress or its turn ends. Change the wait, also per model or
  provider, in config.json; 0 turns it off:
  `"limits": { "stuck": { "minutes": 5, "models": { "ollama/*": 15 } } }`.
- **File conflicts.** Two chats wrote the same file within 10 minutes. The
  Inbox links both, and the second chat's model hears it on its write. A
  subagent and its parent, and agents in separate git worktrees, never
  conflict. To have the second write ask you first instead, set
  `"permissions": { "onFileConflict": "ask" }`.

## 9. GitHub: repo sessions

A repo session works on a GitHub repository the way Claude Code on the web
does, on your own hub: pick a repository, the hub gives the session its own
git worktree on a new branch, and when the work is done it pushes the branch
and opens a pull request. After the merge, Clean up removes the worktree.

### Make a token

The hub needs a fine-grained personal access token. On github.com: your
picture, **Settings**, **Developer settings**, **Personal access tokens**,
**Fine-grained tokens**, **Generate new token**
(https://github.com/settings/personal-access-tokens/new).

- **Resource owner**: you, or the organization that owns the repositories.
- **Repository access**: only the repositories the hub may work on, or all.
- **Repository permissions**:
  - **Contents**: Read and write (clone, fetch and push)
  - **Pull requests**: Read and write (open them and read their state)
  - **Metadata**: Read (set for you)
  - Optional: **Commit statuses**: Read, for the checks line on private
    repositories.
- **Expiration**: what you are comfortable with. When it runs out, connect
  a new one.

### Give it to the hub

In the web app: **Settings**, **GitHub**, paste it, **Connect**. Or on the
server:

```sh
docker compose exec hub conclave github login
```

It asks for the token without echoing it (or reads it from stdin:
`echo "$TOKEN" | conclave github login`), checks it with GitHub, and keeps it
in `secrets.json` as the secret `github`. A token GitHub refuses is not
saved. `conclave github status` shows who it is, `conclave github repos
[words]` what it can see, and `conclave github logout` removes it.
`CONCLAVE_GITHUB_TOKEN` in the hub's environment works too, when no secret is
set.

Only the hub uses the token, for its own API calls and for the git commands
that clone, fetch and push. Sessions never see it: it is not in their shells,
in any file of the clone or the worktree, in the transcript or in the log,
and tools cannot read `secrets.json`. On a paired computer the hub runs those
git commands there and hands the token to each one on its standard input,
for that command only.

### Start a repo session

- Web: **Code** in the top bar, then **+** and **A GitHub repository**:
  search for the repository, pick the branch to start from (the default
  branch unless you choose) and the device (the hub unless you choose), and
  write the task. On a phone, **Code**, then **GitHub** in "Where should it
  work?".
- CLI: `conclave sessions new --repo owner/name [--base main] [--device ID]
  "the task"`.

Each device keeps one clone per repository in `~/repos/<owner>/<repo>`, or
uses a clone you already have when the hub knows that folder. Worktrees go
in `~/.conclave/worktrees/gh/`, branches are named `conclave/<task>-<4
letters>`.

### Push, pull request, clean up

The session shows the repository, the branch and where it stands ("Pull
request #3 is open. Checks passed."), with **Push**, **Open pull request**
(the title and description are drafted from the session; change them
before you open it) and **Clean up** once it is merged or closed. The CLI
has `conclave sessions push|pr|cleanup <id>`. The agent can ask for a push
or a pull request too, and you approve each one. The hub never force pushes
and never pushes to the default branch. Clean up keeps the branch on GitHub.
Archiving a repo session offers Clean up as well.

### Config

```json
"github": {
  "apiUrl": "https://api.github.com",
  "gitUrl": "https://github.com",
  "reposRoot": "~/repos",
  "pollSeconds": 120
}
```

All optional. `apiUrl` and `gitUrl` point at GitHub Enterprise
(`https://HOST/api/v3` and `https://HOST`). `pollSeconds` is how often the
hub reads open pull requests; 0 reads them only when you ask (Check now).

## 10. Maps: places and directions

The assistant can find places, say how long a trip takes and when to leave,
and show a map in the chat. It works with no setup beyond a contact email
through OpenStreetMap, which needs no key and no billing. Google Maps adds
ratings, opening hours, public transport and traffic. Settings > Maps picks
the provider; with no Google key it is OpenStreetMap.

### OpenStreetMap

1. Settings > Maps: enter a contact email. The public OpenStreetMap servers
   ask every app for one, so they can reach you before they block it.
2. Set **Home** (an address, or `lat,lng`) and the **Travel mode**.
3. Press **Test**.

The public servers are run by volunteers for light use. The hub makes at
most one search a second and keeps map tiles for a week. The public routing
server (the OSRM demo) routes cars only, so walking and cycling times come
from the road distance, and there are no public transport times. For more,
run your own Nominatim, OSRM and tile server and put their URLs under
**Servers**.

### Google Maps

1. In the Google Cloud console, pick or create a project.
2. Turn on billing for it, and add a budget alert under Billing, Budgets and
   alerts (for example 5 dollars a month).
3. Enable five APIs: Places API (New), Routes API, Geocoding API, Maps
   Static API and Time Zone API.
4. Under APIs and services, Credentials, create an API key and restrict it
   to those five APIs. Leave its application restriction at None, or set
   the hub's IP address: the hub calls Google from its own address, never
   from a browser or phone.
5. Paste the key in Settings > Maps, or on the hub run
   `conclave secret google-maps --value AIza...` (it tests each API after
   saving). Press **Test**.

With gcloud, in the project (billing and the budget alert stay in the
console):

```sh
gcloud services enable places.googleapis.com routes.googleapis.com \
  geocoding-backend.googleapis.com static-maps-backend.googleapis.com \
  timezone-backend.googleapis.com
gcloud services api-keys create --display-name="Conclave hub" \
  --api-target=service=places.googleapis.com \
  --api-target=service=routes.googleapis.com \
  --api-target=service=geocoding-backend.googleapis.com \
  --api-target=service=static-maps-backend.googleapis.com \
  --api-target=service=timezone-backend.googleapis.com
gcloud services api-keys list
gcloud services api-keys get-key-string KEY_ID
```

The key stays on the hub, in its secrets file. Apps get only results and map
pictures, which the hub fetches itself; tools and shells never see the key.
In Docker you can set `GOOGLE_MAPS_API_KEY` in the hub's environment instead.

What the Test button can say, and what to do:

- **Billing is not enabled**: turn on billing for the key's project.
- **The key is restricted and does not allow the ... API**: add that API to
  the key's API restrictions.
- **The ... API is not enabled**: enable it under APIs and services.
- **The key only works from some websites, apps or addresses**: set the
  key's application restriction to None, or to the hub's IP address.
- **Google does not accept the key**: copy it again and paste it.
- **Quota used up**: wait, or raise the quota in the Cloud console.

**Cost.** Every call to Google counts toward a daily cap on the hub
(**Daily cap**, default 300 calls; answers from the hub's short cache do not
count; 0 turns maps off). Google gives a free monthly amount per API, and
place searches that ask for ratings and opening hours bill at a higher tier
with a smaller free amount. Check Google's pricing page for the current
numbers, and keep the budget alert.

**Leave by.** When a calendar is connected and Home is set, the day plan,
the morning brief and Home's Today show when to leave for each event with a
place, in the default travel mode.

## 11. Calendar and mail

The assistant reads your calendars and mail and proposes events and
messages. Nothing is written until you approve its card on Home or the
phone. Add accounts in **Settings, Calendar and mail**. Passwords and
tokens go to the hub's secret store (`secrets.json`, readable by the hub's
user only) and never come back to the page. How it works is in
`docs/DESIGN.md`, section 32.

If you sync one set of calendars to several services (Nextcloud, iCloud,
Google), add only one of them, or turn Read off for the copies, so events
do not show twice.

### Calendars over CalDAV: app passwords

An app password is a separate password for one app. It works only for
calendars and mail (not for signing in to the website), and you can revoke
it without changing your real password.

- **Nextcloud.** Your personal settings (not Administration), **Security**
  (`https://<your-nextcloud>/index.php/settings/user/security`). At the
  bottom, under **Devices & sessions**, name it "Conclave" and press
  **Create new app password**. Server address:
  `https://<your-nextcloud>/remote.php/dav`. User name: your Nextcloud
  user name (shown with the app password).
- **iCloud.** Two-factor authentication must be on. At
  account.apple.com, Sign-In and Security, **App-Specific Passwords**,
  add one named "Conclave". Server address: `https://caldav.icloud.com`.
  User name: your Apple Account email. The same password works for iCloud
  Mail over IMAP (`imap.mail.me.com`).
- **Fastmail.** Settings, Privacy and security, **Manage app passwords**,
  access "Calendars (CalDAV)" (and "Mail (IMAP/POP/SMTP)" for mail). Server
  address: `https://caldav.fastmail.com/dav/`, user name: your full address.
- **Google.** Google Calendar does not accept app passwords over CalDAV any
  more (Google ended password access to its CalDAV API). Use **Sign in with
  Google** below and tick Calendar, or the Google Workspace connector in
  Discover.

Connect tests the account before it is stored: it finds the calendars, and
a wrong password or address is refused with the server's answer. Then pick,
per calendar, **Read** (the assistant may read it) and **Write** (it may
propose events there). Writing needs reading, and a read-only or
subscribed calendar cannot be written.

### Gmail and Google Calendar: Sign in with Google

Tick what the assistant may do, then **Sign in with Google**. Each choice
asks Google for one scope:

| Choice | Scope | What it allows |
| --- | --- | --- |
| Read mail | `gmail.readonly` | Search and read mail. Nothing is changed or marked read. |
| Save drafts | `gmail.compose` | Create drafts, and send when you also turn Sending on. Asked only when you turn drafts on. |
| Calendar | `calendar.readonly` | Read your calendars and their events. |
| Propose events | `calendar.events` | Create, change and delete events, each only after you approve its card. |
| (always) | `openid`, `email` | Your address, to name the account. |

Conclave's shared Google app is not verified by Google yet, so Google shows
a warning screen ("Google hasn't verified this app"). Choose **Advanced**,
then **Go to Conclave**. Where the sign-in can finish:

- from any browser, the desktop app or a phone, once Conclave ships its
  shared Web client (Settings then says so under Sign in with Google):
  after you allow, Google opens a Conclave page at
  `conclave.kaivalyaahir.com` that says "Finish signing in to Conclave at"
  your hub's address. Check it is your hub and press **Continue**. Nothing
  to set up, and no https address needed. The browser must reach the hub
  at the address you opened Settings at;
- without the shared Web client, from a browser on the hub machine
  (Settings opened at `http://127.0.0.1:<port>`), where it finishes by
  itself;
- without it, from any other browser or the desktop app: after you allow,
  Google opens a page at `127.0.0.1` that does not load. Copy its whole
  address from the address bar, paste it into the box under Sign in with
  Google and press **Finish sign-in**;
- from any browser when the hub has an https address (a Cloudflare tunnel,
  your own URL or a Tailscale `ts.net` name) and you added your own Google
  app of type Web application. Settings shows the steps and the redirect
  URI to copy.

To use your own Google app instead, Settings shows the steps: create a
project, enable the Gmail API (and the Google Calendar API), set up the
consent screen as External and add yourself as a test user, then create an
OAuth client (Desktop app, or Web application with the redirect URI shown)
and paste its id and secret. The secret is stored as a hub secret.

**Disconnect** revokes the hub's access at Google and forgets the token.

### Outlook, Hotmail and Microsoft 365: Sign in with Microsoft

Outlook.com and Hotmail no longer allow IMAP with a password, so this is
the way in for them. Tick **Save drafts** (`Mail.ReadWrite`) or **Send**
(`Mail.Send`) if you want them; reading is `Mail.Read`, and
`offline_access` keeps the hub signed in. **Sign in with Microsoft** shows a
code: open microsoft.com/devicelogin on any device, type the code and sign
in. Settings updates when it is done.

Until Conclave's shared Microsoft app exists, add your own: in
entra.microsoft.com, App registrations, New registration, "Accounts in any
organizational directory and personal Microsoft accounts". Under
Authentication turn on **Allow public client flows**. Under API
permissions add the Microsoft Graph delegated permissions above. Paste the
Application (client) id in Settings. No secret is needed.

**Disconnect** forgets the token. Microsoft has no revoke for one app's
token: to remove its access, go to account.live.com/consent/Manage
(personal) or myapps.microsoft.com (work).

### Any other mail: IMAP with an app password

For other providers, and for Gmail without a Google app: pick the provider
(iCloud, Fastmail, Gmail, Yahoo or Other), give the user name, the address
and an app password. Gmail needs 2-Step Verification for app passwords
(myaccount.google.com, Security, App passwords); some Google Workspace
accounts do not allow them. IMAP is read only: Conclave opens folders
read-only and never marks mail read. Approved messages go to the Drafts
folder. **Allow sending** adds SMTP; each message still needs your approval.

### What the assistant may do

- It reads the calendars marked Read, and the mail of every connected
  account, but mail only through the **email agent**: mail is written by
  strangers, so it is read in an untrusted session that can change nothing
  and only reports back.
- Every new event, change, delete and message is a **proposal**: a card on
  Home (web), Today (`/today` on phones) and the Android Today screen, with
  Approve and Decline. This holds in every permission mode and in routines.
- Saving a draft is the default. Sending happens only when you turned
  Sending on for the account and approved that message.

## 12. Logs

The hub keeps a log of what it does, so that after a few weeks you can hand
it to a developer to see whether everything works as it should.

### Where they are

One file a day in the hub's data folder, `<home>/logs/hub-YYYY-MM-DD.jsonl`
(the day in UTC): `~/.conclave/logs` for `conclave serve`, `/data/logs` in
Docker, `/var/lib/conclave/logs` in a container or VM. Each line is one JSON
object with the time, the level (debug, info, warn, error), the part of the
hub it is about (session, tool, device, peer, http...), a short message and
its details. The same lines go to stdout too (`docker compose logs hub`,
`journalctl -u conclave-hub`), except tool calls and app lines. Docker keeps
the last 30 MB of stdout (`logging` in `docker-compose.yml`), and
`conclave serve --detach` starts `logs/hub.log` over past 10 MB; the daily
files are the record.

Files older than 28 days are deleted, and all of them together stay under
500 MB: when they pass it, the oldest days go first. Change both in
`config.json`:

```json
"logs": { "keepDays": 28, "maxMB": 500 }
```

### What is in them

- The hub starting and stopping, with its version, and a crash with its stack.
- Every turn: the session id, agent, model, provider, how long it took,
  tokens, cost, how it ended and the error if it failed.
- Every tool call: its name, how long it took and whether it worked.
- Approvals asked and answered, routine and workflow runs, imports.
- Devices connecting and disconnecting, friends' messages in and out, apps
  connecting.
- Errors from GitHub, memory connections and model providers, and every
  answer with a 5xx status.
- What the apps report about themselves: the web, desktop, iPhone and Android
  apps send their connects and reconnects, failed requests, screens that
  broke, and push and notification failures. An app sends at most 1,000
  lines an hour. The apps of another person on your hub (section 13) send
  100 an hour all together, and their lines never push your older days out:
  past the size cap they are dropped, and they take a tenth of it at most.

### What is never in them

Message text, file contents, tool input or output, tokens, keys and
passwords. Every line goes through the same secrets filter as memory before
it is written, and again when it is exported.

### Download them

In the app: **Settings, Logs, Download logs**, for the last 1, 7 or 28 days.
On the hub, or anywhere you are logged in:

```sh
conclave logs export --days 7 -o conclave-logs.zip
```

The zip holds the log files, `summary.md` (version, uptime, devices,
providers set up, counts of turns, errors per part of the hub and the 20
most frequent errors), the settings with every key and password removed, and
the recent log of each online device. Look at `summary.md` before you send
it if you like; nothing in it is a secret.

Also:

```sh
conclave logs                 # where the files are, their size, today's errors
conclave logs tail -f         # follow them (--level warn, --component session)
conclave logs errors --days 7 # errors grouped by message
conclave logs debug 24        # more detail for 24 hours (off: conclave logs debug off)
```

`tail`, `errors` and `export` read the files directly when the hub on this
machine is not running, so a hub that stopped can still be looked at.
Settings, Logs has the same debug switch; it turns itself off after 24 hours.

## 13. People: a friend or family on your hub

One hub can have several people. Each has their own chats, memory, routines,
tasks, devices, keys, calendars and mail; nobody sees anyone else's in the
apps. You stay the owner: the hub's settings, its own computer, remote
access, extensions, MCP servers, hooks, friends, shared projects, maps,
watches, the browser sign-in, the logs and backups are yours alone.

Calendar and mail work for everyone: each person adds their own accounts in
**Settings > Calendar and mail**, and signs in to Google with the hub's Google
app once you have set it up (section 11). Their app passwords stay in their
own file on the hub. Maps and watches are yours: they spend your maps key and
the hub's daily cap, start from your home, and browse with the hub's browser.

Be honest with them about one thing: you run the computer the hub is on, so
you could read what is stored there. The invite page says so. This is for
people who trust each other, not for hosting strangers.

### Add a person

In the web app: **Settings > People > Add person**. Give a name (what they
type to sign in: letters, digits, dot, dash, no spaces), an email if you like
(it signs them in too, so no two people can have the same one), and how they
sign in:

- **Invite link** (the default): you get a link like
  `https://hub.example.com/invite/...`. Send it to them. It works once and for
  7 days; they open it, pick a password, and they are in. **Invite link** on
  their row makes a new one and ends the old.
- **Password**: you set one (12 characters or more) and tell it to them. They
  can change it in **Settings > Your account**.

From a terminal on the hub, or any terminal logged in as the owner:

```sh
conclave people add sam                      # prints an invite link
conclave people add kim --password           # asks for a password instead
conclave people                              # everyone, with this month's spend
```

### Your keys and their budget

A person uses their own provider keys first: they add them in **Settings >
Providers** on their account, and they stay in their own file on the hub. You
can also let them use the hub's key for a provider, with a monthly budget in
dollars. Tick **Use the hub's ... key** when you add them, or later under
**Access** on their row. Only providers the hub has a key for are offered
(and CLIProxyAPI once subscriptions are set up); the hub refuses access to
the others, so add the key in **Settings > Providers** first:

```sh
conclave people access sam --providers anthropic:10,openai:5   # $10 and $5 a month
conclave people access sam --providers anthropic               # no cap
conclave people access sam --providers none                    # their own keys only
```

The hub checks the budget before every call, titles and memory notes
included, and stops at the limit with a sentence that says when it resets
(the first of the month). Calls still running count too, at an estimate of
their cost, so several started at once cannot go far past it. **Settings > People** shows what each person spent
this month. Agent harnesses (Claude Code, Codex, Gemini CLI, OpenCode) run on
their own computer with their own login, so they need nothing from you.

### Their own plans

A person can sign in their own Claude, ChatGPT or other plan: **Settings >
Models > Subscriptions** on their account, the same page as yours (section 4)
without the program, its version, its path or how the hub reaches it. If their
CLIProxyAPI stopped with an error, they can retry it there. The first sign-in
starts a CLIProxyAPI for them alone, run by the hub like yours, on `127.0.0.1`, in
`~/.conclave/accounts/<id>/cliproxy`. Its keys are in their own `secrets.json`
there. **Settings > Models > Accounts** shows their plans, their order and
their limits. Their `cliproxy/<model>` calls use their own plan when it has
the model, and your plans only if you let them use CLIProxyAPI (above). A call
that started on their plan stays on it and never moves to yours. The window
starter and "Use when a model refuses" are not for their plans. Calls on their
own plan cost you nothing and count against no budget. You see only how many
plans each person has on **Settings > People**. Signing out their last plan,
or removing them, stops their CLIProxyAPI and deletes its folder. If they sign
out their last plan while another sign-in is in progress, their CLIProxyAPI
keeps running. Another person's plan id gets 404 for them. Sessions cannot
read these folders or any person's `secrets.json`.

### How they sign in

- **Web**: the hub's address, then **Password**. With more than one person
  the login asks for **Sign-in name or email**: their sign-in name, or the
  email on their account. Case does not matter. Or they open the invite link.
- **Phone**: **Use address and password**, with their sign-in name or email
  and their password. A pairing code made in their own app pairs another
  device to their account.
- **Terminal**: `conclave login https://hub.example.com --password --account sam`
  (or `--account sam@example.com`).
- **Their computers**: the desktop app, with **Password** on its first page
  and their sign-in name or email and password (section 5), or a device code
  from Devices in their app. Their coding sessions run there. Tools never run
  on the hub's own computer for them, so a code session there is refused when
  it starts ("Code sessions run on a computer you paired. Pair yours in
  Devices."), and Code says so in place of its box until they pair one.
  Chat and Assistant work without a computer of their own.

You sign in as before: the hub token, your pairing codes, and your password
(on a hub with several people, with your sign-in name or your email; the name
is `owner` until you change it in **Settings > Your account**). **More** in the top bar shows who is
signed in and switches between people signed in on the same browser.

### A workspace on the hub's computer (optional)

If someone has no computer of their own to run sessions on, give them a
workspace on the hub's computer: the ordinary daemon under its own OS user, or
in its own container, paired to their account. It cannot read your files. On
their row press **Workspace**, or run `conclave people workspace sam`; it
prints a device code (valid for an hour) with the commands filled in. On a
Linux hub they look like this:

```sh
sudo useradd --create-home --shell /bin/bash conclave-sam
sudo -iu conclave-sam sh -c 'curl -fsSL https://raw.githubusercontent.com/default-cybe/conclave/main/scripts/install.sh | sh'
sudo -iu conclave-sam /home/conclave-sam/.local/bin/conclave daemon pair https://hub.example.com CODE
sudo loginctl enable-linger conclave-sam
sudo -iu conclave-sam env XDG_RUNTIME_DIR=/run/user/$(id -u conclave-sam) /home/conclave-sam/.local/bin/conclave daemon install --start
```

Or with Docker, a container with its own volume:

```sh
docker run -d --name conclave-sam --restart unless-stopped --network host -v conclave-sam:/data \
  ghcr.io/default-cybe/conclave:latest sh -c 'test -f /data/device.json || bun packages/cli/src/index.ts daemon pair https://hub.example.com CODE; exec bun packages/cli/src/index.ts daemon run'
```

It shows up under Devices in their app, not in yours.

### Set a new password, or remove someone

- **Password** on their row (or `conclave people passwd sam`) sets a new one.
  Their apps sign out at once.
- **Remove** (or `conclave people remove sam --yes`) signs them out, unpairs
  their devices and deletes everything that was theirs: chats, memory,
  routines, keys. It cannot be undone.

## 14. Updates

Conclave updates itself from the releases of
[default-cybe/conclave](https://github.com/default-cybe/conclave/releases)
(installs from before 0.4.16 read a copy on default-cybe/conclave-releases
until they update once). Every file an updater
installs is signed with one key; the hub, the daemons, the desktop app and the
Android app each carry its public half and install nothing it did not sign. A
release built without the key says "(unsigned)" in its title and is never
installed as an update; install it by hand if you want it.

**Where to look.** Settings, About in the web app shows the hub's version, the
newest release (the hub looks once a day, and when About opens) and, when one
is out, **Update now**. The owner also gets a quiet line under the header:
"Conclave 0.5.0 is ready to install." with **Update now** and **Later**.
People you added to the hub never see any of it. Each update, its result and
the setting below go in the audit log.

### The hub

**Install script, with the user service** (`conclave-hub.service` from
`scripts/systemd`, section 5). **Update now** downloads the archive for this
system, checks its size, SHA-256 and signature, and starts the updater in a
unit of its own (`systemd-run --user`). The updater checks the file again,
asks the new `conclave` its version, swaps
`~/.local/share/conclave` for the new folder (the old one stays as
`~/.local/share/conclave.prev`), restarts the service and waits up to 90
seconds for the new version to answer. When it does not, the old folder goes
back, the service restarts on it, and About says so.

**Proxmox, Incus, LXD or a VM** (`setup.sh` or `conclave-lxc.sh`, section 1).
The hub runs as `conclave` and cannot change `/opt/conclave` or restart its
own service. `setup.sh` installs `conclave-update.path`, which starts
`conclave-update.service` as root when the hub asks; it does the same checks
and swap with `/opt/conclave/release`, keeping `/opt/conclave/release.prev`.
A container set up before this needs `sh conclave-lxc.sh update <id>` once.
A hub installed from source (`--from git`) updates with `setup.sh` as before.

**Docker.** The hub never changes its own container. About shows the command:

```sh
docker compose pull && docker compose up -d
```

**A source checkout** (`bun packages/cli/src/index.ts serve`): `git pull`,
`bun install`, and start it again.

**A hub that no service runs** (`conclave serve` in a terminal or with
`--detach`), and Windows: run the install script again (or unpack the new zip)
and start it again. About shows the command.

**The desktop app's own hub** updates with the app.

**Install updates automatically.** A switch in Settings, About, off unless the
owner turns it on. With it on, the hub installs a new release between 03:00
and 05:00 on its own clock, when no session is working, and updates the
devices' daemons in the same window. A version that failed is not tried again
the same night.

### Device daemons

The Devices page shows each device's daemon version. A daemon older than the
hub gets **Update**: the hub sends its own version and that release's file
list, and the daemon downloads the file for its own system, checks the
signature with its own key, asks the new binary its version, puts it in place
(the old one stays next to it as `.prev`) and exits; its service starts the new
one. The line says when it is back on the new version, or why it failed.

- `conclave daemon` from the install script updates its whole folder, as the
  hub does. It must run as its service (`conclave daemon install --start`), so
  something starts it again.
- `conclave-daemon` (the daemon alone) replaces its own file. With the
  service, systemd and launchd start it again; on Windows it starts itself.
  `conclave-daemon rollback` puts the previous version back.
- The desktop app's daemon is the app's: install the app's update instead.
- A daemon from before this (protocol 3 or older) is updated by hand once.

### The desktop app

The app looks for a new version when it starts and once a day, and shows
**Update to X and restart** in the tray menu and in its Settings. It downloads
the signed bundle, checks it, installs it and starts again; the hub on this
computer stops cleanly first. On its next start `conclave` in a terminal
moves to the new version too (section 5, The terminal command). On Linux only the AppImage updates itself; a
`.deb` or `.rpm` install updates with the new package.

### Android

The app looks for a new version when it starts and once a day. Settings, About
then says **Update available**, and the side panel shows a small line above
the hub. The app downloads the APK, checks its SHA-256 and signature, and opens
Android's installer. The first time, Android asks you to allow Conclave to
install apps; then tap **Install**. The new APK is signed with the same key as
the one installed, so it updates in place and keeps the pairing. Builds from
the Actions tab (test builds) are not offered releases.

### Web app and iPhone

The hub serves them, so they update with the hub. A page that was open while
the hub updated says **Conclave was updated.** with **Reload**, once.

### If an update went wrong

The hub puts the old version back by itself when the new one does not answer.
Should a power cut stop the swap halfway, the service cannot start: move the
previous folder back by hand and start it.

```sh
# install script
mv ~/.local/share/conclave.prev ~/.local/share/conclave
systemctl --user restart conclave-hub
# a container set up by setup.sh, as root
mv /opt/conclave/release.prev /opt/conclave/release
systemctl restart conclave-hub
```

`<home>/updates/state.json` (`~/.conclave/updates`, `/var/lib/conclave/updates`
in a container) says what the last update did, and the hub's log files have
its lines (section 12).

### The signing key (for whoever makes releases)

Make the key once, on your own computer:

```sh
bunx tauri signer generate -w ~/.tauri/conclave-update.key
```

Put the private key file's contents in the repository secret
`TAURI_SIGNING_PRIVATE_KEY` and its password in
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Replace the last line of
`packages/core/src/update/update-key.pub` with the contents of
`~/.tauri/conclave-update.key.pub` and commit it. Never commit the private key.
Releases built before that commit cannot check signatures, so devices on them
update by hand once more.

## 15. The hub's browser

The assistant and watches browse with a browser on the hub. Nothing to do in
a shell: open Settings, Browser.

1. Under **Engines**, press **Install on the hub** next to CloakBrowser (or
   Chromium). The confirm lists every step as it will run: the downloads
   with the hash each must match, and the commands. It runs as the hub's own
   user, without root, into the hub's browser folder
   (`/var/lib/conclave/browser` in the Proxmox container, `/data/browser` in
   Docker). CloakBrowser is a Chromium with fingerprint patches, for sites
   that turn automated browsers away; the hub pins version 146.0.7680.177.5
   for Linux x64 and checks it before it uses it.
2. If the page then says the browser needs system libraries (a container
   from a minimal template has no X11 libraries, `libnss3`, `libgbm` or
   fonts), adding them takes root:
   - **With the root helper** (section 16), the page shows **Install system
     libraries**. The confirm shows the one line the hub runs,
     `sudo /usr/local/libexec/conclave-root-helper browser-deps`. It installs
     the packages and checks again, and the page says **Ready**.
   - **Without it**, the page offers two things to run as root inside the
     hub's container (not on the Proxmox host): `conclave system-helper
     install` once, after which the button is there for this and later
     installs, or the `apt-get install` line for these libraries alone. It
     also shows how to get there: `pct exec <CTID> -- <command>` from the
     Proxmox host shell, or the CT's Console in the Proxmox web UI. On a VM
     or a machine of its own, it says to run them there as root (with
     `sudo`). On Debian 12 the apt-get line is typically:

     ```sh
     apt-get install -y --no-install-recommends libasound2 libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 libcairo2 libcups2 libdbus-1-3 libdrm2 libgbm1 libglib2.0-0 libnspr4 libnss3 libpango-1.0-0 libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2 fonts-liberation fonts-noto-color-emoji
     ```

     On Debian 13, six of them end in `t64` (`libasound2t64`,
     `libatk-bridge2.0-0t64`, `libatk1.0-0t64`, `libatspi2.0-0t64`,
     `libcups2t64`, `libglib2.0-0t64`); the page gives the right names for
     your hub.

   Docker: build the image with `docker build --build-arg BROWSER=1 .` (or
   `docker compose build --build-arg BROWSER=1`) instead; the image has no
   root helper.
3. Pick the engine of each profile under **Profiles**. New profiles run on
   CloakBrowser once it is installed.

CloakBrowser keeps Chromium's sandbox on, so the hub must run as a normal
user (the Proxmox setup does: user `conclave`, nesting on). Docker's default
seccomp profile stops that sandbox; run the container with Chrome's seccomp
profile or `--security-opt seccomp=unconfined` to use CloakBrowser there.

### A proxy, when you ask for one

Pages load from the hub's own address. To go out from somewhere else, set up
a proxy under **Proxy** and then ask for it in a chat: "open it through the
proxy" or "check the price from Japan". The assistant never uses it on its
own, not even when a site blocks it; a watch or routine uses it only when its
own instructions say so. A proxied page opens in a separate browser with no
saved logins.

- **DataImpulse:** paste the proxy login and password from your DataImpulse
  dashboard, and pick a default country if you like. The hub keeps both as
  secrets and uses `gw.dataimpulse.com:823` (change it only if DataImpulse
  tells you to).
- **Custom:** one `socks5://user@host:port` or `http://user@host:port`, and
  its password.

**Test** goes out once through the proxy, for a country you type or the
default, and shows the address and country a site would see.

## 16. The root helper: system packages without a root shell

The hub runs as a normal user (`conclave` in a Proxmox container), so it
cannot install system packages. The root helper lets it, for a fixed list of
jobs, without ever having root itself. Install it once, as root on the hub's
machine. In a Proxmox container that is **inside the container, not on the
Proxmox host**. From the Proxmox host shell:

```sh
pct exec <CTID> -- conclave system-helper install
```

where `<CTID>` is the container's number. Or open the CT's
Console in the Proxmox web UI, or `pct enter <CTID>`, and run
`conclave system-helper install` there. On a VM or a machine of its own, run
it there with `sudo`. A container set up by `setup.sh` before the helper
existed has an older `conclave` command that switches to the conclave user;
there, run `/opt/conclave/bin/conclave system-helper install` instead (Settings
shows the right one), or run `setup.sh` again, which fixes the command and
asks about the helper.

It writes two files and changes nothing else:

- `/usr/local/libexec/conclave-root-helper`, root's, mode 0755: a short shell
  script that takes one word, an action from a list built into it, and
  nothing else. Today the list has one action, `browser-deps`: `apt-get
  update`, then the libraries and fonts the browser needs on this Debian or
  Ubuntu release. It refuses other systems, logs to the system log
  (`journalctl -t conclave-root-helper`), and does nothing when everything
  is installed already.
- `/etc/sudoers.d/conclave`, mode 0440, checked with `visudo` before it is put
  in place: the hub's user may run that file, with those action names, as
  root, without a password:

  ```
  conclave ALL=(root) NOPASSWD: /usr/local/libexec/conclave-root-helper browser-deps
  ```

It finds the hub's user from its service (`conclave-hub`), else a running
`conclave serve`, else the `conclave` user; `--user NAME` says it outright.
It installs `sudo` first when the machine has none. `--dry-run` prints both
files without writing them.

Then Settings, Browser shows **Install system libraries** instead of
commands, and the agent can run `sudo
/usr/local/libexec/conclave-root-helper browser-deps` itself from its Bash
tool (it still asks you first, as for any command). Nothing else runs as
root: the hub has no other sudo rule and no password.

```sh
conclave system-helper status    # what is installed, and whether the hub may run it
conclave system-helper remove    # as root: takes both files out (sudo and the packages stay)
conclave system-helper run browser-deps   # as root: the same job once, without installing the helper
```

A new Conclave may bring a new action; run `conclave system-helper install`
again to update the helper (`status` says when it is older).



Run `conclave doctor` (or `docker compose exec hub conclave doctor` on the
server, or `pct exec <id> -- conclave doctor` for a Proxmox CT). It checks tools, harnesses, the hub, keys and the web app.
`conclave logs errors` shows what went wrong lately, and `conclave logs export`
makes the zip to send to whoever helps you (section 12).

## A demo hub to try the apps

`bun scripts/demo-hub.ts` (from a clone, after `bun install`) starts a
throwaway hub with demo data, for screenshots or for trying an app without
your own hub or a model key. It runs in a temp folder that it deletes when you
press Ctrl-C, on port 7810 (`--port`), with devices on this network allowed.
A fake model in the same process answers with scripted replies, and the hub
is seeded through its own API: a finished coding session with a diff and a
passing test run, a `git push` waiting on approval, an open question, a chat
and a workflow run in progress, on a device named MacBook. A fake GitHub
(local bare repositories and a small API, also in the process) gives it a
repo session with its pull request open and its checks passed.

It prints the hub URL, the owner token, the hub password (for an app's
address and password login), a pairing code and its `conclave://pair` link. The web app needs a build first
(`bun run --filter @conclave/web build`). An Android emulator reaches the
host at 10.0.2.2, so start it with `--url http://10.0.2.2:7810` to put that
address in the link. `--info FILE` writes all of it as JSON for scripts, and
`--check` seeds, checks that the approval and the question are pending and
exits. `scripts/screenshots/` uses it to take the screenshots in
`docs/screenshots/apps/`.
