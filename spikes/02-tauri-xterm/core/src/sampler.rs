//! Échantillonnage CPU / mémoire d'un arbre de processus via `/proc`
//! (l'app et ses descendants : WebKitWebProcess, WebKitNetworkProcess, bwrap… ou, en mode web,
//! les processus de Chrome, distingués par leur `--type=`).

use serde::Serialize;
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::process::Command;
use std::time::Instant;

#[derive(Debug, Clone)]
pub struct ProcSample {
    pub pid: u32,
    pub comm: String,
    /// utime + stime, en ticks d'horloge.
    pub ticks: u64,
    pub rss_bytes: u64,
}

#[derive(Debug, Clone)]
pub struct Sample {
    /// Secondes depuis la création de l'échantillonneur.
    pub t_s: f64,
    pub procs: Vec<ProcSample>,
    /// Processus hors de l'arbre mesurés à part (compositeur : gnome-shell, Xwayland).
    pub outside: Vec<ProcSample>,
}

/// Processus du compositeur, mesurés « hors total » (ils servent aussi les autres fenêtres).
pub const OUTSIDE: [&str; 2] = ["gnome-shell", "Xwayland"];

/// Lit `/proc/<pid>/stat` : (comm, ppid, ticks, rss en pages).
fn read_stat(pid: u32) -> Option<(String, u32, u64, u64)> {
    let s = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let open = s.find('(')?;
    let close = s.rfind(')')?;
    let comm = s[open + 1..close].to_string();
    let f: Vec<&str> = s[close + 2..].split_whitespace().collect();
    // Après « (comm) » : 0 = état, 1 = ppid, 11 = utime, 12 = stime, 21 = rss.
    let ppid = f.get(1)?.parse().ok()?;
    let ticks = f.get(11)?.parse::<u64>().ok()? + f.get(12)?.parse::<u64>().ok()?;
    let rss = f.get(21)?.parse().ok()?;
    Some((comm, ppid, ticks, rss))
}

/// Nom court du processus (`comm`).
pub fn comm(pid: u32) -> Option<String> {
    read_stat(pid).map(|s| s.0)
}

/// Libellé d'un processus : `comm`, suivi du rôle Chrome (`--type=renderer`, `gpu-process`,
/// `utility: NetworkService`…) quand la ligne de commande en porte un.
pub fn label(comm: &str, cmdline: &[u8]) -> String {
    let args: Vec<&str> = cmdline
        .split(|&b| b == 0 || b == b' ')
        .filter_map(|a| std::str::from_utf8(a).ok())
        .collect();
    let value = |key: &str| args.iter().find_map(|a| a.strip_prefix(key));
    match value("--type=") {
        None => comm.to_string(),
        Some(t) => match value("--utility-sub-type=") {
            Some(sub) => format!("{comm} ({t}: {})", sub.rsplit('.').next().unwrap_or(sub)),
            None => format!("{comm} ({t})"),
        },
    }
}

/// Ligne de commande brute (arguments séparés par NUL ; Chrome réécrit parfois avec des espaces).
pub fn cmdline(pid: u32) -> Vec<u8> {
    fs::read(format!("/proc/{pid}/cmdline")).unwrap_or_default()
}

/// Processus vivant (présent et pas zombie).
pub fn is_alive(pid: u32) -> bool {
    fs::read_to_string(format!("/proc/{pid}/stat"))
        .ok()
        .and_then(|s| s.rfind(')').map(|i| s[i + 2..].starts_with(|c| c != 'Z')))
        .unwrap_or(false)
}

/// Tous les processus : (pid, comm, ppid).
fn all_procs() -> Vec<(u32, String, u32)> {
    let mut out = Vec::new();
    if let Ok(dir) = fs::read_dir("/proc") {
        for e in dir.flatten() {
            if let Some(pid) = e.file_name().to_str().and_then(|n| n.parse::<u32>().ok()) {
                if let Some((comm, ppid, _, _)) = read_stat(pid) {
                    out.push((pid, comm, ppid));
                }
            }
        }
    }
    out
}

/// `root` et tous ses descendants.
pub fn process_tree(root: u32) -> Vec<u32> {
    tree_of(root, &all_procs())
}

fn tree_of(root: u32, procs: &[(u32, String, u32)]) -> Vec<u32> {
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for (pid, _, ppid) in procs {
        children.entry(*ppid).or_default().push(*pid);
    }
    let mut out = vec![root];
    let mut i = 0;
    while i < out.len() {
        if let Some(c) = children.get(&out[i]) {
            out.extend(c);
        }
        i += 1;
    }
    out
}

fn getconf(name: &str, default: u64) -> u64 {
    Command::new("getconf")
        .arg(name)
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(default)
}

pub struct Sampler {
    root: u32,
    start: Instant,
    clk_tck: f64,
    page_size: u64,
    pub samples: Vec<Sample>,
}

impl Sampler {
    pub fn new(root: u32) -> Self {
        Self {
            root,
            start: Instant::now(),
            clk_tck: getconf("CLK_TCK", 100) as f64,
            page_size: getconf("PAGESIZE", 4096),
            samples: Vec::new(),
        }
    }

    /// Secondes écoulées sur l'horloge de l'échantillonneur.
    pub fn now_s(&self) -> f64 {
        self.start.elapsed().as_secs_f64()
    }

    pub fn sample(&mut self) {
        let t_s = self.now_s();
        let all = all_procs();
        let read = |pid: u32| {
            let (comm, _, ticks, rss) = read_stat(pid)?;
            Some(ProcSample {
                pid,
                comm: label(&comm, &cmdline(pid)),
                ticks,
                rss_bytes: rss * self.page_size,
            })
        };
        let tree = tree_of(self.root, &all);
        let procs = tree.iter().filter_map(|&pid| read(pid)).collect();
        let outside = all
            .iter()
            .filter(|(pid, comm, _)| OUTSIDE.contains(&comm.as_str()) && !tree.contains(pid))
            .filter_map(|(pid, _, _)| read(*pid))
            .collect();
        self.samples.push(Sample {
            t_s,
            procs,
            outside,
        });
    }

    /// Moyennes CPU et pics mémoire entre `from_s` et `to_s`.
    pub fn summarize(&self, from_s: f64, to_s: f64) -> CpuSummary {
        summarize(&self.samples, from_s, to_s, self.clk_tck)
    }
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct CpuSummary {
    pub samples: usize,
    /// CPU moyen de tout l'arbre, en % d'un cœur.
    pub cpu_avg_pct: Option<f64>,
    pub cpu_avg_pct_by_process: BTreeMap<String, f64>,
    pub rss_max_mb: Option<f64>,
    pub rss_max_mb_by_process: BTreeMap<String, f64>,
    /// Compositeur (gnome-shell, Xwayland), hors de l'arbre et hors total.
    pub outside_cpu_avg_pct_by_process: BTreeMap<String, f64>,
}

/// CPU moyen par nom entre échantillons consécutifs (pid présent des deux côtés).
fn cpu_by_name<'a>(
    win: &[&'a Sample],
    procs: impl Fn(&'a Sample) -> &'a [ProcSample],
    clk_tck: f64,
) -> Option<BTreeMap<String, f64>> {
    let mut ticks_by_name: BTreeMap<String, u64> = BTreeMap::new();
    let mut dt = 0.0;
    for pair in win.windows(2) {
        let (a, b) = (pair[0], pair[1]);
        dt += b.t_s - a.t_s;
        let before: HashMap<u32, u64> = procs(a).iter().map(|p| (p.pid, p.ticks)).collect();
        for p in procs(b) {
            if let Some(&t0) = before.get(&p.pid) {
                *ticks_by_name.entry(p.comm.clone()).or_default() += p.ticks.saturating_sub(t0);
            }
        }
    }
    (dt > 0.0).then(|| {
        ticks_by_name
            .into_iter()
            .map(|(k, v)| (k, 100.0 * v as f64 / clk_tck / dt))
            .collect()
    })
}

pub fn summarize(samples: &[Sample], from_s: f64, to_s: f64, clk_tck: f64) -> CpuSummary {
    let win: Vec<&Sample> = samples
        .iter()
        .filter(|s| s.t_s >= from_s && s.t_s <= to_s)
        .collect();
    let mut out = CpuSummary {
        samples: win.len(),
        ..Default::default()
    };
    // RSS : pic par nom de processus et pic de la somme.
    let mut rss_total_max = 0u64;
    for s in &win {
        rss_total_max = rss_total_max.max(s.procs.iter().map(|p| p.rss_bytes).sum());
        let mut by_name: HashMap<&str, u64> = HashMap::new();
        for p in &s.procs {
            *by_name.entry(&p.comm).or_default() += p.rss_bytes;
        }
        for (name, b) in by_name {
            let e = out
                .rss_max_mb_by_process
                .entry(name.to_string())
                .or_insert(0.0);
            *e = e.max(b as f64 / 1e6);
        }
    }
    if !win.is_empty() {
        out.rss_max_mb = Some(rss_total_max as f64 / 1e6);
    }
    // CPU : différences de ticks entre échantillons consécutifs, par pid présent des deux côtés.
    if let Some(by) = cpu_by_name(&win, |s| &s.procs, clk_tck) {
        out.cpu_avg_pct = Some(by.values().sum());
        out.cpu_avg_pct_by_process = by;
    }
    out.outside_cpu_avg_pct_by_process =
        cpu_by_name(&win, |s| &s.outside, clk_tck).unwrap_or_default();
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn samples_own_process() {
        let mut s = Sampler::new(std::process::id());
        s.sample();
        // Un peu de travail CPU pour que les ticks bougent.
        let t = Instant::now();
        let mut x = 0u64;
        while t.elapsed().as_millis() < 300 {
            x = x.wrapping_add(1);
        }
        std::hint::black_box(x);
        s.sample();
        let sum = s.summarize(0.0, 1e9);
        assert_eq!(sum.samples, 2);
        assert!(sum.rss_max_mb.unwrap() > 0.0);
        let cpu = sum.cpu_avg_pct.unwrap();
        assert!(cpu > 30.0 && cpu < 400.0, "cpu = {cpu}");
    }

    #[test]
    fn chrome_labels() {
        assert_eq!(
            label("WebKitWebProces", b"/usr/lib/WebKitWebProcess\x007\x0012"),
            "WebKitWebProces"
        );
        assert_eq!(
            label("chrome", b"/opt/google/chrome/chrome\x00--app=x"),
            "chrome"
        );
        assert_eq!(
            label(
                "chrome",
                b"/opt/google/chrome/chrome --type=renderer --enable-gpu"
            ),
            "chrome (renderer)"
        );
        assert_eq!(
            label(
                "chrome",
                b"chrome\x00--type=utility\x00--utility-sub-type=network.mojom.NetworkService"
            ),
            "chrome (utility: NetworkService)"
        );
    }

    #[test]
    fn summarize_synthetic() {
        let p = |pid, comm: &str, ticks, rss| ProcSample {
            pid,
            comm: comm.into(),
            ticks,
            rss_bytes: rss,
        };
        let samples = vec![
            Sample {
                t_s: 0.0,
                outside: vec![],
                procs: vec![
                    p(1, "app", 0, 10_000_000),
                    p(2, "WebKitWebProces", 0, 50_000_000),
                ],
            },
            Sample {
                t_s: 1.0,
                outside: vec![],
                procs: vec![
                    p(1, "app", 10, 12_000_000),
                    p(2, "WebKitWebProces", 30, 60_000_000),
                ],
            },
            Sample {
                t_s: 2.0,
                outside: vec![],
                procs: vec![
                    p(1, "app", 20, 11_000_000),
                    p(2, "WebKitWebProces", 50, 55_000_000),
                ],
            },
        ];
        let s = summarize(&samples, 0.0, 2.0, 100.0);
        assert!((s.cpu_avg_pct.unwrap() - 35.0).abs() < 1e-9);
        assert!((s.cpu_avg_pct_by_process["app"] - 10.0).abs() < 1e-9);
        assert!((s.rss_max_mb.unwrap() - 72.0).abs() < 1e-9);
        // Fenêtre restreinte.
        assert_eq!(summarize(&samples, 1.5, 2.0, 100.0).cpu_avg_pct, None);
    }
}
