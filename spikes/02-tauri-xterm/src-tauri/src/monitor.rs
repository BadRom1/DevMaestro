//! Option `--monitor <connecteur>` : plein écran de la fenêtre sur cette sortie
//! (`gtk_window_fullscreen_on_monitor`, que GTK 3 traduit sous Wayland en
//! `xdg_toplevel.set_fullscreen(wl_output)`, respecté par Mutter).

use gtk::gdk;
use gtk::glib::translate::{from_glib_full, ToGlibPtr};
use gtk::prelude::*;

/// Nom de connecteur d'un moniteur GDK (« plug name » : xdg-output sous Wayland, RandR sous X11).
fn plug_name(screen: &gdk::Screen, i: i32) -> Option<String> {
    // Fonction dépréciée de GTK 3, sans équivalent non déprécié : seule source du connecteur.
    unsafe {
        let p = gdk::ffi::gdk_screen_get_monitor_plug_name(screen.to_glib_none().0, i);
        from_glib_full::<_, Option<String>>(p)
    }
}

fn describe(m: &gdk::Monitor, name: &str) -> String {
    let g = m.geometry();
    format!(
        "{name} ({} {}), {}×{} logique à ({}, {}), échelle GDK {}, {:.0} Hz",
        m.manufacturer().unwrap_or_default(),
        m.model().unwrap_or_default(),
        g.width(),
        g.height(),
        g.x(),
        g.y(),
        m.scale_factor(),
        m.refresh_rate() as f64 / 1000.0
    )
}

/// Demande le plein écran sur `connector` ; renvoie ce qui a été fait (pour le rapport).
pub fn fullscreen_on(window: &tauri::WebviewWindow, connector: &str) -> String {
    let Ok(gw) = window.gtk_window() else {
        return "fenêtre GTK inaccessible : écran non ciblé".into();
    };
    let (Some(screen), Some(display)) = (WidgetExt::screen(&gw), gdk::Display::default()) else {
        return "écran GDK inaccessible : écran non ciblé".into();
    };
    let monitors: Vec<(i32, gdk::Monitor)> = (0..display.n_monitors())
        .filter_map(|i| display.monitor(i).map(|m| (i, m)))
        .collect();
    // 1. Par connecteur ; 2. par position logique selon Mutter (même repère que GDK sous Wayland).
    let by_plug = monitors
        .iter()
        .find(|(i, _)| plug_name(&screen, *i).as_deref() == Some(connector));
    let mutter = bench_core::display::mutter_output(connector);
    let by_geometry = || {
        let o = mutter.as_ref()?;
        monitors.iter().find(|(_, m)| {
            let g = m.geometry();
            (g.x(), g.y()) == (o.x, o.y)
        })
    };
    let (how, found) = match by_plug {
        Some(f) => ("connecteur", Some(f)),
        None => ("position logique (Mutter)", by_geometry()),
    };
    let Some((i, m)) = found else {
        let seen: Vec<String> = monitors
            .iter()
            .map(|(i, m)| describe(m, &plug_name(&screen, *i).unwrap_or_else(|| "?".into())))
            .collect();
        return format!(
            "{connector} introuvable parmi : {} — fenêtre laissée où le compositeur l'a mise",
            seen.join(" ; ")
        );
    };
    gw.fullscreen_on_monitor(&screen, *i);
    format!(
        "plein écran demandé sur {} (trouvé par {how})",
        describe(m, connector)
    )
}

/// `--list-monitors` : liste les moniteurs GDK (connecteur, géométrie), sans ouvrir de fenêtre.
pub fn list() {
    if gtk::init().is_err() {
        eprintln!("GTK indisponible");
        return;
    }
    let (Some(display), Some(screen)) = (gdk::Display::default(), gdk::Screen::default()) else {
        return;
    };
    for i in 0..display.n_monitors() {
        if let Some(m) = display.monitor(i) {
            let name = plug_name(&screen, i).unwrap_or_else(|| "?".into());
            println!("{i} : {}", describe(&m, &name));
        }
    }
}

/// Moniteur où se trouve réellement la fenêtre (à appeler une fois le plein écran appliqué).
pub fn current(window: &tauri::WebviewWindow) -> String {
    let Ok(gw) = window.gtk_window() else {
        return "?".into();
    };
    let (Some(gdk_window), Some(display), Some(screen)) = (
        WidgetExt::window(&gw),
        gdk::Display::default(),
        WidgetExt::screen(&gw),
    ) else {
        return "?".into();
    };
    let Some(m) = display.monitor_at_window(&gdk_window) else {
        return "?".into();
    };
    let name = (0..display.n_monitors())
        .find(|&i| display.monitor(i).as_ref() == Some(&m))
        .and_then(|i| plug_name(&screen, i))
        .unwrap_or_else(|| "?".into());
    let fullscreen = gdk_window.state().contains(gdk::WindowState::FULLSCREEN);
    format!("{}, plein écran {fullscreen}", describe(&m, &name))
}
