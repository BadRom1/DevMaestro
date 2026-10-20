//! Faux `claude` pour les tests d'intégration du démon (jamais distribué).
//!
//! Il accepte les mêmes options que `claude` pour ce que le démon utilise
//! (`--session-id`, `--resume`, `--permission-mode`, `--model`,
//! `--plugin-dir`, `--settings`, prompt en dernier), affiche un écran façon
//! TUI, appelle les hooks déclarés dans `<plugin-dir>/hooks/hooks.json` avec
//! un JSON réaliste (celui des jeux d'événements du prototype n° 1) et la
//! statusline déclarée dans `--settings`.
//!
//! Clavier en mode brut. Commandes (une ligne, puis Entrée) :
//!
//! - texte libre : un tour complet avec une permission Bash, que la « TUI »
//!   accepte d'elle-même au bout de [`AUTO_ANSWER`] si l'app n'a pas répondu ;
//! - `/perm <outil> [nosug]` : `PreToolUse` puis un `PermissionRequest`
//!   **bloquant** (avec des `permission_suggestions`, sauf `nosug`). Comme la
//!   vraie TUI (prototype n° 1, Q5), un dialogue s'affiche pendant que le
//!   relais attend : la première réponse gagne, touche `o` / `n` dans le
//!   terminal ou décision lue sur la sortie du relais. Une réponse dans le
//!   terminal n'attend pas le relais (il reste en vie jusqu'à ce que le démon
//!   le libère). Autorisé : `PostToolUse` ; refusé : « refusé » ;
//! - `/ask` : la même chose pour `AskUserQuestion` (deux questions, dont une
//!   à choix multiples) ; affiche les réponses reçues. Touche `1` : premier
//!   choix de chaque question, dans le terminal ;
//! - `/ctl` : tente d'utiliser le socket de contrôle depuis un processus
//!   enfant (chemin déduit de `ORCH_SOCKET`) ; `/ctl-detache` : depuis un
//!   petit-enfant rattaché à `init` ;
//! - `/exit` (après un `SessionEnd`), `/crash` (code 3, sans `SessionEnd`),
//!   `/tetu` (ignore `SIGHUP`).
//!
//! Shift+Tab (`ESC [ Z`) fait tourner le mode comme la TUI de Claude Code
//! 2.1.303 : `default` → `acceptEdits` → `plan` → `auto` → `default` ; le
//! mode courant est celui des hooks suivants. Les changements de taille
//! (SIGWINCH) sont affichés.
//!
//! Si `FAKE_CLAUDE_LOG` est défini, chaque lancement y ajoute une ligne JSON
//! (`args`, quelques variables, le jeton), chaque relais `PermissionRequest`
//! terminé une ligne `{"hook": …, "code", "stdout", "elapsed_ms"}`, et chaque
//! sonde du socket de contrôle une ligne `{"probe": …}`.

use std::cell::RefCell;
use std::collections::VecDeque;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use serde_json::{Value, json};

static WINCH: AtomicBool = AtomicBool::new(false);
static TOOL_SEQ: AtomicU32 = AtomicU32::new(0);
/// Relais lancés sans attente, pas encore terminés.
static PENDING_HOOKS: AtomicU32 = AtomicU32::new(0);

/// Délai au bout duquel la « TUI » accepte d'elle-même la permission d'un
/// tour ordinaire (texte libre).
const AUTO_ANSWER: Duration = Duration::from_millis(300);

const MODE_CYCLE: [&str; 4] = ["default", "acceptEdits", "plan", "auto"];

/// Pied de la TUI pour un mode, comme Claude Code 2.1.303 (symboles et
/// couleurs compris).
fn footer(mode: &str) -> String {
    match mode {
        "default" => "\x1b[2m⏸ manual mode on\x1b[0m".into(),
        "acceptEdits" => "\x1b[35m⏵⏵ accept edits on\x1b[2m (shift+tab to cycle)\x1b[0m".into(),
        "plan" => "\x1b[36m⏸ plan mode on\x1b[2m (shift+tab to cycle)\x1b[0m".into(),
        "auto" => "\x1b[33m⏵⏵ auto mode on\x1b[2m (shift+tab to cycle)\x1b[0m".into(),
        other => format!("mode {other}"),
    }
}

extern "C" fn on_winch(_: nix::libc::c_int) {
    WINCH.store(true, Ordering::SeqCst);
}

nix::ioctl_read_bad!(get_winsize, nix::libc::TIOCGWINSZ, nix::pty::Winsize);

#[derive(Debug, Default)]
struct Args {
    session_id: Option<String>,
    resume: Option<String>,
    mode: Option<String>,
    model: Option<String>,
    plugin_dir: Option<PathBuf>,
    settings: Option<PathBuf>,
    prompt: Option<String>,
}

fn parse_args(raw: &[String]) -> Result<Args, String> {
    let mut a = Args::default();
    let mut it = raw.iter();
    while let Some(arg) = it.next() {
        let mut value = |name: &str| {
            it.next()
                .cloned()
                .ok_or_else(|| format!("l'option {name} attend une valeur"))
        };
        match arg.as_str() {
            "--session-id" => a.session_id = Some(value(arg)?),
            "--resume" => a.resume = Some(value(arg)?),
            "--permission-mode" => {
                let m = value(arg)?;
                if m == "default" {
                    // Comme claude 2.1.303 : « default » est refusé.
                    return Err("mode « default » refusé, utiliser « manual »".into());
                }
                a.mode = Some(m)
            }
            "--model" => a.model = Some(value(arg)?),
            "--plugin-dir" => a.plugin_dir = Some(PathBuf::from(value(arg)?)),
            "--settings" => a.settings = Some(PathBuf::from(value(arg)?)),
            // Fin des options : le reste est le prompt (comme commander.js).
            "--" => {
                let rest: Vec<&str> = it.by_ref().map(String::as_str).collect();
                if !rest.is_empty() {
                    a.prompt = Some(rest.join(" "));
                }
            }
            other if other.starts_with('-') && other != "-" => {
                return Err(format!("option inconnue : {other}"));
            }
            other => a.prompt = Some(other.to_owned()),
        }
    }
    Ok(a)
}

fn out(s: &str) {
    let mut o = std::io::stdout();
    let _ = o.write_all(s.as_bytes());
    let _ = o.flush();
}

fn log_line(line: Value) {
    if let Some(log) = std::env::var_os("FAKE_CLAUDE_LOG")
        && let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(log)
    {
        // Une seule écriture en O_APPEND : les lignes de plusieurs fils ou
        // processus ne se mélangent pas.
        let _ = f.write_all(format!("{line}\n").as_bytes());
    }
}

/// Touche lue au clavier.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Key {
    Char(char),
    Enter,
    Backspace,
    ShiftTab,
}

/// Clavier : octets lus dans un fil, découpés en touches (dont `ESC [ Z`).
struct Keys {
    rx: mpsc::Receiver<Vec<u8>>,
    queue: VecDeque<Key>,
    /// 0 : normal ; 1 : après ESC ; 2 : après ESC [.
    esc: u8,
}

impl Keys {
    fn feed(&mut self, data: &[u8]) {
        for c in String::from_utf8_lossy(data).chars() {
            match (self.esc, c) {
                (0, '\x1b') => self.esc = 1,
                (1, '[') => self.esc = 2,
                (2, 'Z') => {
                    self.esc = 0;
                    self.queue.push_back(Key::ShiftTab);
                }
                // Séquence ignorée (flèches…) : on attend sa lettre finale.
                (2, c) if c.is_ascii_alphabetic() || c == '~' => self.esc = 0,
                (2, _) => {}
                (1, _) => self.esc = 0,
                (_, '\r' | '\n') => self.queue.push_back(Key::Enter),
                (_, '\x7f' | '\x08') => self.queue.push_back(Key::Backspace),
                (_, c) if !c.is_control() => self.queue.push_back(Key::Char(c)),
                _ => {}
            }
        }
    }

    /// Prochaine touche, au plus `wait` ; le processus sort si le clavier
    /// est fermé.
    fn next(&mut self, wait: Duration) -> Option<Key> {
        if let Some(k) = self.queue.pop_front() {
            return Some(k);
        }
        match self.rx.recv_timeout(wait) {
            Ok(d) => {
                self.feed(&d);
                self.queue.pop_front()
            }
            Err(mpsc::RecvTimeoutError::Timeout) => None,
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                // Terminal perdu : on laisse d'abord les relais en cours finir
                // (et leur résultat s'écrire dans le journal).
                let start = Instant::now();
                while PENDING_HOOKS.load(Ordering::SeqCst) > 0
                    && start.elapsed() < Duration::from_secs(10)
                {
                    std::thread::sleep(Duration::from_millis(10));
                }
                std::process::exit(0)
            }
        }
    }
}

/// Résultat d'un relais lancé sans l'attendre.
struct HookResult {
    stdout: Vec<u8>,
}

/// Réponse obtenue au dialogue d'une permission ou d'une question.
enum Answer {
    /// Décision lue sur la sortie du relais (l'app a répondu).
    App(Value),
    /// Réponse dans le terminal : `true` = oui.
    Tui(bool),
}

struct Fake {
    args: Args,
    session_id: String,
    cwd: String,
    hooks: Value,
    plugin_root: String,
    mode: RefCell<String>,
    /// Pied de la TUI affiché après Shift+Tab (`/sans-pied` le retire, pour
    /// imiter une version de Claude Code sans indicateur reconnu).
    footer: RefCell<bool>,
    /// Le pied est affiché (sous chaque invite, toujours à jour comme dans
    /// la vraie TUI) : dès le lancement avec `--permission-mode`, sinon après
    /// le premier Shift+Tab (mode d'abord inconnu du démon).
    footer_on_screen: RefCell<bool>,
}

impl Fake {
    /// Invite `> ` précédée du pied du mode courant s'il est affiché.
    fn prompt_line(&self, line: &str) -> String {
        if *self.footer.borrow() && *self.footer_on_screen.borrow() {
            format!("  {}\r\n> {line}", footer(&self.hook_mode()))
        } else {
            format!("> {line}")
        }
    }

    /// `/hook-perime <mode>` : un hook neutre (`Notification`) qui porte un
    /// autre mode que le mode courant, comme un hook émis avant un Shift+Tab
    /// et arrivé après.
    fn stale_hook(&self, mode: &str) {
        self.send_stale_hook(mode);
        out(&format!("hook en retard envoyé : {mode}\r\n"));
    }

    fn send_stale_hook(&self, mode: &str) {
        let mut ev = self.base("Notification");
        ev["permission_mode"] = json!(mode);
        ev["notification_type"] = json!("information");
        ev["message"] = json!("hook en retard");
        self.hook("Notification", ev);
    }
    /// `permission_mode` tel que l'écrivent les hooks : `manual` → `default`.
    fn hook_mode(&self) -> String {
        self.mode.borrow().clone()
    }

    fn cycle_mode(&self) {
        let next = {
            let m = self.mode.borrow();
            match MODE_CYCLE.iter().position(|c| *c == m.as_str()) {
                Some(i) => MODE_CYCLE[(i + 1) % MODE_CYCLE.len()],
                None => MODE_CYCLE[0],
            }
        };
        *self.mode.borrow_mut() = next.to_owned();
    }

    fn base(&self, event: &str) -> Value {
        json!({
            "session_id": self.session_id,
            "transcript_path": format!("/tmp/faux/{}.jsonl", self.session_id),
            "cwd": self.cwd,
            "hook_event_name": event,
        })
    }

    fn with_mode(&self, event: &str) -> Value {
        let mut ev = self.base(event);
        ev["permission_mode"] = json!(self.hook_mode());
        ev
    }

    fn matches(matcher: Option<&str>, tool: Option<&str>) -> bool {
        match (matcher, tool) {
            (None | Some("" | "*"), _) | (_, None) => true,
            (Some(m), Some(t)) => m.split(['|', ',']).any(|x| x.trim() == t),
        }
    }

    /// Commandes des hooks d'un événement qui correspondent à l'outil.
    fn commands(&self, event: &str, tool: Option<&str>) -> Vec<Command> {
        let groups = self.hooks["hooks"][event]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let mut cmds = Vec::new();
        for g in groups {
            if !Self::matches(g.get("matcher").and_then(Value::as_str), tool) {
                continue;
            }
            for h in g["hooks"].as_array().into_iter().flatten() {
                let expand = |s: &str| s.replace("${CLAUDE_PLUGIN_ROOT}", &self.plugin_root);
                let Some(cmd) = h["command"].as_str() else {
                    continue;
                };
                let c = match h.get("args").and_then(Value::as_array) {
                    Some(args) => {
                        let mut c = Command::new(expand(cmd));
                        c.args(args.iter().filter_map(Value::as_str).map(expand));
                        c
                    }
                    None => {
                        let mut c = Command::new("sh");
                        c.arg("-c").arg(expand(cmd));
                        c
                    }
                };
                cmds.push(c);
            }
        }
        cmds
    }

    /// Lance les hooks de l'événement, l'un après l'autre, et les attend
    /// (comme claude pour les hooks d'un même événement, à l'ordre près).
    fn hook(&self, event: &str, payload: Value) {
        let tool = payload.get("tool_name").and_then(Value::as_str);
        let input = serde_json::to_vec(&payload).unwrap();
        for mut c in self.commands(event, tool) {
            let child = c
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn();
            let Ok(mut child) = child else {
                out(&format!("[hook {event} : lancement impossible]\r\n"));
                continue;
            };
            if let Some(mut stdin) = child.stdin.take() {
                let _ = stdin.write_all(&input);
            }
            if let Ok(o) = child.wait_with_output() {
                if !o.status.success() {
                    out(&format!("[hook {event} : code {:?}]\r\n", o.status.code()));
                }
                if !o.stdout.is_empty() {
                    out(&format!("[hook {event} : sortie inattendue]\r\n"));
                }
            }
        }
    }

    /// Lance le premier hook de l'événement **sans l'attendre** : son
    /// résultat arrive sur le canal renvoyé (et dans `FAKE_CLAUDE_LOG`).
    fn spawn_hook(&self, event: &str, payload: Value) -> mpsc::Receiver<HookResult> {
        let (tx, rx) = mpsc::channel();
        let tool = payload.get("tool_name").and_then(Value::as_str);
        let Some(mut c) = self.commands(event, tool).into_iter().next() else {
            return rx;
        };
        let input = serde_json::to_vec(&payload).unwrap();
        let event = event.to_owned();
        PENDING_HOOKS.fetch_add(1, Ordering::SeqCst);
        std::thread::spawn(move || {
            let start = Instant::now();
            // Décompté à la sortie du fil, quoi qu'il arrive.
            struct Done;
            impl Drop for Done {
                fn drop(&mut self) {
                    PENDING_HOOKS.fetch_sub(1, Ordering::SeqCst);
                }
            }
            let _done = Done;
            let child = c
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn();
            let Ok(mut child) = child else {
                return;
            };
            if let Some(mut stdin) = child.stdin.take() {
                let _ = stdin.write_all(&input);
            }
            let Ok(o) = child.wait_with_output() else {
                return;
            };
            log_line(json!({
                "hook": event,
                "code": o.status.code(),
                "stdout": String::from_utf8_lossy(&o.stdout),
                "elapsed_ms": start.elapsed().as_millis() as u64,
            }));
            let _ = tx.send(HookResult { stdout: o.stdout });
        });
        rx
    }

    fn statusline(&self) {
        let Some(path) = &self.args.settings else {
            return;
        };
        let Ok(text) = std::fs::read_to_string(path) else {
            return;
        };
        let Ok(settings) = serde_json::from_str::<Value>(&text) else {
            return;
        };
        let Some(cmd) = settings["statusLine"]["command"].as_str() else {
            return;
        };
        let payload = json!({
            "session_id": self.session_id,
            "cwd": self.cwd,
            "session_name": "Session factice",
            "model": {"id": self.args.model.clone().unwrap_or("claude-opus-5-5".into()),
                      "display_name": "Opus 5.5"},
            "workspace": {"current_dir": self.cwd, "project_dir": self.cwd},
            "cost": {"total_cost_usd": 0.42},
            "context_window": {"total_input_tokens": 1200, "total_output_tokens": 34,
                               "context_window_size": 1000000, "used_percentage": 7},
        });
        let child = Command::new("sh")
            .arg("-c")
            .arg(cmd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn();
        let Ok(mut child) = child else { return };
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(&serde_json::to_vec(&payload).unwrap());
        }
        if let Ok(o) = child.wait_with_output() {
            let line = String::from_utf8_lossy(&o.stdout);
            out(&format!(
                "\x1b[2m statusline : {}\x1b[0m\r\n",
                line.lines().next().unwrap_or("")
            ));
        }
    }

    fn prompt_submit(&self, prompt: &str) {
        let mut ev = self.with_mode("UserPromptSubmit");
        ev["prompt"] = json!(prompt);
        self.hook("UserPromptSubmit", ev);
    }

    fn end_turn(&self) {
        let mut ev = self.with_mode("Stop");
        ev["stop_hook_active"] = json!(false);
        self.hook("Stop", ev);
        self.statusline();
    }

    fn pre_tool(&self, tool: &str, input: &Value, tool_use_id: &str) {
        let mut ev = self.with_mode("PreToolUse");
        ev["tool_name"] = json!(tool);
        ev["tool_input"] = input.clone();
        ev["tool_use_id"] = json!(tool_use_id);
        self.hook("PreToolUse", ev);
    }

    fn post_tool(&self, tool: &str, input: &Value, tool_use_id: &str) {
        let mut ev = self.with_mode("PostToolUse");
        ev["tool_name"] = json!(tool);
        ev["tool_input"] = input.clone();
        ev["tool_use_id"] = json!(tool_use_id);
        ev["tool_response"] = json!({"stdout": "", "stderr": "", "interrupted": false});
        self.hook("PostToolUse", ev);
    }

    /// `PermissionRequest` bloquant et dialogue de la TUI, en concurrence.
    /// `auto` : la TUI accepte d'elle-même au bout de ce délai.
    fn ask_permission(
        &self,
        keys: &mut Keys,
        tool: &str,
        input: &Value,
        suggestions: Value,
        yes: char,
        auto: Option<Duration>,
    ) -> Answer {
        let mut ev = self.with_mode("PermissionRequest");
        ev["tool_name"] = json!(tool);
        ev["tool_input"] = input.clone();
        ev["permission_suggestions"] = suggestions;
        let relay = self.spawn_hook("PermissionRequest", ev);
        let start = Instant::now();
        loop {
            if let Ok(r) = relay.try_recv() {
                let text = String::from_utf8_lossy(&r.stdout);
                if let Ok(v) = serde_json::from_str::<Value>(text.trim()) {
                    return Answer::App(v);
                }
                // Sans décision : la TUI garde la main.
                out("  (relais rendu sans décision)\r\n");
            }
            if auto.is_some_and(|d| start.elapsed() >= d) {
                return Answer::Tui(true);
            }
            match keys.next(Duration::from_millis(10)) {
                Some(Key::Char(c)) if c == yes => return Answer::Tui(true),
                Some(Key::Char('n')) => return Answer::Tui(false),
                _ => {}
            }
        }
    }

    /// Tour ordinaire : une permission Bash, acceptée par la TUI si l'app ne
    /// répond pas avant [`AUTO_ANSWER`].
    fn turn(&self, keys: &mut Keys, prompt: &str) {
        self.prompt_submit(prompt);
        out(&format!("\x1b[1m●\x1b[0m Réponse à : {prompt}\r\n"));
        let n = TOOL_SEQ.fetch_add(1, Ordering::SeqCst);
        let tool_use_id = format!("toolu_faux_{n}");
        let input =
            json!({"command": format!("touch /tmp/faux-{n}"), "description": "Fichier vide"});
        self.pre_tool("Bash", &input, &tool_use_id);
        match self.ask_permission(keys, "Bash", &input, json!([]), 'o', Some(AUTO_ANSWER)) {
            Answer::Tui(true) => {
                out("  Bash(touch) autorisé\r\n");
                self.post_tool("Bash", &input, &tool_use_id);
            }
            Answer::App(v) if v["hookSpecificOutput"]["decision"]["behavior"] == "allow" => {
                out("  Bash(touch) autorisé par l'app\r\n");
                self.post_tool("Bash", &input, &tool_use_id);
            }
            _ => out("  Bash(touch) refusé\r\n"),
        }
        self.end_turn();
    }

    /// `/perm <outil> [nosug]`.
    fn perm(&self, keys: &mut Keys, line: &str) {
        let mut words = line.split_whitespace().skip(1);
        let tool = words.next().unwrap_or("Bash").to_owned();
        let option = words.next();
        let with_suggestions = option != Some("nosug");
        let forge = option == Some("forge");
        self.prompt_submit(line);
        let n = TOOL_SEQ.fetch_add(1, Ordering::SeqCst);
        let tool_use_id = format!("toolu_perm_{n}");
        let (input, rule) = if tool == "Bash" {
            let cmd = format!("rm -rf build-{n}");
            (
                json!({"command": cmd, "description": "Supprime le dossier"}),
                json!({"toolName": "Bash", "ruleContent": cmd}),
            )
        } else {
            (
                json!({"file_path": format!("/tmp/faux-{n}.txt")}),
                json!({"toolName": tool}),
            )
        };
        let suggestions = if with_suggestions {
            json!([
                {"type": "addRules", "rules": [rule], "behavior": "allow",
                 "destination": "localSettings"},
                {"type": "setMode", "mode": "acceptEdits", "destination": "session"}
            ])
        } else {
            json!([])
        };
        self.pre_tool(&tool, &input, &tool_use_id);
        out(&format!(
            "╭ Do you want to proceed? {tool} ─ [o] oui · [n] non ╮\r\n"
        ));
        if forge {
            // La seconde trame part après la première (le relais de la vraie
            // demande est lancé par `ask_permission`, juste après).
            let input = input.clone();
            let tool = tool.clone();
            let fake_hooks = self.hooks.clone();
            let me = Fake {
                args: Args::default(),
                session_id: self.session_id.clone(),
                cwd: self.cwd.clone(),
                hooks: fake_hooks,
                plugin_root: self.plugin_root.clone(),
                mode: RefCell::new(self.hook_mode()),
                footer: RefCell::new(false),
                footer_on_screen: RefCell::new(false),
            };
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(200));
                let rx = me.forge(&tool, &input);
                let _ = rx.recv();
            });
        }
        match self.ask_permission(keys, &tool, &input, suggestions, 'o', None) {
            Answer::Tui(true) => {
                out(&format!("  {tool} autorisé dans le terminal\r\n"));
                self.post_tool(&tool, &input, &tool_use_id);
            }
            Answer::Tui(false) => out(&format!("  {tool} refusé dans le terminal\r\n")),
            Answer::App(v) => {
                let d = &v["hookSpecificOutput"]["decision"];
                if d["behavior"] == "allow" {
                    let rules = d["updatedPermissions"].as_array().map_or(0, Vec::len);
                    out(&format!(
                        "  {tool} autorisé par l'app (règles ajoutées : {rules})\r\n"
                    ));
                    if rules > 0 {
                        out(&format!("  règles : {}\r\n", d["updatedPermissions"]));
                    }
                    self.post_tool(&tool, &input, &tool_use_id);
                } else {
                    out(&format!(
                        "  {tool} refusé par l'app : {}\r\n",
                        d["message"].as_str().unwrap_or("(sans message)")
                    ));
                }
            }
        }
        self.end_turn();
    }

    /// `/ask` : `AskUserQuestion` avec deux questions.
    fn ask(&self, keys: &mut Keys, line: &str) {
        self.prompt_submit(line);
        let n = TOOL_SEQ.fetch_add(1, Ordering::SeqCst);
        let tool_use_id = format!("toolu_ask_{n}");
        let input = json!({"questions": [
            {"question": "Tu préfères A ou B ?", "header": "Choix", "multiSelect": false,
             "options": [{"label": "A", "description": "La première"},
                         {"label": "B", "description": "La seconde"}]},
            {"question": "Quelles couleurs ?", "header": "Couleurs", "multiSelect": true,
             "options": [{"label": "Rouge", "description": "chaud"},
                         {"label": "Vert", "description": "froid"}]}
        ]});
        self.pre_tool("AskUserQuestion", &input, &tool_use_id);
        out("╭ Tu préfères A ou B ? · Quelles couleurs ? ─ [1] premiers choix ╮\r\n");
        let answered =
            match self.ask_permission(keys, "AskUserQuestion", &input, json!([]), '1', None) {
                Answer::App(v) => {
                    let d = &v["hookSpecificOutput"]["decision"];
                    let answers = &d["updatedInput"]["answers"];
                    if d["behavior"] == "allow" && answers.is_object() {
                        out(&format!("  Réponses (app) : {answers}\r\n"));
                        Some(d["updatedInput"].clone())
                    } else {
                        out("  Question refusée par l'app\r\n");
                        None
                    }
                }
                Answer::Tui(true) => {
                    let mut with = input.clone();
                    with["answers"] =
                        json!({"Tu préfères A ou B ?": "A", "Quelles couleurs ?": "Rouge"});
                    out(&format!("  Réponses (terminal) : {}\r\n", with["answers"]));
                    Some(with)
                }
                Answer::Tui(false) => {
                    out("  Question refusée dans le terminal\r\n");
                    None
                }
            };
        if let Some(input) = answered {
            self.post_tool("AskUserQuestion", &input, &tool_use_id);
        }
        self.end_turn();
    }

    /// Sondes du socket de contrôle (voir la documentation du module).
    fn probe(&self, kind: &str) {
        let Some(relay) = std::env::var_os("ORCH_SOCKET") else {
            out("pas de ORCH_SOCKET\r\n");
            return;
        };
        let control = Path::new(&relay).with_file_name("orchd.sock");
        let exe = std::env::current_exe().unwrap();
        let probe = |label: &str| {
            format!(
                "'{}' --probe-control '{}' {label} >/dev/null 2>&1",
                exe.display(),
                control.display()
            )
        };
        // Environnement nettoyé des variables de la session.
        let clean = "env -u ORCH_TOKEN -u ORCH_SESSION -u ORCH_SOCKET";
        let script = match kind.split_whitespace().collect::<Vec<_>>().as_slice() {
            ["enfant"] => {
                let o = Command::new(exe)
                    .args([
                        "--probe-control".as_ref(),
                        control.as_os_str(),
                        "enfant".as_ref(),
                    ])
                    .stdin(Stdio::null())
                    .output();
                let verdict = o
                    .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_owned())
                    .unwrap_or_default();
                out(&format!("contrôle : {verdict}\r\n"));
                return;
            }
            // Petit-enfant rattaché à init (ou au sous-moissonneur).
            ["detache"] => format!("{} &", probe("detache")),
            // Nouvelle session (`setsid -f`), environnement nettoyé : seul le
            // cgroup du scope le trahit.
            ["setsid"] => format!("{clean} setsid -f {}", probe("setsid")),
            // Nouvelle session, environnement gardé.
            ["setsid-env"] => format!("setsid -f {}", probe("setsid-env")),
            // Même session, environnement nettoyé, plus tard.
            ["later", secs] => format!("(sleep {secs}; {clean} {}) &", probe("later")),
            _ => {
                out("sonde inconnue\r\n");
                return;
            }
        };
        let _ = Command::new("sh")
            .arg("-c")
            .arg(script)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        out(&format!("sonde {kind} lancée\r\n"));
    }

    /// `/perm Bash forge` : après la vraie demande, une seconde trame
    /// `PermissionRequest` pour le même appel, avec une suggestion trop large
    /// (processus de la session qui tente d'empoisonner « Toujours »).
    fn forge(&self, tool: &str, input: &Value) -> mpsc::Receiver<HookResult> {
        let mut ev = self.with_mode("PermissionRequest");
        ev["tool_name"] = json!(tool);
        ev["tool_input"] = input.clone();
        ev["permission_suggestions"] = json!([
            {"type": "addRules", "rules": [{"toolName": tool}], "behavior": "allow",
             "destination": "localSettings"}
        ]);
        self.spawn_hook("PermissionRequest", ev)
    }
}

/// Mode `--probe-control <socket> <étiquette>` : se connecte au socket de
/// contrôle, envoie `hello` et écrit « accepté » ou « refusé ».
fn probe_control(socket: &str, label: &str) -> ! {
    use std::os::unix::net::UnixStream;
    let accepted = (|| -> Option<bool> {
        let mut s = UnixStream::connect(socket).ok()?;
        s.set_read_timeout(Some(Duration::from_secs(3))).ok()?;
        let body = br#"{"jsonrpc":"2.0","id":1,"method":"hello","params":{}}"#;
        let mut frame = ((body.len() + 1) as u32).to_be_bytes().to_vec();
        frame.push(0x01);
        frame.extend_from_slice(body);
        if s.write_all(&frame).is_err() {
            return Some(false);
        }
        let mut len = [0u8; 4];
        Some(s.read_exact(&mut len).is_ok())
    })()
    .unwrap_or(false);
    let verdict = if accepted { "accepté" } else { "refusé" };
    log_line(json!({"probe": label, "verdict": verdict}));
    println!("{verdict}");
    std::process::exit(0);
}

fn winsize() -> Option<(u16, u16)> {
    let mut ws = nix::pty::Winsize {
        ws_row: 0,
        ws_col: 0,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    // SAFETY: TIOCGWINSZ remplit une struct winsize valide, passée par pointeur.
    unsafe { get_winsize(0, &mut ws) }.ok()?;
    Some((ws.ws_col, ws.ws_row))
}

fn main() {
    let raw: Vec<String> = std::env::args().skip(1).collect();
    if raw.first().map(String::as_str) == Some("--probe-control") {
        probe_control(
            raw.get(1).map_or("", String::as_str),
            raw.get(2).map_or("", String::as_str),
        );
    }
    let args = match parse_args(&raw) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("faux claude : {e}");
            std::process::exit(1);
        }
    };
    log_line(json!({
        "args": raw,
        "pid": std::process::id(),
        "CLAUDE_CONFIG_DIR": std::env::var("CLAUDE_CONFIG_DIR").ok(),
        "ORCH_SESSION": std::env::var("ORCH_SESSION").ok(),
        "ORCH_SOCKET": std::env::var("ORCH_SOCKET").ok(),
        "ORCH_TOKEN": std::env::var("ORCH_TOKEN").ok(),
        "ORCH_TOKEN_present": std::env::var_os("ORCH_TOKEN").is_some(),
        "env_keys": std::env::vars_os()
            .filter_map(|(k, _)| k.into_string().ok())
            .filter(|k| {
                k.starts_with("ORCH_")
                    || k.starts_with("DEVMAESTRO_")
                    || k.starts_with("CLAUDE")
                    || k == "AI_AGENT"
                    || k == "TRACEPARENT"
            })
            .collect::<Vec<_>>(),
        "TERM": std::env::var("TERM").ok(),
        "COLORTERM": std::env::var("COLORTERM").ok(),
        "cwd": std::env::current_dir().ok(),
    }));

    let plugin_root = args
        .plugin_dir
        .as_ref()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    let hooks = args
        .plugin_dir
        .as_ref()
        .and_then(|d| std::fs::read_to_string(d.join("hooks/hooks.json")).ok())
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or(Value::Null);
    let resumed = args.resume.is_some();
    let session_id = args
        .resume
        .clone()
        .or_else(|| args.session_id.clone())
        .unwrap_or_else(|| "00000000-0000-4000-8000-000000000000".into());
    let mode = match args.mode.as_deref() {
        None | Some("manual") => "default".to_owned(),
        Some(m) => m.to_owned(),
    };
    let fake = Fake {
        cwd: std::env::current_dir()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default(),
        session_id,
        hooks,
        plugin_root,
        args,
        mode: RefCell::new(mode),
        footer: RefCell::new(true),
        footer_on_screen: RefCell::new(false),
    };
    *fake.footer_on_screen.borrow_mut() = fake.args.mode.is_some();

    // Clavier en mode brut, comme une TUI.
    if let Ok(mut t) = nix::sys::termios::tcgetattr(std::io::stdin()) {
        nix::sys::termios::cfmakeraw(&mut t);
        let _ =
            nix::sys::termios::tcsetattr(std::io::stdin(), nix::sys::termios::SetArg::TCSANOW, &t);
    }
    // SAFETY: le gestionnaire ne fait qu'écrire un booléen atomique.
    unsafe {
        let _ = nix::sys::signal::signal(
            nix::sys::signal::Signal::SIGWINCH,
            nix::sys::signal::SigHandler::Handler(on_winch),
        );
    }

    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut stdin = std::io::stdin();
        let mut buf = [0u8; 4096];
        loop {
            match stdin.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if tx.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }
    });
    let mut keys = Keys {
        rx,
        queue: VecDeque::new(),
        esc: 0,
    };

    out("\x1b[2J\x1b[H\x1b[?2004h");
    out("\x1b[1;35m╭─ Faux Claude Code ─╮\x1b[0m\r\n");
    out(&format!(
        "session : {} ({})\r\n",
        fake.session_id,
        if resumed { "reprise" } else { "nouvelle" }
    ));
    out(&format!(
        "mode : {} · modèle : {}\r\n",
        fake.args.mode.as_deref().unwrap_or("?"),
        fake.args.model.as_deref().unwrap_or("par défaut")
    ));
    out(&format!(
        "CLAUDE_CONFIG_DIR : {}\r\n",
        std::env::var("CLAUDE_CONFIG_DIR").unwrap_or_else(|_| "(absent)".into())
    ));
    if let Some((c, r)) = winsize() {
        out(&format!("taille : {c}x{r}\r\n"));
    }

    let mut ev = fake.base("SessionStart");
    ev["source"] = json!(if resumed { "resume" } else { "startup" });
    ev["model"] = json!(fake.args.model.clone().unwrap_or("claude-opus-5-5".into()));
    fake.hook("SessionStart", ev);
    fake.statusline();
    if let Some(p) = fake.args.prompt.clone() {
        fake.turn(&mut keys, &p);
    }
    out(&fake.prompt_line(""));

    let mut line = String::new();
    loop {
        if WINCH.swap(false, Ordering::SeqCst)
            && let Some((c, r)) = winsize()
        {
            out(&format!(
                "\r\ntaille : {c}x{r}\r\n{}",
                fake.prompt_line(&line)
            ));
        }
        let Some(key) = keys.next(Duration::from_millis(20)) else {
            continue;
        };
        match key {
            Key::Enter => {
                out("\r\n");
                let text = std::mem::take(&mut line);
                let text = text.trim();
                match text {
                    "/tetu" => {
                        // Ignore SIGHUP : seul SIGKILL l'arrête.
                        // SAFETY: changement de disposition d'un signal, sans gestionnaire.
                        unsafe {
                            let _ = nix::sys::signal::signal(
                                nix::sys::signal::Signal::SIGHUP,
                                nix::sys::signal::SigHandler::SigIgn,
                            );
                        }
                        out("SIGHUP ignoré.\r\n");
                    }
                    "/crash" => {
                        // Sortie en erreur, sans SessionEnd.
                        out("Plantage simulé.\r\n");
                        std::process::exit(3);
                    }
                    "/exit" => {
                        let mut ev = fake.base("SessionEnd");
                        ev["reason"] = json!("prompt_input_exit");
                        fake.hook("SessionEnd", ev);
                        out("Au revoir.\r\n");
                        std::process::exit(0);
                    }
                    "/ctl" => fake.probe("enfant"),
                    "/ctl-detache" => fake.probe("detache"),
                    t if t.starts_with("/ctl-") => fake.probe(
                        &t["/ctl-".len()..]
                            .replace('-', " ")
                            .replace("setsid env", "setsid-env"),
                    ),
                    t if t.starts_with("/mode ") => {
                        *fake.mode.borrow_mut() = t["/mode ".len()..].trim().to_owned();
                        out(&format!("mode forcé : {}\r\n", fake.hook_mode()));
                    }
                    t if t.starts_with("/hook-perime-muet ") => {
                        // Le hook part 300 ms plus tard, sans rien écrire
                        // ensuite : seul le démon peut relire le pied.
                        let mode = t["/hook-perime-muet ".len()..].trim().to_owned();
                        let me = Fake {
                            args: Args::default(),
                            session_id: fake.session_id.clone(),
                            cwd: fake.cwd.clone(),
                            hooks: fake.hooks.clone(),
                            plugin_root: fake.plugin_root.clone(),
                            mode: RefCell::new(fake.hook_mode()),
                            footer: RefCell::new(false),
                            footer_on_screen: RefCell::new(false),
                        };
                        std::thread::spawn(move || {
                            std::thread::sleep(Duration::from_millis(300));
                            me.send_stale_hook(&mode);
                        });
                    }
                    t if t.starts_with("/hook-perime ") => {
                        fake.stale_hook(t["/hook-perime ".len()..].trim());
                    }
                    "/sans-pied" => {
                        *fake.footer.borrow_mut() = false;
                        out("pied retiré\r\n");
                    }
                    "/ask" => fake.ask(&mut keys, text),
                    t if t == "/perm" || t.starts_with("/perm ") => fake.perm(&mut keys, t),
                    "" => {}
                    t => fake.turn(&mut keys, t),
                }
                out(&fake.prompt_line(""));
            }
            Key::Backspace => {
                if line.pop().is_some() {
                    out("\x08 \x08");
                }
            }
            Key::ShiftTab => {
                fake.cycle_mode();
                *fake.footer_on_screen.borrow_mut() = true;
                if *fake.footer.borrow() {
                    out(&format!("\r\n{}", fake.prompt_line(&line)));
                } else {
                    out(&format!(
                        "\r\n(Shift+Tab : {})\r\n> {line}",
                        fake.hook_mode()
                    ));
                }
            }
            Key::Char(c) => {
                line.push(c);
                out(&c.to_string());
            }
        }
    }
}
