//! `orchd`, le démon de DevMaestro.
//!
//! Lot 1 : seulement `--version` et `--help`. Le démon et les relais
//! (`orchd hook <événement>`, `orchd statusline`) arrivent au lot 2.

use std::process::ExitCode;

const VERSION: &str = env!("CARGO_PKG_VERSION");

const HELP: &str = "\
orchd : démon de DevMaestro, qui porte les sessions Claude Code.

Utilisation :
  orchd [OPTION]

Options :
  -h, --help       Affiche cette aide et quitte
  -V, --version    Affiche la version et quitte

Le démon, et les relais « orchd hook <événement> » et « orchd statusline »,
ne sont pas encore disponibles.
";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    match args.as_slice() {
        ["-V" | "--version"] => {
            println!("orchd {VERSION}");
            ExitCode::SUCCESS
        }
        ["-h" | "--help"] => {
            print!("{HELP}");
            ExitCode::SUCCESS
        }
        [] => {
            eprintln!("orchd : le démon n'est pas encore disponible (lot 2).");
            eprintln!("Essayez « orchd --help ».");
            ExitCode::from(2)
        }
        [other, ..] => {
            eprintln!("orchd : argument inconnu « {other} ».");
            eprintln!("Essayez « orchd --help ».");
            ExitCode::from(2)
        }
    }
}
