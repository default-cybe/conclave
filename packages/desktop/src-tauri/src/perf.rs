// The app's memory as perf.memory in the hub's log, from the app itself.
//
// WebKitGTK has neither performance.memory nor longtask, so the hub page
// (packages/web/src/lib/clientLog.ts) sends no slowness data from the Linux
// app. Every 5 minutes this reads /proc: the app's own resident memory and
// that of its WebKit processes (the page and the network process, also
// under a bwrap sandbox), and posts them to POST /api/logs/client with the
// app's token. Linux only: macOS runs WKWebView's processes outside the app,
// and the Windows page already reports its JS heap.

use std::{collections::HashMap, fs, time::Duration};

use tauri::{AppHandle, Manager, Url};

const EVERY: Duration = Duration::from_secs(5 * 60);

/// One process from /proc/<pid>/stat.
#[derive(Debug, PartialEq)]
struct Proc {
    pid: u32,
    ppid: u32,
    comm: String,
    rss_pages: u64,
}

/// "pid (comm) state ppid ..." with rss in pages as field 24. comm may hold spaces and parens.
fn parse_stat(line: &str) -> Option<Proc> {
    let open = line.find('(')?;
    let close = line.rfind(')')?;
    let pid = line[..open].trim().parse().ok()?;
    let comm = line[open + 1..close].to_string();
    let rest: Vec<&str> = line[close + 1..].split_whitespace().collect();
    Some(Proc { pid, ppid: rest.get(1)?.parse().ok()?, comm, rss_pages: rest.get(21)?.parse().ok()? })
}

/// (the app, its WebKit processes) in pages: `root` itself, and every
/// descendant whose name starts with WebKit. A hub or daemon the app started is not counted.
fn sum_pages(procs: &[Proc], root: u32) -> (u64, u64) {
    let mut children: HashMap<u32, Vec<&Proc>> = HashMap::new();
    for p in procs {
        children.entry(p.ppid).or_default().push(p);
    }
    let app = procs.iter().find(|p| p.pid == root).map_or(0, |p| p.rss_pages);
    let mut web = 0;
    let mut stack = vec![root];
    while let Some(pid) = stack.pop() {
        for c in children.get(&pid).into_iter().flatten() {
            if c.comm.starts_with("WebKit") {
                web += c.rss_pages;
            }
            stack.push(c.pid);
        }
    }
    (app, web)
}

/// (app MB, WebKit MB) now.
fn sample() -> Option<(u64, u64)> {
    let procs: Vec<Proc> = fs::read_dir("/proc")
        .ok()?
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().bytes().all(|b| b.is_ascii_digit()))
        .filter_map(|e| fs::read_to_string(e.path().join("stat")).ok())
        .filter_map(|s| parse_stat(&s))
        .collect();
    // SAFETY: sysconf only reads a system constant
    let page = unsafe { libc::sysconf(libc::_SC_PAGESIZE) }.max(4096) as u64;
    let (app, web) = sum_pages(&procs, std::process::id());
    let mb = |pages: u64| pages * page / 1_048_576;
    Some((mb(app), mb(web)))
}

/// Report every 5 minutes while a hub and token are saved. Failures are quiet:
/// the next sample tries again.
pub fn start(app: &AppHandle, hub: impl Fn(&AppHandle) -> Option<(Url, String)> + Send + 'static) {
    let app = app.clone();
    let version = app.package_info().version.to_string();
    std::thread::spawn(move || loop {
        std::thread::sleep(EVERY);
        let (Some((base, token)), Some((app_mb, web_mb))) = (hub(&app), sample()) else { continue };
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64);
        let batch = serde_json::json!({
            "app": "desktop",
            "version": version,
            "platform": "Linux",
            "events": [{ "ts": now, "level": "info", "event": "perf.memory", "fields": { "rssMb": app_mb + web_mb, "appMb": app_mb, "webMb": web_mb, "source": "native" } }],
        });
        if let Err(e) = crate::hub::send_client_logs(&base, &token, &batch) {
            eprintln!("conclave: perf.memory: {e}");
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_ppid_and_rss_from_stat_even_with_parens_in_the_name() {
        let line = "4242 (Web (x) Proc) S 100 4242 4242 0 -1 4194304 83 0 0 0 0 0 0 0 20 0 1 0 224982107 2924544 331 18446744073709551615 0";
        assert_eq!(parse_stat(line), Some(Proc { pid: 4242, ppid: 100, comm: "Web (x) Proc".into(), rss_pages: 331 }));
        assert_eq!(parse_stat("garbage"), None);
    }

    #[test]
    fn counts_the_app_and_its_webkit_processes_but_not_the_hub_it_runs() {
        let p = |pid, ppid, comm: &str, rss_pages| Proc { pid, ppid, comm: comm.into(), rss_pages };
        let procs = vec![
            p(10, 1, "conclave-deskto", 100),
            p(11, 10, "WebKitNetworkPr", 20),
            p(12, 10, "bwrap", 1),
            p(13, 12, "WebKitWebProces", 300),
            p(14, 10, "conclave", 500),
            p(20, 1, "WebKitWebProces", 999),
        ];
        assert_eq!(sum_pages(&procs, 10), (100, 320));
        assert_eq!(sum_pages(&procs, 99), (0, 0));
    }

    #[test]
    fn samples_this_process_from_proc() {
        // the test binary itself holds more than 1 MB
        assert!(sample().is_some_and(|(app, _)| app > 0));
    }
}
