// The desktop app starts the altivola-db server (Node, bundled as a sidecar)
// on localhost and shows its web UI in the window. Running on the machine
// itself means databases behind a VPN are reachable without Docker.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Mutex;
use tauri::{AppHandle, Manager, RunEvent, Url};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_updater::UpdaterExt;

struct Server(Mutex<Option<CommandChild>>);

fn stop_server(app: &AppHandle) {
    if let Some(child) = app.state::<Server>().0.lock().unwrap().take() {
        let _ = child.kill();
    }
}

/// Asks to install a newer release from GitHub. Quietly does nothing when
/// offline or already up to date.
async fn check_for_update(app: AppHandle) {
    let Ok(updater) = app.updater() else { return };
    let Ok(Some(update)) = updater.check().await else { return };
    let text = format!(
        "altivola-db {} is out (you have {}). Install it and restart now?",
        update.version, update.current_version
    );
    let handle = app.clone();
    app.dialog()
        .message(text)
        .title("Update available")
        .buttons(MessageDialogButtons::OkCancelCustom("Install".into(), "Later".into()))
        .show(move |install| {
            if !install {
                return;
            }
            tauri::async_runtime::spawn(async move {
                match update.download_and_install(|_, _| {}, || {}).await {
                    Ok(()) => {
                        stop_server(&handle);
                        handle.restart();
                    }
                    Err(e) => {
                        handle
                            .dialog()
                            .message(format!("The update failed: {e}"))
                            .title("Update")
                            .show(|_| {});
                    }
                }
            });
        });
}

/// Apps started from Finder get a bare PATH. pg_dump, pg_restore and psql
/// (for dump and import) usually live in Homebrew, so look there too.
#[cfg(target_os = "macos")]
fn tool_path() -> String {
    let extra = [
        "/opt/homebrew/bin",
        "/opt/homebrew/opt/libpq/bin",
        "/usr/local/bin",
        "/usr/local/opt/libpq/bin",
        "/Applications/Postgres.app/Contents/Versions/latest/bin",
    ];
    let mut parts: Vec<String> = extra.iter().map(|s| s.to_string()).collect();
    if let Ok(path) = std::env::var("PATH") {
        parts.push(path);
    }
    parts.join(":")
}

/// Windows and Linux start apps with the user's full PATH, so keep it as it is.
#[cfg(not(target_os = "macos"))]
fn tool_path() -> String {
    std::env::var("PATH").unwrap_or_default()
}

/// The server prints "altivola-db <version> running at http://127.0.0.1:<port> (...)".
fn server_url(line: &str) -> Option<Url> {
    let start = line.find("http://")?;
    let url = line[start..].split_whitespace().next()?;
    Url::parse(url).ok()
}

fn show_error(app: &tauri::AppHandle, text: &str) {
    if let Some(window) = app.get_webview_window("main") {
        let js = format!(
            "document.getElementById('status').innerHTML = '<b>altivola-db could not start</b><pre></pre>';\
             document.querySelector('pre').textContent = {};",
            js_string(text)
        );
        let _ = window.eval(&js);
    }
}

/// A JavaScript string literal for text.
fn js_string(text: &str) -> String {
    let mut out = String::from("\"");
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => {}
            c if (c as u32) < 0x20 => out.push(' '),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            tauri::async_runtime::spawn(check_for_update(app.handle().clone()));
            let script = app.path().resource_dir()?.join("server").join("altivola-db.js");
            let (mut events, child) = app
                .shell()
                .sidecar("node")?
                .args([
                    script.to_string_lossy().to_string(),
                    "serve".into(),
                    "--addr".into(),
                    // Not 7789, which the Docker image uses. A taken port falls back to a free one.
                    "127.0.0.1:7791".into(),
                    "--no-browser".into(),
                ])
                .env("PATH", tool_path())
                .spawn()?;
            app.manage(Server(Mutex::new(Some(child))));

            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut opened = false;
                let mut errors = String::new();
                while let Some(event) = events.recv().await {
                    match event {
                        CommandEvent::Stdout(bytes) => {
                            let line = String::from_utf8_lossy(&bytes);
                            if !opened {
                                if let Some(url) = server_url(&line) {
                                    if let Some(window) = handle.get_webview_window("main") {
                                        let _ = window.navigate(url);
                                        opened = true;
                                    }
                                }
                            }
                        }
                        CommandEvent::Stderr(bytes) => {
                            errors.push_str(&String::from_utf8_lossy(&bytes));
                        }
                        CommandEvent::Terminated(status) => {
                            if !opened {
                                let code = status.code.map(|c| c.to_string()).unwrap_or("a signal".into());
                                show_error(&handle, &format!("The server stopped with {code}.\n\n{errors}"));
                            }
                            break;
                        }
                        _ => {}
                    }
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("could not build the app");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            stop_server(handle);
        }
    });
}
