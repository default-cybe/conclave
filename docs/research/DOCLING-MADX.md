# Docling on Madx (deployment preview)

A preview, not run by the build. It puts [docling-serve](https://github.com/docling-project/docling-serve)
on the owner's Proxmox host Madx, CPU only, in a new unprivileged LXC that runs the
official container image under Docker, and points Conclave's Read tool at it
(`documents.docling`, tools/docling.ts).

What it gives: Read sends scanned PDFs, PDFs with tables, and docx, xlsx and pptx
files to Docling and gets Markdown back (OCR, table structure). When Docling is
down or slow, Read falls back to its built-in readers and says so in the result.

## Sizes

- Image: `quay.io/docling-project/docling-serve-cpu` (also `ghcr.io/docling-project/docling-serve-cpu`), about 4.4 GB, amd64 and arm64. The model weights ship inside the image.
- Port: 5001 (HTTP). API at `/v1/convert/file`, health at `/health`, API docs at `/docs`.
- RAM: 4 GB for the LXC (Docling uses about 2 to 3 GB while converting a PDF with OCR), 1 GB swap.
- CPU: 4 cores. Disk: 20 GB (image plus Docker's layers).

## 1. Create the LXC (on the Madx host shell)

Placeholders: CT id `140`, storage `local-lvm`, bridge `vmbr0`. Pick a free id and
the owner's storage; check the template name with `pveam available --section system`.

```sh
pveam update
pveam download local debian-12-standard_12.7-1_amd64.tar.zst

pct create 140 local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst \
  --hostname docling \
  --unprivileged 1 \
  --features nesting=1,keyctl=1 \
  --cores 4 --memory 4096 --swap 1024 \
  --rootfs local-lvm:20 \
  --net0 name=eth0,bridge=vmbr0,ip=dhcp \
  --onboot 1
pct start 140
pct exec 140 -- ip -4 addr show eth0   # note the address, e.g. 192.168.1.140
```

`nesting=1,keyctl=1` lets Docker run inside the unprivileged container.

## 2. Install Docker and pull the image (inside the LXC)

```sh
pct enter 140
apt-get update && apt-get install -y docker.io curl
docker pull quay.io/docling-project/docling-serve-cpu:latest
```

Pin a release instead of `latest` once it works (for example `:v1.18.0`, the tag the
README names), so an update never changes the output without notice.

## 3. systemd unit (inside the LXC)

`/etc/systemd/system/docling-serve.service`:

```ini
[Unit]
Description=docling-serve (CPU)
After=docker.service network-online.target
Requires=docker.service

[Service]
Restart=always
RestartSec=10
ExecStartPre=-/usr/bin/docker rm -f docling-serve
ExecStart=/usr/bin/docker run --rm --name docling-serve \
  -p 5001:5001 \
  --memory 3500m \
  -e DOCLING_SERVE_ENG_LOC_NUM_WORKERS=1 \
  -e DOCLING_SERVE_MAX_SYNC_WAIT=300 \
  -e DOCLING_SERVE_MAX_NUM_PAGES=100 \
  -e OMP_NUM_THREADS=4 \
  quay.io/docling-project/docling-serve-cpu:latest
ExecStop=/usr/bin/docker stop docling-serve

[Install]
WantedBy=multi-user.target
```

```sh
systemctl daemon-reload
systemctl enable --now docling-serve
curl -s http://127.0.0.1:5001/health    # {"status":"ok"} once it is up (the first start takes a minute)
```

`DOCLING_SERVE_MAX_SYNC_WAIT=300` lets a long scanned PDF finish on CPU; the
Conclave timeout below matches it.

## 4. Keep it on the LAN

The API has no key in this setup (Conclave does not send `X-Api-Key`), so only the
hub should reach it. On the LXC, or with the Proxmox firewall for CT 140, allow
port 5001 from the hub's address only (placeholder `192.168.1.10`):

```sh
apt-get install -y nftables
nft add table inet docling
nft add chain inet docling input '{ type filter hook input priority 0; }'
nft add rule inet docling input tcp dport 5001 ip saddr != 192.168.1.10 drop
```

Note: Docker publishes the port through its own forward chain; if the rule above
does not stop other hosts, put the same rule in the Proxmox firewall for CT 140
instead (Datacenter, 140, Firewall: allow tcp 5001 from the hub, enable the firewall).
Do not route it through the Cloudflare tunnel.

## 5. Point Conclave at it

In the hub's `config.json` (the owner edits it; member sessions never use it):

```json
"documents": { "docling": { "url": "http://192.168.1.140:5001", "timeoutMs": 300000 } }
```

Check from the hub: `curl -s http://192.168.1.140:5001/health`, then ask a session to
Read a scanned PDF or a docx; the PDF result header ends with "converted by Docling".

## Undo

`pct stop 140 && pct destroy 140` on Madx, and remove the `documents` line from the config.
