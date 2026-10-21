//! v0.3, lot 17 : `commands.list`, slash commands d'une session (intégrées,
//! utilisateur, projet, plugins activés), lues en lecture seule dans des
//! dossiers temporaires (jamais le vrai `~/.claude`).

mod common;

use std::os::unix::fs::symlink;
use std::path::{Path, PathBuf};

use common::*;
use serde_json::{Value, json};
use uuid::Uuid;

fn write(p: &Path, s: &str) {
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, s).unwrap();
}

fn find<'a>(list: &'a Value, name: &str) -> Option<&'a Value> {
    list["commands"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == name)
}

fn get<'a>(list: &'a Value, name: &str) -> &'a Value {
    find(list, name).unwrap_or_else(|| panic!("{name} absent : {list}"))
}

/// Arborescence (chemins relatifs triés, tailles, dates de modification) des sources lues
/// (`commands`, `skills`, `plugins`, réglages) : vérifie que rien n'y est
/// écrit (le faux `claude` écrit ailleurs dans le profil, `projects/`…).
fn tree(root: &Path) -> Vec<(PathBuf, u64, std::time::SystemTime)> {
    fn walk(base: &Path, dir: &Path, out: &mut Vec<(PathBuf, u64, std::time::SystemTime)>) {
        let Ok(rd) = std::fs::read_dir(dir) else {
            return;
        };
        for e in rd.flatten() {
            let p = e.path();
            let m = std::fs::symlink_metadata(&p).unwrap();
            out.push((
                p.strip_prefix(base).unwrap().to_path_buf(),
                m.len(),
                m.modified().unwrap(),
            ));
            if m.is_dir() {
                walk(base, &p, out);
            }
        }
    }
    let mut out = Vec::new();
    walk(root, root, &mut out);
    out.retain(|(p, _, _)| {
        [
            "commands",
            "skills",
            "plugins",
            "settings.json",
            "settings.local.json",
        ]
        .iter()
        .any(|s| p.starts_with(s))
    });
    out.sort();
    out
}

/// Prépare les trois sources dans le `HOME` et le projet du test.
fn populate(env: &Env) {
    let claude = env.home.join(".claude");
    // Utilisateur.
    write(
        &claude.join("commands/revue.md"),
        "---\ndescription: Relire le diff\nargument-hint: \"[fichier]\"\n---\nCorps\n",
    );
    write(
        &claude.join("commands/front/test.md"),
        "# Lancer les tests du front\n",
    );
    write(&claude.join("commands/notes.txt"), "pas une commande");
    write(&claude.join("commands/mauvais nom.md"), "x");
    write(&claude.join("commands/été.md"), "x");
    // Reprend l'alias `reset` de `/clear` : gardée à côté, marquée.
    write(
        &claude.join("commands/reset.md"),
        "Réinitialiser à ma façon\n",
    );
    write(&claude.join("commands/.cache/caché.md"), "x");
    write(
        &claude.join("commands/yaml.md"),
        "---\ndescription: Faire: ceci\n---\n",
    );
    write(
        &claude.join("skills/grille/SKILL.md"),
        "---\nname: grille\ndescription: Questionner une idée\n---\n",
    );
    write(
        &claude.join("skills/interne/SKILL.md"),
        "---\ndescription: x\nuser-invocable: false\n---\n",
    );
    // Lien hors de la racine : ignoré.
    let outside = env.home.join("ailleurs");
    write(
        &outside.join("secret.md"),
        "---\ndescription: secret\n---\n",
    );
    symlink(outside.join("secret.md"), claude.join("commands/secret.md")).unwrap();
    // Projet : même nom qu'une commande utilisateur (le projet l'emporte).
    write(
        &env.proj.join(".claude/commands/revue.md"),
        "---\ndescription: Revue du projet\n---\n",
    );
    write(
        &env.proj.join(".claude/commands/deployer.md"),
        "Déployer en préproduction\n",
    );
    // Un dépôt qui imite une intégrée et une commande de plugin.
    write(
        &env.proj.join(".claude/commands/compact.md"),
        "---\ndescription: Compacter (version du dépôt)\n---\n",
    );
    write(
        &env.proj.join(".claude/commands/forge/plan.md"),
        "Plan du dépôt\n",
    );
    // Plugins : un activé (commande et skill), un désactivé par le projet,
    // un installé hors de `plugins/`.
    let cache = claude.join("plugins/cache/m");
    write(
        &cache.join("forge/1.0.0/.claude-plugin/plugin.json"),
        r#"{"name": "forge"}"#,
    );
    write(
        &cache.join("forge/1.0.0/commands/plan.md"),
        "---\ndescription: Planifier\n---\n",
    );
    write(
        &cache.join("forge/1.0.0/skills/grill/SKILL.md"),
        "---\ndescription: Griller\n---\n",
    );
    write(&cache.join("off/1/commands/non.md"), "x");
    write(&outside.join("evade/commands/evade.md"), "x");
    write(
        &claude.join("plugins/installed_plugins.json"),
        &json!({"version": 2, "plugins": {
            "forge@m": [{"scope": "user", "installPath": cache.join("forge/1.0.0")}],
            "off@m": [{"scope": "user", "installPath": cache.join("off/1")}],
            "evade@m": [{"scope": "user", "installPath": outside.join("evade")}]
        }})
        .to_string(),
    );
    write(
        &claude.join("settings.json"),
        r#"{"enabledPlugins": {"forge@m": true, "off@m": true, "evade@m": true}}"#,
    );
    write(
        &env.proj.join(".claude/settings.local.json"),
        r#"{"enabledPlugins": {"off@m": false}}"#,
    );
}

#[test]
fn commands_of_a_session() {
    let env = Env::new();
    populate(&env);
    let before = tree(&env.home.join(".claude"));
    let before_proj = tree(&env.proj.join(".claude"));

    let _daemon = env.start_daemon();
    let mut c = Client::connect(&env);
    let hello = c.call("hello", json!({}));
    assert_eq!(hello["capabilities"]["slash_commands"], true);
    let id = launch_idle(&mut c, &env, json!({}));

    let l = c.call("commands.list", json!({"id": id}));
    assert_eq!(l["truncated"], false);
    assert!(
        l["claude_code_version"]
            .as_str()
            .is_some_and(|v| !v.is_empty())
    );

    // Intégrées.
    let model = get(&l, "model");
    assert_eq!(model["source"], "builtin");
    assert_eq!(model["interactive"], true);
    assert!(model["description"].is_string());
    assert!(get(&l, "compact").get("interactive").is_none());
    assert_eq!(get(&l, "clear")["aliases"], json!(["reset", "new"]));

    // Utilisateur.
    let revue_front = get(&l, "front:test");
    assert_eq!(revue_front["source"], "user");
    assert_eq!(revue_front["kind"], "command");
    assert_eq!(revue_front["description"], "Lancer les tests du front");
    assert_eq!(get(&l, "yaml")["description"], "Faire: ceci");
    let grille = get(&l, "grille");
    assert_eq!(
        (grille["source"].as_str(), grille["kind"].as_str()),
        (Some("user"), Some("skill"))
    );
    assert!(find(&l, "interne").is_none());
    assert!(find(&l, "notes").is_none());
    assert!(find(&l, "secret").is_none(), "lien hors de la racine suivi");
    assert!(find(&l, "mauvais nom").is_none());
    assert!(find(&l, "caché").is_none());
    // `mauvais nom.md` et `été.md` : comptés comme ignorés (le dossier caché, non).
    assert_eq!(l["ignored"], 2);

    // Les intégrées ne sont jamais masquées : l'imitation est gardée à côté, marquée.
    let all = |name: &str| -> Vec<Value> {
        l["commands"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|c| c["name"] == name)
            .cloned()
            .collect()
    };
    let compact = all("compact");
    assert_eq!(compact.len(), 2, "{compact:?}");
    assert_eq!(compact[0]["source"], "builtin");
    assert!(compact[0].get("conflict").is_none());
    assert_eq!(compact[1]["source"], "project");
    assert_eq!(compact[1]["conflict"], "builtin");
    let reset = all("reset");
    assert_eq!((reset.len(), &reset[0]["conflict"]), (1, &json!("builtin")));
    let plan = all("forge:plan");
    assert_eq!(plan.len(), 2, "{plan:?}");
    assert_eq!(
        (plan[0]["source"].as_str(), plan[0]["conflict"].as_str()),
        (Some("project"), Some("plugin"))
    );
    assert_eq!(plan[1]["source"], "plugin");
    assert!(plan[1].get("conflict").is_none());

    // Projet, prioritaire sur l'utilisateur pour un même nom.
    let revue = get(&l, "revue");
    assert_eq!(revue["source"], "project");
    assert_eq!(revue["description"], "Revue du projet");
    assert!(revue.get("argument_hint").is_none());
    assert_eq!(get(&l, "deployer")["source"], "project");

    // Plugins.
    let plugin_plan = all("forge:plan").pop().unwrap();
    assert_eq!(plugin_plan["source"], "plugin");
    assert_eq!(plugin_plan["plugin"], "forge");
    assert_eq!(get(&l, "forge:grill")["kind"], "skill");
    assert!(find(&l, "off:non").is_none(), "désactivé par le projet");
    assert!(
        find(&l, "evade:evade").is_none(),
        "installé hors de plugins/"
    );

    // Ordre : intégrées, projet, utilisateur, plugins.
    let sources: Vec<&str> = l["commands"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["source"].as_str().unwrap())
        .collect();
    let rank = |s: &str| {
        ["builtin", "project", "user", "plugin"]
            .iter()
            .position(|x| *x == s)
            .unwrap()
    };
    assert!(
        sources.windows(2).all(|w| rank(w[0]) <= rank(w[1])),
        "{sources:?}"
    );

    // Lecture seule.
    assert_eq!(tree(&env.home.join(".claude")), before);
    assert_eq!(tree(&env.proj.join(".claude")), before_proj);

    // Session inconnue.
    assert_eq!(
        c.call_err("commands.list", json!({"id": Uuid::new_v4()})),
        -32001
    );
    assert_eq!(c.call_err("commands.list", json!({})), -32602);
}

#[test]
fn linked_profile_and_stopped_session() {
    let env = Env::new();
    populate(&env);
    // Profil « work » qui partage les plugins et réglages du profil par
    // défaut par des liens, comme chez l'utilisateur ; l'installation est
    // inscrite par le chemin du profil « work ».
    let work = env.home.join(".claude-work");
    std::fs::remove_file(work.join("settings.json")).unwrap();
    symlink(
        env.home.join(".claude/settings.json"),
        work.join("settings.json"),
    )
    .unwrap();
    symlink(env.home.join(".claude/plugins"), work.join("plugins")).unwrap();
    write(
        &env.home.join(".claude/plugins/installed_plugins.json"),
        &json!({"version": 2, "plugins": {
            "forge@m": [{"scope": "user", "installPath": work.join("plugins/cache/m/forge/1.0.0")}]
        }})
        .to_string(),
    );
    write(
        &work.join("commands/propre.md"),
        "Commande du profil work\n",
    );

    let _daemon = env.start_daemon();
    let mut c = Client::connect(&env);
    c.call("hello", json!({}));
    let id = launch_idle(&mut c, &env, json!({"profile": "work"}));
    let l = c.call("commands.list", json!({"id": id}));
    assert_eq!(get(&l, "propre")["source"], "user");
    assert!(
        find(&l, "front:test").is_none(),
        "commandes de l'autre profil"
    );
    assert!(
        l["commands"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["name"] == "forge:plan" && c["source"] == "plugin"),
        "plugin lu par le chemin du profil lié"
    );

    // Session arrêtée : la liste reste lisible.
    c.call("sessions.stop", json!({"id": id}));
    c.wait_until("session arrêtée", |c| {
        c.last_session(id).is_some_and(|s| s["alive"] == false)
    });
    let l = c.call("commands.list", json!({"id": id}));
    assert_eq!(get(&l, "propre")["source"], "user");
    // Dossier du projet disparu : les autres sources restent.
    std::fs::remove_dir_all(&env.proj).unwrap();
    let l = c.call("commands.list", json!({"id": id}));
    assert!(find(&l, "deployer").is_none());
    assert_eq!(get(&l, "propre")["source"], "user");
    assert_eq!(get(&l, "model")["source"], "builtin");
}

#[test]
fn project_root_linked_outside_is_refused() {
    let env = Env::new();
    // `.claude/commands` du projet lié hors du projet (dépôt non fiable) :
    // rien n'y est lu ; le reste du projet, si.
    let outside = env.home.join("prive");
    write(
        &outside.join("secret.md"),
        "---\ndescription: secret\n---\n",
    );
    write(
        &env.proj.join(".claude/skills/local/SKILL.md"),
        "---\ndescription: Skill du projet\n---\n",
    );
    symlink(&outside, env.proj.join(".claude/commands")).unwrap();
    // Indication d'arguments en liste YAML non quotée, forme courante.
    write(
        &env.home.join(".claude/commands/commit.md"),
        "---\nargument-hint: [message]\ndescription: Committer\n---\n",
    );

    let _daemon = env.start_daemon();
    let mut c = Client::connect(&env);
    c.call("hello", json!({}));
    let id = launch_idle(&mut c, &env, json!({}));
    let l = c.call("commands.list", json!({"id": id}));
    assert!(find(&l, "secret").is_none(), "lu hors du projet : {l}");
    assert_eq!(get(&l, "local")["source"], "project");
    assert_eq!(get(&l, "commit")["argument_hint"], "[message]");
}
