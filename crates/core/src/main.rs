//! `orchd`, le démon de DevMaestro, et ses relais.
//!
//! - `orchd daemon` : le démon, au premier plan ;
//! - `orchd hook <événement>` et `orchd statusline` : relais lancés par
//!   Claude Code (jamais d'erreur visible, code de sortie toujours 0) ;
//! - `orchd ctl …` : petit client pour les vérifications à la main.

use std::path::PathBuf;
use std::process::ExitCode;

use clap::{
    Arg, ArgAction, Command as ClapCommand, CommandFactory, FromArgMatches, Parser, Subcommand,
};
use devmaestro_core::{ctl, daemon, paths::Paths, relay};

/// orchd : démon de DevMaestro, qui porte les sessions Claude Code.
#[derive(Debug, Parser)]
#[command(name = "orchd", version)]
struct Cli {
    #[command(subcommand)]
    command: Cmd,
}

#[derive(Debug, Subcommand)]
enum Cmd {
    /// Lance le démon au premier plan (journal sur la sortie d'erreur).
    Daemon,
    /// Relais d'un hook de Claude Code (lancé par le plugin généré).
    Hook {
        /// Nom de l'événement (SessionStart, Stop…).
        #[arg(value_name = "ÉVÉNEMENT")]
        event: Option<String>,
    },
    /// Relais de la statusline (lancé par les réglages générés).
    Statusline {
        /// Dossier de configuration du profil (sinon CLAUDE_CONFIG_DIR, sinon ~/.claude).
        #[arg(long, value_name = "DOSSIER")]
        config_dir: Option<PathBuf>,
    },
    /// Petit client du démon, pour les vérifications à la main.
    Ctl {
        /// Socket du démon (par défaut $XDG_RUNTIME_DIR/devmaestro/orchd.sock).
        #[arg(long, value_name = "CHEMIN")]
        socket: Option<PathBuf>,
        #[command(subcommand)]
        command: CtlCmd,
    },
}

#[derive(Debug, Subcommand)]
enum CtlCmd {
    /// Liste les sessions connues du démon.
    Sessions,
    /// Liste les profils Claude Code détectés.
    Profiles,
    /// Liste les anciennes sessions trouvées dans les transcripts d'un profil.
    Transcripts {
        /// Profil (par défaut : default).
        #[arg(long, value_name = "PROFIL")]
        profile: Option<String>,
        /// Nombre maximal de sessions.
        #[arg(long, default_value_t = 20, value_name = "N")]
        limit: usize,
    },
    /// Lance une nouvelle session.
    Launch {
        /// Dossier de travail.
        #[arg(long, value_name = "DOSSIER")]
        cwd: PathBuf,
        /// Profil (par défaut : default).
        #[arg(long, value_name = "PROFIL")]
        profile: Option<String>,
        /// Modèle (--model de claude).
        #[arg(long, value_name = "MODÈLE")]
        model: Option<String>,
        /// Mode de permission : default, acceptEdits, plan, auto…
        #[arg(long, value_name = "MODE")]
        mode: Option<String>,
        /// Prompt initial.
        #[arg(long, value_name = "TEXTE")]
        prompt: Option<String>,
        /// Largeur du terminal.
        #[arg(long, default_value_t = 120, value_name = "N")]
        cols: u16,
        /// Hauteur du terminal.
        #[arg(long, default_value_t = 40, value_name = "N")]
        rows: u16,
    },
    /// Reprend une session (par identifiant interne, ou par session_id de Claude Code).
    Resume {
        /// Identifiant interne (ou son début).
        #[arg(long, value_name = "ID")]
        id: Option<String>,
        /// session_id de Claude Code (ancienne session d'un transcript).
        #[arg(long, value_name = "ID")]
        claude_session_id: Option<String>,
        /// Profil.
        #[arg(long, value_name = "PROFIL")]
        profile: Option<String>,
        /// Dossier de travail (obligatoire pour une ancienne session).
        #[arg(long, value_name = "DOSSIER")]
        cwd: Option<PathBuf>,
        /// Mode de permission.
        #[arg(long, value_name = "MODE")]
        mode: Option<String>,
        /// Modèle.
        #[arg(long, value_name = "MODÈLE")]
        model: Option<String>,
    },
    /// Arrête une session (SIGHUP, puis SIGKILL au bout de 3 s).
    Stop {
        /// Identifiant (ou son début).
        #[arg(value_name = "ID")]
        id: String,
    },
    /// Affiche l'écran courant d'une session.
    Attach {
        /// Identifiant (ou son début).
        #[arg(value_name = "ID")]
        id: String,
        /// Texte seul, sans mise en forme.
        #[arg(long)]
        texte: bool,
    },
    /// Tape un texte dans une session.
    Input {
        /// Identifiant (ou son début).
        #[arg(value_name = "ID")]
        id: String,
        /// Texte à taper.
        #[arg(value_name = "TEXTE")]
        text: String,
        /// Ajoute Entrée à la fin.
        #[arg(long)]
        entree: bool,
    },
}

/// Aide en français : en-têtes, utilisation et options d'aide réécrits
/// (clap les produit en anglais).
fn frenchify(cmd: ClapCommand, path: &str, root: bool) -> ClapCommand {
    let has_sub = cmd.has_subcommands();
    let positionals: Vec<String> = cmd
        .get_positionals()
        .map(|a| {
            let name = a
                .get_value_names()
                .and_then(|n| n.first())
                .map(|n| n.to_string())
                .unwrap_or_else(|| a.get_id().to_string());
            if a.is_required_set() {
                format!(" <{name}>")
            } else {
                format!(" [{name}]")
            }
        })
        .collect();
    let mut usage = format!("{path} [options]");
    usage.extend(positionals.iter().cloned());
    if has_sub {
        usage.push_str(" <commande>");
    }
    let mut template = String::from("{about-with-newline}\nUtilisation : {usage}\n");
    if has_sub {
        template.push_str("\nCommandes :\n{subcommands}\n");
    }
    if !positionals.is_empty() {
        template.push_str("\nArguments :\n{positionals}\n");
    }
    template.push_str("\nOptions :\n{options}\n");

    let mut cmd = cmd
        .disable_help_flag(true)
        .disable_help_subcommand(true)
        .override_usage(usage)
        .help_template(template)
        .arg(
            Arg::new("aide")
                .short('h')
                .long("help")
                .action(ArgAction::Help)
                .help("Affiche cette aide et quitte"),
        );
    if root {
        cmd = cmd.disable_version_flag(true).arg(
            Arg::new("version")
                .short('V')
                .long("version")
                .action(ArgAction::Version)
                .help("Affiche la version et quitte"),
        );
    }
    let names: Vec<String> = cmd
        .get_subcommands()
        .map(|s| s.get_name().to_owned())
        .collect();
    for name in names {
        let sub_path = format!("{path} {name}");
        cmd = cmd.mut_subcommand(&name, |s| frenchify(s, &sub_path, false));
    }
    cmd
}

fn error_message(e: &clap::Error) -> String {
    use clap::error::ErrorKind as K;
    let what = match e.kind() {
        K::InvalidSubcommand => "commande inconnue",
        K::UnknownArgument => "argument inconnu",
        K::MissingRequiredArgument => "argument obligatoire manquant",
        K::MissingSubcommand | K::DisplayHelpOnMissingArgumentOrSubcommand => "commande manquante",
        K::InvalidValue | K::ValueValidation => "valeur invalide",
        K::TooManyValues | K::WrongNumberOfValues | K::TooFewValues => {
            "nombre de valeurs incorrect"
        }
        K::ArgumentConflict => "arguments incompatibles",
        _ => "arguments invalides",
    };
    let detail = e
        .get(clap::error::ContextKind::InvalidArg)
        .or_else(|| e.get(clap::error::ContextKind::InvalidSubcommand))
        .map(|v| format!(" : {v}"))
        .unwrap_or_default();
    format!("orchd : {what}{detail}.\nEssayez « orchd --help ».")
}

fn main() -> ExitCode {
    let args: Vec<std::ffi::OsString> = std::env::args_os().collect();
    // Relais : chemin rapide, sans analyse qui pourrait échouer bruyamment.
    match args.get(1).and_then(|a| a.to_str()) {
        // Code de sortie 0 par construction : même une panique est absorbée.
        Some("hook") => {
            std::panic::set_hook(Box::new(|_| {}));
            let event = args.get(2).and_then(|a| a.to_str()).map(str::to_owned);
            let _ = std::panic::catch_unwind(|| relay::hook::run(event.as_deref()));
            return ExitCode::SUCCESS;
        }
        Some("statusline") => {
            std::panic::set_hook(Box::new(|_| {}));
            let config_dir = match (args.get(2).and_then(|a| a.to_str()), args.get(3)) {
                (Some("--config-dir"), Some(dir)) => Some(PathBuf::from(dir)),
                _ => None,
            };
            let _ = std::panic::catch_unwind(|| relay::statusline::run(config_dir));
            return ExitCode::SUCCESS;
        }
        _ => {}
    }

    let command = frenchify(Cli::command(), "orchd", true);
    let matches = match command.try_get_matches_from(&args) {
        Ok(m) => m,
        Err(e) => {
            use clap::error::ErrorKind as K;
            return match e.kind() {
                K::DisplayHelp | K::DisplayVersion => {
                    let _ = e.print();
                    ExitCode::SUCCESS
                }
                _ => {
                    eprintln!("{}", error_message(&e));
                    ExitCode::from(2)
                }
            };
        }
    };
    let cli = match Cli::from_arg_matches(&matches) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("{}", error_message(&e));
            return ExitCode::from(2);
        }
    };

    let result = match cli.command {
        Cmd::Daemon => daemon::run_foreground(),
        // Déjà traités plus haut ; gardés pour l'aide.
        Cmd::Hook { event } => {
            relay::hook::run(event.as_deref());
            Ok(())
        }
        Cmd::Statusline { config_dir } => {
            relay::statusline::run(config_dir);
            Ok(())
        }
        Cmd::Ctl { socket, command } => {
            let socket = socket.unwrap_or_else(|| Paths::from_env().socket());
            ctl::run(&socket, ctl_command(command))
        }
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("orchd : {e}");
            ExitCode::FAILURE
        }
    }
}

fn ctl_command(c: CtlCmd) -> ctl::Command {
    match c {
        CtlCmd::Sessions => ctl::Command::Sessions,
        CtlCmd::Profiles => ctl::Command::Profiles,
        CtlCmd::Transcripts { profile, limit } => ctl::Command::Transcripts { profile, limit },
        CtlCmd::Launch {
            cwd,
            profile,
            model,
            mode,
            prompt,
            cols,
            rows,
        } => ctl::Command::Launch {
            cwd,
            profile,
            model,
            mode,
            prompt,
            cols,
            rows,
        },
        CtlCmd::Resume {
            id,
            claude_session_id,
            profile,
            cwd,
            mode,
            model,
        } => ctl::Command::Resume {
            id,
            claude_session_id,
            profile,
            cwd,
            mode,
            model,
        },
        CtlCmd::Stop { id } => ctl::Command::Stop { id },
        CtlCmd::Attach { id, texte } => ctl::Command::Attach { id, text: texte },
        CtlCmd::Input { id, text, entree } => ctl::Command::Input {
            id,
            text,
            enter: entree,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn help_is_french_and_consistent() {
        let cmd = frenchify(Cli::command(), "orchd", true);
        cmd.clone().debug_assert();
        let help = cmd.clone().render_help().to_string();
        assert!(
            help.contains("Utilisation : orchd [options] <commande>"),
            "{help}"
        );
        assert!(help.contains("Commandes :"));
        assert!(help.contains("Affiche cette aide"));
        assert!(!help.contains("Usage:"));
        assert!(!help.contains("Print help"));
        let mut cmd = cmd;
        let ctl = cmd.find_subcommand_mut("ctl").unwrap();
        let launch = ctl.find_subcommand_mut("launch").unwrap();
        let help = launch.render_help().to_string();
        assert!(
            help.contains("Utilisation : orchd ctl launch [options]"),
            "{help}"
        );
        assert!(help.contains("Dossier de travail"));
    }
}
