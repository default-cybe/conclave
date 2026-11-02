# Members phase 2: private hub sandboxes

Status: proposed, design only. No shell, route, permission or deployment change ships with this document.

## 1. Decision and boundaries

Give each member a persistent private home and run all member-controlled hub code inside a mandatory bubblewrap boundary. Use disposable process sandboxes over that home, not a long-lived container with a host shell. The owner keeps today's local machine. A member's paired devices keep today's account guards.

This extends [ACCOUNTS.md](ACCOUNTS.md), especially sections 5 and 14. Section 14 is newer than the earlier owner-only browser, maps and extension descriptions. It already grants per-account copies where supported; this proposal opens only hub Code, shell, files, stdio MCP and command hooks. Existing denials remain until the corresponding implementation and escape tests pass. Missing isolation must never fall back to `LocalMachine`.

[SHARED-WITH-MEMBERS.md](SHARED-WITH-MEMBERS.md) remains authoritative for shared chats. A shared project's name, a Collaborator role or access to a transcript grants no access to another person's filesystem. Each person has their own clone and branch. A seat runs as its starter, not the chat owner. Participant seats remain chat-only; this design does not enable Collaborator machine tools or harnesses in seats before that separate feature supports them.

Deployment target: CT 135, an unprivileged Debian LXC, 2 CPU cores and 24 GB RAM. Bubblewrap and pasta are installed. Installed binaries do not establish that nested user/network namespaces, seccomp, delegated cgroups or filesystem quotas work. Probe those under the actual hub service identity before enabling any account. No privileged LXC, Docker socket, setuid account-switching helper or root hub process is required or acceptable.

### Threat model

Assume a malicious authenticated member can run arbitrary native binaries, exploit language runtimes, create symlinks and sockets, race file operations, and submit hostile MCP output or hook definitions. Prompt injection is equivalent to that member's arbitrary code. Accounts may attack concurrently.

Protect the owner's and other members' files, keys, provider sign-ins, browser data, processes, IPC, network access, API authority and availability. The member may read, damage or export their own sandbox files; public network access already permits such export. This is not a defense against the owner, the host administrator, a compromised trusted hub/broker, kernel vulnerabilities, or hardware side channels. LXC and bubblewrap share the host kernel; neither supports an absolute guarantee against kernel escape. Keep host kernel, bubblewrap and pasta patched. A kernel-risk requirement beyond this trust model needs separate VMs, not relaxed sandbox flags.

## 2. Current code and implementation seams

Paths below are relative to the repository and describe main at `44256407`. They are evidence, not claims that the proposed sandbox exists.

| Current behavior | Evidence and required seam |
|---|---|
| Account identity uses AsyncLocalStorage; no context preserves legacy owner behavior. | `packages/core/src/people/context.ts:15-32`, `people/guard.ts:40-60`. The new member launcher requires a nonempty, explicit account and verifies context; never apply the owner default at this boundary. |
| Member hub Code starts are refused; `machineFor` returns a refused machine. | `engine/engine.ts:587`, `:1985-1995`. Replace only with a ready, account-bound sandbox machine, preserving all paired-device checks and refusal when unavailable. |
| Foreground Bash uses `machine.exec`; background Bash uses `machine.spawn`. | `tools/bash.ts:102-113`, `tools/shells.ts:130-138`. Both must select the same isolation policy, including the `sh` retry. |
| ACP starts agents and nested terminals through `Machine.spawn`. | `acp/client.ts:126`, `:421`. Harness subprocesses inherit the sandbox, never hub home or environment. |
| Local shell/search execution calls Bun directly and inherits host environment. | `machine/local.ts:570`, `:591-595`, `:620`, `:721`. Do not reuse LocalMachine in the hub process for a member, even for stat, glob or grep. |
| Machine includes files, process spawning and optional preview/import operations. | `machine/types.ts:12-69`. Audit the entire interface, not only exec; optional unsupported methods must refuse, not delegate to host. |
| MCP uses SDK stdio transport directly, and may inherit all environment variables. | `extensions/mcp.ts:155-163`, `:446-453`. Introduce an account-bound transport using sandbox process streams; do not pass a user command to the SDK's host-spawning default. |
| Hooks assemble inherited environment, then call a Bun spawner. | `extensions/hooks.ts:720-760`, `:763-783`. Replace the member command execution path, not the owner's runtime. Async hooks need the same containment and cleanup. |
| Member memory permits only the default Basic Memory stdio command, using a bare environment. | `people/memory.ts:29-40`. Route Basic Memory and any newly allowed member stdio memory connections through the same sandbox launcher. Do not preserve an unsandboxed command exception after opening arbitrary programs. |
| SOCKS relay checks the target and dials that exact IP, with CONNECT only. | `browser/proxy-net.ts:356-376`, `:379-400`, `:447-450`; address classification in `people/net.ts:71-87`. Reuse `SocksRelay.publicOnly` with `resolvePublic` and validated ports. The generic upstream relay is not this fence. |
| Disk accounting is cached, checks application writes and has no kernel quota. | `people/disk.ts:13-16`, `:49-56`, `:68-74`. Keep accounting for display, but do not treat it as a shell write limit. |

Also audit direct file/process paths outside these seams: command expansion, repo cloning, preview, attachments, outputs, RenderFile and its renderers, ReadPost/ffmpeg, import, checkpoints, learned skills, plugin data, tool test endpoints, routines, workflows and subagents. A host-side helper that consumes member paths or runs a renderer can bypass an otherwise correct Machine. Enabling a tool requires its complete execution graph to be contained, or its host-only operations restricted to broker-owned files with explicit account checks.

## 3. Storage and account authority

Let `<hub-data>` be `config.paths.home`, not the OS user's home. Use the immutable validated account id, never a sign-in/display name or a caller-supplied path:

```text
<hub-data>/accounts/<account-id>/
  secrets.json                    existing hub-managed store; never mounted
  cliproxy/                       existing hub-managed sign-ins; never mounted
  browser-profile/                existing browser copy; never mounted
  sandbox/
    home/                         only persistent writable tree visible to code
      work/                       private clones and session folders
      .config/                    private tool and harness settings
      .cache/                     private package caches
      .local/share/               private tool state
    control/                      hub-only policy/config; never mounted
```

Keep account MCP/hook definitions in an account-keyed store or `sandbox/control/`, and secrets in AccountSecrets. No global `config.json` writes. Use `accountKey` for new kv settings; a new independently queried table requires `account_id`, registration in `people/tables.ts`, and sweep coverage. Runtime maps, transport connections, OAuth state, home caches, process handles and namespace handles are keyed by account plus generation, never by server name, device `local`, cwd or session name alone. The same MCP name in Alice and Bob is two independent servers.

Directories are created by the broker with mode 0700 and umask 077, using a symlink-safe parent chain. Mode bits alone do not separate sandboxes: their host uid may be the same hub uid. The security boundary is their mount/process/network view and closed capabilities. Never bind the whole account directory: even the member's own `secrets.json` contains a hub-only part and their CLIProxyAPI management credentials.

Inside every member sandbox, `HOME=/home/member`; `~` and session cwd refer to that namespace. Default cwd is `/home/member/work`. Persist namespace paths in member hub sessions, not host paths. Reject an explicit host cwd; no mapping through a guessed prefix. A distinct internal Machine id such as `sandbox:<account-id>` prevents the existing machine-home cache from mixing accounts; clients may still request device `local`, resolved server-side from the authenticated account. A member cannot select another account's sandbox id.

Files copied into a sandbox are copies, not host symlinks or shared writable binds. Existing attachments and `<hub-data>/outputs/<session-id>` stay scoped by session ownership. Stage inputs and export outputs through sandbox-side reads/writes with bounded bytes. The broker creates export destinations exclusively under its own account-checked output directory; it never follows a member's link into host storage. Reject device nodes, FIFOs, sockets, external hardlinks, traversal archive entries and unsafe links when importing/exporting. Never run an archive extractor on member-controlled paths in the hub namespace.

Account extensions and learned skills from phase 1 remain per-account. If an editor must expose those files, copy through the scoped store; do not mount their parent or let shell writes replace hub policy. Account A's skills, hooks, agents, credentials and caches are never seeded into B, including the owner. Shared builtin tools are immutable, reviewed assets; no owner's home configuration is copied with them.

## 4. Bubblewrap profile

One trusted supervisor prepares each job from immutable policy, establishes resource controls, then releases its executable. A shell job, stdio server, hook or harness receives the same baseline. A sandbox-side file worker implements the full Machine file API. Reuse the existing daemon/Machine wire concepts where useful, but expose only scoped methods over private pipes, not a host-network daemon with a general hub token. Treat file-worker replies as untrusted and bound message sizes. Privileged policy and launcher binaries live outside member-writable trees.

### Namespaces and mounts

- Require user, mount, PID, IPC, UTS, network and cgroup namespaces. Use explicit required flags, not `--unshare-user-try`, `--unshare-cgroup-try` or `--not-a-security-boundary`.
- Map only the invoking unprivileged uid/gid; use a non-root uid inside where supported. No subordinate identity is needed to access another account. Drop all capabilities, enable `no_new_privs`, and disable further user namespaces after setup (`--disable-userns`, asserted with `--assert-userns-disabled` on this bubblewrap version).
- Start from an empty filesystem. Read-only bind an audited minimal runtime: `/usr` and required `/bin`, `/sbin`, `/lib`, `/lib64` symlink targets. Include only approved system package trees; exclude any local provider credential files or writable nested mounts. Do not `--ro-bind / /`: read-only owner keys are still leaked keys.
- Synthesize `/etc/passwd`, `/etc/group`, `/etc/hosts`, `/etc/nsswitch.conf` and resolver policy. Mount only needed public CA certificates and loader configuration individually. Do not expose host `/etc`, SSH host keys, machine identity or host resolver search domains.
- Bind only this account's `sandbox/home` read-write at `/home/member`, using an already validated/open directory. Verify no nested mounts exist; do not recursively import a runtime or home subtree containing host mounts.
- Mount a fresh procfs after entering the job PID namespace. It contains only the job's process tree. Do not bind host `/proc`, namespace handles or `/proc/<host-pid>/root`. Mask unnecessary global proc entries such as `/proc/sys`, `/proc/irq`, `/proc/bus`, `/proc/kcore` and `/proc/keys`; mount no host `/sys` or cgroup filesystem. Remaining system-wide statistics can disclose aggregate load, an explicit residual side channel.
- Supply a minimal private `/dev` with null, zero, random, urandom and private PTYs only when required. No `/dev/net/tun`, block devices, GPU, FUSE, kvm or host tty. Private bounded tmpfs for `/tmp`, `/run` and `/dev/shm`; no host `/tmp` or `/run/user/<uid>`.
- Use `--new-session` and `--die-with-parent`; init/reaper owns descendants. Do not grant a controlling host terminal. Only stdin/stdout/stderr plus narrowly specified bootstrap fds survive setup; close namespace, mount, seccomp, root-directory and host socket fds before running member code. Never pass a systemd bus, SSH agent, Docker socket or generic host IPC endpoint.

Use an immutable system runtime or individually staged read-only tools for Bun/Node, git, Python and harnesses. Do not solve a missing runtime by binding the hub's home, `/var/lib/conclave`, an entire plugin installation tree or its package cache. Running inside a sandbox may require harness-native sandbox flags to change; the outer boundary stays mandatory and cannot be disabled by a harness option.

### Seccomp and environment

Load a versioned, reviewed seccomp BPF filter through bubblewrap `--seccomp FD` before member code starts. Check architecture first and reject alternate syscall ABIs, including x32 where relevant. Filter inheritance must cover exec and threads. Deny namespace changes (`setns`, `unshare`), mount/new mount API, pivot_root, ptrace, process_vm_readv/writev, pidfd_getfd, bpf, perf_event_open, keyctl/add_key/request_key, userfaultfd, io_uring setup, kernel/module/kexec/reboot, device creation and host-facing privileged operations. Restrict socket families to AF_UNIX/AF_INET/AF_INET6; no AF_PACKET, AF_VSOCK or administrative netlink.

Allow ordinary fork/threads but reject namespace flags in `clone`; make `clone3` return ENOSYS so supported runtimes use the filtered clone path. Do not allow clone3 merely because its pointed-to argument struct is difficult for classic seccomp to inspect. Return predictable errors for unsupported operations; run real runtime smoke tests before freezing the allowlist. No user-supplied filter, extra mount, preopened fd or capability override.

Construct a clean environment before launching any trusted helper, and again for the payload. Set fixed PATH, HOME, USER, SHELL, locale, TMPDIR and XDG paths inside the sandbox. Do not inherit host variables, proxy settings, `SSH_AUTH_SOCK`, D-Bus, cloud metadata credentials, loader/runtime injection settings, hub token or owner provider keys. Reject member overrides of launcher policy variables; user runtime customization happens only after isolation. Host secrets must never enter a helper's argv or environment before namespace setup.

Explicit `${secret:...}` expansion reads that account's permitted secret values only, never its `hub` part or the owner's defaults. A member may intentionally give one of their own keys to their MCP server or hook. Inject only those selected values into that payload; redact errors and do not broadcast streams or log tokens. MCP `inheritEnv` is refused for member host processes, not silently interpreted as inheritance from the real hub.

## 5. Network: pasta is transport, SOCKS is policy

Setting `ALL_PROXY` or `HTTPS_PROXY` is not enforcement. Native code can ignore both. Pasta attached directly to the hub network would permit LAN access; `--no-map-gw` alone does not stop connections to private IPs. Never ship that layout.

Use two network namespaces per live sandbox runtime, in addition to the hub namespace:

```text
member job namespace J (private loopback and virtual interface)
  pasta transport
isolated transport namespace T (loopback only; NO host interface/default uplink)
  fixed SOCKS byte bridge, no other listener
private bounded byte channel across namespace boundary
hub-side SocksRelay.publicOnly(resolvePublic + valid port)
  checked public TCP destination
```

The trusted setup supervisor creates T and J under an unprivileged user namespace. Pasta runs in T and attaches to J, never in the host network namespace. T has no Ethernet/veth uplink, routes to the host/LAN, host resolver, or other account's network. A fixed bridge listens on T's loopback at one reserved port. It transports SOCKS bytes to a hub-owned per-runtime public-only relay over a private socketpair/channel. The hub end can connect only to that relay, not arbitrary host addresses. The channel cannot pass file descriptors or generic RPC. Any multiplexing uses bounded frames and per-runtime connection caps. Bootstrap/helper fds are inaccessible to member code.

Configure pasta with explicit static namespace addresses/gateway, no port auto-discovery, no inbound host forwarding (`-t none`, `-u none`), no UDP or ICMP (`--no-udp`, `--no-icmp`), and no host DNS forwarding. IPv6 is disabled initially, not left as an alternate uplink. The only useful gateway mapping is J's reserved proxy endpoint to T's loopback bridge. Even a raw direct connection to another IP/port must have no route from T to a host or external network. A package client uses SOCKS5 with remote name resolution; optional HTTP CONNECT support must translate only into this same SOCKS fence, not introduce another dialer. Unsupported direct-network clients fail with a clear proxy requirement. No transparent TCP interception is promised in this phase.

This layout requires a prototype: verify the installed pasta can attach to J and operate from a loopback-only T with explicit addressing. The exact invocation is deliberately not presented as a tested recipe. If pasta requires a broader network view, cannot attach with LXC restrictions, or maps another reachable endpoint, phase 2 stays disabled. Do not replace this gate with proxy environment variables. A different egress design needs a new review and equivalent native-code bypass tests.

The public-only relay validates port 1 through 65535, parses SOCKS CONNECT only, resolves domains with `resolvePublic`, rejects any answer set containing a forbidden address, and dials the checked literal IP. Unknown names fail closed. Preserve the existing rules for loopback, RFC1918, link-local/metadata, CGNAT, IPv6 ULA/mapped addresses, multicast and local names. A public redirect to private is a fresh CONNECT and is refused; DNS rebinding cannot change the IP already dialled. Direct DNS, UDP/QUIC, raw IP and SOCKS BIND/UDP ASSOCIATE are unavailable.

The existing classifier is the starting policy, not proof that every special-use address is covered. Review transition encodings, NAT64 and deployment routes before release; deny any path that can translate an allowed literal into a local destination. Also deny the hub's own public/local interface addresses and known self-ingress aliases where they lead to privileged hub services. Public reverse proxies require the existing HTTP API account checks regardless of IP filtering. The public internet remains reachable as in today's member tools; a public third-party relay that can reach its own private network cannot be universally detected. No claim of blocking arbitrary public intermediaries is made.

Default for hooks and one-off jobs is no network: J has loopback only and no pasta/channel. An account may explicitly opt a job, MCP server or session into `public` mode, which means the fence above, never host networking. No member option grants LAN, host, other accounts' dev servers or port publishing. A preview connection, if supported, enters only the authenticated account's job namespace and requested permitted port; never use `LocalMachine.connect` to host loopback. Until that broker exists, previews refuse.

## 6. Resource limits and lifecycle

Enforce aggregate per-account limits, not one allowance per job. Initial proposed defaults for this 2-core hub:

| Limit | Account cap | Hub-wide member cap |
|---|---|---|
| CPU | 50% of one core (`CPUQuota=50%`) | 100% of one core, leaving capacity for hub work |
| Memory / swap | 2 GiB / 0 | 8 GiB / 0 |
| Tasks | 128, including threads | 512 |
| Heavy jobs | 1; queue at most 8 | 2 running |
| Persistent disk | existing `diskLimitGb`, default 5 GiB | reserve host free space; stop admissions before hub safety reserve is breached |
| Temporary memory | 128 MiB each for tmp and shm, 16 MiB run | charged to account cgroup |
| Open fds / core dumps | 256 per process / 0 | broker connection and output caps |

Owner-tunable ceilings must fit the parent cap; members cannot raise them. Network helpers, hook async children, MCP servers, file workers, renderers and harness descendants count against the account. Reserve a small portion of account memory/tasks for trusted helpers; a member cannot force unlimited uncharged relay processes. Long-lived idle MCP servers still count. Queueing is bounded and account-fair; refuse excess work rather than holding unbounded requests.

Preferred backend: a delegated cgroup v2 subtree owned by the hub service, with a member parent and account children. A working user systemd manager can create slices and `systemd-run --user --scope` jobs with CPUQuota, MemoryMax, MemorySwapMax and TasksMax. Use a trusted gate so the payload cannot run before cgroup placement and limits are confirmed. Scope creation under a member-accessible user bus is not sufficient; the bus never enters the sandbox. Require group OOM handling and entire-cgroup termination after a short TERM grace period. A detached double-fork or setsid must not survive Stop.

`prlimit` adds NOFILE, CORE=0, FSIZE and per-job CPU-time/address-space limits. It is not a sufficient fallback for this deployment: NPROC follows the shared real uid, FSIZE caps one file rather than a directory, address-space limits are not aggregate memory, and CPU time is not an aggregate CPU share. Without verified cgroup delegation, keep hub Code/shell/stdio/hooks refused. Owner setup may provision delegation outside the hub; do not silently elevate or modify LXC/system services.

Shell writes bypass `people/disk.ts`. Require enforceable byte and inode quotas for every writable persistent mount before arbitrary code is enabled. A supported filesystem project quota or an administrator-provisioned bounded per-account filesystem is acceptable, including block/inode reserves that protect the hub. CT 135's current filesystem support is unverified. Cached `du`, periodic killing and per-file RLIMIT_FSIZE are not substitutes. If quotas cannot be provisioned without a privileged helper, leave phase 2 off and retain the existing separate-user/container paired-daemon alternative. Hardlink/rename operations cannot cross quota projects. Account app data outside sandbox/home remains broker-managed and continues existing accounting; enforce combined budget admission and reserve room for those files.

Shell foreground keeps current tool timeouts (120 seconds default, 600 seconds maximum). Hooks keep event deadlines; network-dependent hooks need an explicit bounded public mode. Background jobs/harnesses have renewable session leases, initially 30 minutes. Stdio MCP servers stop after 10 minutes idle and restart lazily; these are proposed operational defaults, not new timers in this PR. Bound stdout/stderr, hook JSON, RPC frames, pending network requests and export sizes before buffering in the hub.

On Stop, removal, disable or revocation: reject admissions first, bump the account generation, cancel queued work and in-flight launches, stop scopes and kill remaining descendants, close relays/channels, then release mounts and namespace handles. A normal app disconnect need not kill a running session; it cannot change the account lease. Password reset revokes authentication and active sandbox leases so stale streams cannot keep operating. Cleanup uses trusted handles, not member-provided PIDs or path strings. Never kill a recycled host PID from an old process record.

Restart reconciles broker-owned cgroups and leases before accepting work, and kills orphan runtimes. Deleted accounts never auto-recreate their homes. Purge happens only after all writers are dead, and is symlink-safe and limited to that validated account root. Disable/rollback preserves the private files for later recovery; it does not move them into the owner's workspace. Data removal retains the existing explicit account-removal semantics.

## 7. MCP, hooks, Code and application integration

### Stdio MCP and memory servers

Create a member McpManager/transport registry from their own definitions. Do not merge the owner's configured or plugin-contributed server credentials into it. An approved immutable plugin executable may be reused, but its state, env and working directory are private copies. Test/restart/list-tools/call/OAuth/status routes are `self` or an appropriate owned resource check, with account-scoped notifications and output. Existing owner endpoints remain admin unless a handler is explicitly made account-aware; never simply relabel every MCP route `self`.

The transport calls sandbox spawn with an argv array, sandbox cwd and selected member secret values. SDK retries/reconnects capture the original account and generation explicitly; an AsyncLocalStorage context at initial connection time is not enough for a later timer. Streams carry MCP only; they are not authority to call arbitrary hub APIs. Reject host `inheritEnv`, config expansion of owner secrets, external host cwd and requests for extra mounts. HTTP/SSE MCP remains subject to the member public-only policy on every connection, redirect and reconnect; no unsandboxed HTTP transport fallback to the hub's fetch/network.

Basic Memory is an explicit private data copy: migrate or stage only its member-owned data into the sandbox, without mounting the account parent. Stop its old process before switching and preserve a recoverable copy; never run old and new writers concurrently. The design does not migrate it now. Provider calls and budgets continue in the trusted hub. A harness may use its own member sign-in in its sandbox home; it never receives shared hub provider keys or the CLIProxyAPI management/client keys. Any future API broker token must be short-lived and narrowly scoped to the member/session with budget checks; no generic hub token is issued by this phase. A harness needing unsupported host-network auth fails rather than using the owner's login.

### Hooks and command expansion

Use a per-account hook configuration/runtime, plus only explicitly safe immutable builtin handlers. Never run the owner's configured, plugin, project or agent command hooks on a member turn. A hook reads only that member's event input, session id and namespace cwd, and runs in a fresh job sandbox over that member's home. MCP-tool hooks resolve that member's manager; prompt hooks use that member's provider access/budget. Project and agent hook files are read from the sandbox view, not host paths.

Keep existing hook blocking semantics and timeouts, including fail-closed hooks. Async hooks retain an account generation, lease and cgroup; fire-and-forget is not permission to survive revocation. Member-editable hooks cannot replace hub security checks, account guards or the network fence. Shell lines in account commands, currently refused, can open only through this same launcher. Hook test endpoints must use the real sandbox path, not the existing host test spawner. Review any CLI shim: it must not carry owner auth or become a generic host-command RPC tunnel.

### Code session selection and file access

Resolve the session account from trusted storage. For device `local`, the owner receives today's machine; an enabled member receives only their SandboxMachine; a disabled/not-ready member receives the current refusal. Paired-device ownership and offline behavior remain unchanged. Apply this to session/task/GitHub starts, direct device routes, repo clone, Delegate, workflows, routines, subagents, resumed sessions, checkpoints and retry paths. A child cannot request `owner`, another account id or `runAsHub` to escape.

The sandbox machine holds an explicit immutable account id and generation and checks them on every operation against the current context, stored session/device ownership and live readiness. Missing context is refusal for a member handle, even though today's general guard tolerates no context for boot. Jobs created outside a request must capture their account explicitly. An offline or failed sandbox never uses `deps.localMachine`, `machineById('local')` or a host `safeHome` fallback. Update these choke points together before removing `CODE_NEEDS_DEVICE` or any `MEMBER_DENY` entries.

Use the sandbox-side worker for read/stat/write/readdir/rename/remove/glob/grep, not a host fs call guarded only by `resolve` or `realpath`. Symlinks resolve in the job mount namespace; a symlink to `/home/conclave`, `/proc/1/root` or a literal host account path cannot find the host tree. Namespace-root read-only files are allowed, but persistent writes stay in this member's home. Pure `resolve` computes namespace paths only. File data stays bounded and account-scoped when stored as tool output or served as attachments.

No UI is built here. Later clients show "Hub workspace" with the member's own home and quota/readiness error; older clients requesting `local` still receive server-side isolation. No client-provided sandbox id is trusted. Shared chat seats keep their tool restriction and starter billing; a sandbox is not a reason to weaken history shaping, approval ownership or the separate shared-chat rollout.

## 8. Escape-path checks

This is the release checklist, not a claim that unknown kernel escape paths are enumerated. Every row needs a negative integration test; missing coverage blocks the affected surface.

| Escape path | Required boundary/check |
|---|---|
| Pick another account/session/device or forge a sandbox id | Authenticated account, stored ownership, route policy and per-call sandbox binding; indistinguishable 404 for foreign resources. |
| Lost async context, timer, routine, reconnect or retry becomes owner | Explicit account/generation on handles; missing context refuses member execution; no owner-default launch. |
| Host reads via file tools, renderers, search, imports, Git or checkpoints | Entire operation executes inside sandbox; host brokers accept only typed account-checked copies/handles. |
| `..`, absolute path, symlink swap, magic proc link, archive traversal, hardlink | Empty mount root, sandbox-side path resolution, descriptor-safe broker staging and safe import/export; no shared writable inode. |
| Read secrets from account parent, runtime mounts, inherited env, args, logs | Mount only sandbox/home and audited runtime; clean helper/payload env; own-value expansion, no hub part; scoped redacted output. |
| Host `/proc`, namespace fd, pidfd, ptrace, process_vm, kill of host PID | Private PID/proc view; close bootstrap fds; deny introspection syscalls; signal handles verified by job generation. |
| Host IPC, abstract Unix socket, D-Bus, SSH agent, Docker, host tty | Private network/IPC namespaces; no host `/run`/tmp/socket binds; new session, no controlling terminal, no inherited authority. |
| New user namespace, setns, mount, setuid binary, file capabilities | Drop caps, no_new_privs, disabled nested userns, inherited seccomp and ABI checks; immutable launcher. |
| Raw TCP ignores proxy variables; pasta gateway reaches host | Pasta lives only in isolated T; T has no uplink or services except fixed SOCKS bridge. Never attach pasta directly to hub network. |
| DNS rebind, redirect, mapped IPv6, metadata, LAN, hub port | Public-only literal dial for every CONNECT; deny encodings/translations and self-ingress paths; no UDP/DNS/IPv6 bypass. |
| Other member's MCP/hook/cache/preview/dev server reused | Account-plus-generation cache keys, private runtime namespaces, separate state; preview broker targets only own namespace. |
| Host MCP SDK spawn, hook test runner, Basic Memory exception | All member executable starts use one launcher; no bare host-spawner or transport fallback. |
| Malicious MCP output asks hub to sample, fetch resources or execute | No extra SDK capability grants; account-bound tools/approvals only, resource URLs treated as untrusted; no automatic host file/network resolver. |
| CLI shim, harness auth or model gateway exposes owner token | No host login mount or generic token; only member sign-ins or separately reviewed narrow broker credentials. |
| Shell overwrites account control/policy or installed shared plugin | Control tree absent; immutable runtime; account files never loaded as executable hub plugins. |
| Fork/memory/disk/inode/network/output flood | Aggregate cgroup and enforced filesystem quotas, bounded channels, per-account admission and output caps. |
| Daemonize, setsid, fork on Stop, orphan on crash, PID reuse | Cgroup-wide kill, generation fencing, death coupling and restart reconciliation before admissions. |
| Link race while deleting/exporting/migrating data | Stop writers, trusted directory handles, no-follow/exclusive destinations, no host traversal of mutable member paths. |
| Public hub URL bypasses file fence through HTTP API | No leaked owner bearer; existing auth and account scoping on all API/WebSocket/MCP paths; deny known self-ingress in fence. |
| Shared-chat collaborator uses chat owner's sandbox or leaks full output | Starter's seat account, existing shaped transcript/events and approval checks; sandbox never keyed by chat owner. |
| Setup failure silently weakens profile | Required capability probes; no `*-try`, no unsandboxed retries; readiness revoked after any failed enforcement check. |
| Kernel, pasta, bubblewrap or trusted broker vulnerability | Patched components, minimized interfaces and syscall surface; residual risk acknowledged, independent security review before broad enablement. |

## 9. Phases and acceptance gates

1. **Capability prototype, default off.** On a disposable clone of CT 135, under the real hub service identity, prove nested namespaces, full profile, seccomp, loopback-only T/pasta attachment, cgroup delegation and hard byte/inode quotas. Record versions, flags, mount/route views and cgroup placement. Local inspection found bubblewrap 0.12.0 and no reachable user systemd bus from this agent shell; that is not evidence about the hub service. No LXC, systemd or quota change is authorized by this document. Failures keep existing refusals.
2. **Launcher and file boundary.** Implement account storage/handles, SandboxMachine, quotas, supervisor cleanup and the sandbox-side file worker. Add two-member/owner adversarial tests first. Keep arbitrary member code externally disabled until the native escape suite passes. No UI-first permission changes.
3. **Hub Code and shell.** Wire every Machine selection/start/retry path, own repo clones, outputs and foreground/background/harness children. Initially offline; turn on public mode only after network bypass tests pass. Enable per account after review; preserve paired-device behavior and old refusals elsewhere.
4. **Account stdio MCP and memory.** Add scoped configuration/routes/transports and secret injection; move Basic Memory with recoverable member-only data handling. Exercise identical server names across accounts and reconnect/revoke races. The owner's manager stays unchanged.
5. **Account command hooks and commands.** Add own config/runtime and sandboxed test runner, async cleanup and safe command expansion. No automatic inheritance of owner hooks. Re-run full native escape matrix across each executable surface.
6. **Client readiness and rollout.** Show the private workspace/error/quota consistently in web, CLI, Android and desktop; review shared-seat compatibility without expanding seat roles. Enable a small set of members first. Kill switch stops runtimes immediately, preserves homes and restores phase-1 denials. No automatic migration of owner's folders or member paired-device work.

## 10. Test plan and evidence required

### Fast tests in the repository

Use the existing people, engine, tools, MCP, hooks, browser, server route-policy and account-sweep suites. Add launcher-spec tests for mount/env/syscall/fd policy and account id validation; specification snapshots alone are not escape tests. Table-drive each Machine method and every direct spawn seam. Run as owner, Alice, Bob, no context, wrong context, revoked generation and a removed account. Tests must fail if the launcher is replaced with LocalMachine or an SDK host transport.

Prove `local` means the caller's private hub workspace, never a different person's fallback. Cover task/GitHub/Delegate/routine/workflow/subagent starts, restored sessions and offline paired devices. Test same-named MCP servers, hook tests, memory reconnects, account-private skills, outputs, preview ids, events and approvals. Count key selection and usage with two distinct member provider stubs; no owner credential may be resolved for a member child. Shared chat tests keep Participant tools chat-only and any future Collaborator turn in its starter's sandbox.

### Real escape suite, required Linux integration lane

Use a disposable, production-equivalent unprivileged LXC, not a privileged Docker runner. Create synthetic canary files, keys, sockets, processes and listeners for owner/Alice/Bob. No real keys or destructive probes against the live hub. Preflight may skip on a developer machine, but this required CI/deployment gate must fail if capabilities or escape fixtures are missing. Each failure should name the profile version, surface and denied primitive without printing secrets.

Run compiled native probes, not only shell commands, through file worker, foreground/background Bash, ACP/nested terminals, stdio MCP, Basic Memory, synchronous/async hooks, hook tests and command expansion:

1. Read/write the other two accounts' canaries, host database and synthetic key files via absolute/relative paths, proc magic links, symlinks, rename races, hardlinks and archive extraction. Verify canary bytes and metadata unchanged. Test all file methods and broker upload/export paths, not only `cat`.
2. Enumerate `/proc`, inspect guessed host PIDs/environ/fds/root, signal a canary process, and attempt ptrace, process_vm, pidfd_getfd, setns, namespace clone, clone3, mount/new mount API, keyring, bpf, io_uring and alternate syscall ABIs. Check host canary remains alive and unchanged; expected errno and seccomp inheritance are asserted. Test setuid/capability executables and TIOCSTI against an isolated test PTY.
3. Connect to filesystem and abstract Unix socket canaries, D-Bus, SSH agent, Docker and another account's dev server; inspect inherited fds and env before payload startup. Expected: no route/path/authority, no owner marker in streams or environment.
4. Ignore all proxy variables and issue native TCP, IPv4/IPv6, UDP, DNS, ICMP and packet-socket requests to owner loopback, LAN, metadata/link-local, CGNAT, hub interfaces, T gateway and Bob's listener. Monitor canary accept counters and packets: no unauthorized connection or packet may arrive. Attempt arbitrary destinations through pasta and malicious SOCKS frames; only the fixed public-only SOCKS bridge can lead out.
5. Exercise SOCKS literal/domain CONNECT, invalid ports, mixed public/private DNS answers, rebind, redirects, IPv4-mapped IPv6, transition/NAT64 routes and known public self-ingress. Positive control: controlled public HTTPS and git/package retrieval via proxy succeed in `public` mode. Negative control: the same request fails offline. Removing the bridge/relay or killing pasta must close traffic, not create a direct path.
6. Fill disk with many small files, one large file, sparse files, tmpfs, hardlinks and concurrent jobs; exhaust inodes, threads, memory, fds, output and connections. Assert account/parent ceilings and host free-space reserve, and continued owner/Bob responsiveness. Run bounded fork/allocation stress only within verified test cgroups. Measure on 2 cores; do not infer fairness from a larger CI host.
7. Stop/revoke/remove during launch, MCP reconnect, hook async execution, symlink/export races and a double-fork/setsid job. Kill/restart the supervisor/hub. Assert all old-generation children, channels and namespace handles disappear, with no delayed write or restart, no recycled-PID signal, and no account directory recreated after purge.
8. Deliberately disable each safeguard in the test fixture: omit PID isolation, bind a canary parent, inherit a secret marker, bypass the public relay, spawn MCP/hooks on host, remove seccomp, or drop aggregate quota. The corresponding test must fail. This proves probes can detect a missing boundary rather than passing because their target was absent.

Record exact kernel/LXC/bubblewrap/pasta versions, uid maps, effective capabilities, `/proc/self/mountinfo`, fd list, network routes, seccomp status, cgroup limits and quota backend. Compare the observed profile with the intended one before each batch. Security checks must fail closed on version/capability drift. A patched runtime still needs runtime smoke tests: git checkout, package install through proxy, shell, Python/Node/Bun threads, supported harnesses, an echo MCP server and a blocking/async hook.

### This design PR

Only this document and an Unreleased changelog note change. No new runtime behavior exists, so no new executable tests or screenshots are appropriate. Run existing targeted account/network tests and the full Bun suite once at the end, reporting actual counts and failures. Kotlin and Rust compilation require CI: this hub has no JDK or cargo. Prototype, quotas, native escape tests, client screenshots and deployment remain future phase gates, not verified results of this PR.
