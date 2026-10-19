fn main() {
    // Empreinte du front embarqué, pour vérifier que deux rapports ont le même `dist/`.
    let dist = std::path::Path::new("../dist");
    println!("cargo:rerun-if-changed=../dist");
    println!(
        "cargo:rustc-env=BENCH_DIST_HASH={}",
        bench_core::engine::dist_hash(dist)
    );
    tauri_build::build()
}
