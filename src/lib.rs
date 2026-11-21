//! Zed extension: starts the `laravel-query` language server for PHP and Blade files.
//!
//! The server (TypeScript, bundled into one `CommonJS` file by `server/build.mjs`) is attached to the
//! GitHub release of the same version as the extension (`v<version>`, see
//! `.github/workflows/release.yml`). It is downloaded into the extension's work directory on first
//! start and run with the Node.js that Zed manages; extension and server versions always match.
//!
//! `lsp.laravel-query.binary` in Zed settings overrides the command: `path` (+ `arguments`) runs
//! any binary, `arguments` alone runs Zed's Node.js with them (e.g. a local
//! `server/dist/laravel-query-server.cjs` while developing). `lsp.laravel-query.settings` /
//! `initialization_options` are passed through to the server.
//!
//! Completion labels are rendered here: the name highlighted by kind, the usage trend (▲ rising,
//! ▼ falling) and the table/type dimmed.

use std::fs;

use zed_extension_api::{
    self as zed, CodeLabel, CodeLabelSpan, DownloadedFileType, GithubReleaseAsset,
    LanguageServerId, LanguageServerInstallationStatus, Result,
    lsp::{Completion, CompletionKind},
    serde_json,
    settings::{CommandSettings, LspSettings},
};

const REPOSITORY: &str = "DmitrySkibitsky/zed-laravel-query";
const SERVER_ASSET: &str = "laravel-query-server.cjs";
const VERSION: &str = env!("CARGO_PKG_VERSION");
const SERVER_DIR_PREFIX: &str = "server-v";
const RESET_PREFIX: &str = "↺ reset rank: ";

struct LaravelQueryExtension {
    /// Absolute path of the downloaded server script.
    server_path: Option<String>,
}

impl LaravelQueryExtension {
    /// The server script of this extension version, downloaded on first use.
    fn server_script(&mut self, language_server_id: &LanguageServerId) -> Result<String> {
        if let Some(path) = &self.server_path
            && fs::metadata(path).is_ok_and(|m| m.is_file())
        {
            return Ok(path.clone());
        }

        let dir = server_dir();
        let path = format!("{dir}/{SERVER_ASSET}");
        if !fs::metadata(&path).is_ok_and(|m| m.is_file()) {
            if let Err(error) = download_server(language_server_id, &dir, &path) {
                zed::set_language_server_installation_status(
                    language_server_id,
                    &LanguageServerInstallationStatus::Failed(error.clone()),
                );
                return Err(error);
            }
            remove_stale_servers(&dir);
        }

        let path = std::env::current_dir()
            .map_err(|e| format!("failed to resolve the extension work directory: {e}"))?
            .join(&path)
            .to_string_lossy()
            .into_owned();
        self.server_path = Some(path.clone());
        Ok(path)
    }
}

fn download_server(language_server_id: &LanguageServerId, dir: &str, path: &str) -> Result<()> {
    zed::set_language_server_installation_status(
        language_server_id,
        &LanguageServerInstallationStatus::CheckingForUpdate,
    );
    let tag = release_tag();
    let release = zed::github_release_by_tag_name(REPOSITORY, &tag).map_err(|e| {
        format!(
            "laravel-query: release {tag} of {REPOSITORY} not found ({e}). To run a local server \
             build, set lsp.laravel-query.binary.arguments in Zed settings."
        )
    })?;
    let asset = find_server_asset(&release.assets)
        .ok_or_else(|| format!("laravel-query: release {tag} has no {SERVER_ASSET} asset"))?;

    zed::set_language_server_installation_status(
        language_server_id,
        &LanguageServerInstallationStatus::Downloading,
    );
    fs::create_dir_all(dir).map_err(|e| format!("failed to create {dir}: {e}"))?;
    zed::download_file(&asset.download_url, path, DownloadedFileType::Uncompressed)
        .map_err(|e| format!("laravel-query: failed to download {SERVER_ASSET}: {e}"))?;
    zed::set_language_server_installation_status(
        language_server_id,
        &LanguageServerInstallationStatus::None,
    );
    Ok(())
}

impl zed::Extension for LaravelQueryExtension {
    fn new() -> Self {
        Self { server_path: None }
    }

    fn language_server_command(
        &mut self,
        language_server_id: &LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Result<zed::Command> {
        let binary = LspSettings::for_worktree(language_server_id.as_ref(), worktree)
            .ok()
            .and_then(|settings| settings.binary);
        let env = binary
            .as_ref()
            .and_then(|b| b.env.clone())
            .map_or_else(Vec::new, |env| env.into_iter().collect());

        match binary {
            Some(CommandSettings {
                path: Some(path),
                arguments,
                ..
            }) => Ok(zed::Command {
                command: path,
                args: arguments.unwrap_or_else(|| vec!["--stdio".into()]),
                env,
            }),
            Some(CommandSettings {
                path: None,
                arguments: Some(arguments),
                ..
            }) => Ok(zed::Command {
                command: zed::node_binary_path()?,
                args: arguments,
                env,
            }),
            _ => Ok(zed::Command {
                command: zed::node_binary_path()?,
                args: vec![self.server_script(language_server_id)?, "--stdio".into()],
                env,
            }),
        }
    }

    fn language_server_initialization_options(
        &mut self,
        language_server_id: &LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Result<Option<serde_json::Value>> {
        Ok(
            LspSettings::for_worktree(language_server_id.as_ref(), worktree)
                .ok()
                .and_then(|settings| settings.initialization_options.or(settings.settings)),
        )
    }

    fn language_server_workspace_configuration(
        &mut self,
        language_server_id: &LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Result<Option<serde_json::Value>> {
        Ok(
            LspSettings::for_worktree(language_server_id.as_ref(), worktree)
                .ok()
                .and_then(|settings| settings.settings),
        )
    }

    fn label_for_completion(
        &self,
        _language_server_id: &LanguageServerId,
        completion: Completion,
    ) -> Option<CodeLabel> {
        Some(completion_label(
            &completion.label,
            completion.detail.as_deref(),
            completion.kind.as_ref(),
        ))
    }
}

/// Theme highlight of the item name by completion kind.
fn highlight_for(kind: Option<&CompletionKind>) -> Option<&'static str> {
    match kind? {
        CompletionKind::Field | CompletionKind::Property => Some("property"),
        CompletionKind::Class | CompletionKind::Interface | CompletionKind::Struct => Some("type"),
        CompletionKind::Module => Some("namespace"),
        CompletionKind::Method | CompletionKind::Function => Some("function"),
        CompletionKind::Operator => Some("operator"),
        CompletionKind::Reference => Some("constant"),
        CompletionKind::Event => Some("comment"),
        _ => None,
    }
}

/// `name ▲ users · varchar(255)`: the name by kind, the trend marker in its own color, the rest
/// dimmed. Filtering covers the name only (for reset items: the column after the prefix).
fn completion_label(label: &str, detail: Option<&str>, kind: Option<&CompletionKind>) -> CodeLabel {
    let mut spans = vec![CodeLabelSpan::literal(
        label,
        highlight_for(kind).map(ToString::to_string),
    )];
    let mut code = label.to_string();
    if let Some(detail) = detail.filter(|d| !d.is_empty() && *d != label) {
        let (trend, rest) = split_trend(detail);
        code.push(' ');
        spans.push(CodeLabelSpan::literal(" ", None));
        if let Some((marker, highlight)) = trend {
            code.push_str(marker);
            code.push(' ');
            spans.push(CodeLabelSpan::literal(
                format!("{marker} "),
                Some(highlight.to_string()),
            ));
        }
        code.push_str(rest);
        spans.push(CodeLabelSpan::literal(rest, Some("comment".to_string())));
    }
    let filter_start = label
        .strip_prefix(RESET_PREFIX)
        .map_or(0, |_| RESET_PREFIX.len());
    CodeLabel {
        code,
        spans,
        filter_range: zed::Range {
            start: u32::try_from(filter_start).unwrap_or(0),
            end: u32::try_from(label.len()).unwrap_or(u32::MAX),
        },
    }
}

/// The usage trend the server puts in front of the detail.
fn split_trend(detail: &str) -> (Option<(&'static str, &'static str)>, &str) {
    for (marker, highlight) in [("▲", "string"), ("▼", "constant"), ("•", "comment")] {
        if let Some(rest) = detail.strip_prefix(marker) {
            return (Some((marker, highlight)), rest.trim_start());
        }
    }
    (None, detail)
}

fn release_tag() -> String {
    format!("v{VERSION}")
}

/// Per-version directory, so an extension update never runs an older server.
fn server_dir() -> String {
    format!("{SERVER_DIR_PREFIX}{VERSION}")
}

fn find_server_asset(assets: &[GithubReleaseAsset]) -> Option<&GithubReleaseAsset> {
    assets.iter().find(|asset| asset.name == SERVER_ASSET)
}

/// Servers of other versions in the work directory.
fn is_stale_server(entry: &str, current_dir: &str) -> bool {
    entry.starts_with(SERVER_DIR_PREFIX) && entry != current_dir
}

fn remove_stale_servers(current_dir: &str) {
    let Ok(entries) = fs::read_dir(".") else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        if is_stale_server(&name.to_string_lossy(), current_dir) {
            let path = entry.path();
            let _ = if path.is_dir() {
                fs::remove_dir_all(path)
            } else {
                fs::remove_file(path)
            };
        }
    }
}

zed::register_extension!(LaravelQueryExtension);

#[cfg(test)]
mod tests {
    use super::*;

    fn asset(name: &str) -> GithubReleaseAsset {
        GithubReleaseAsset {
            name: name.into(),
            download_url: format!("https://example.test/{name}"),
        }
    }

    fn literal(span: &CodeLabelSpan) -> (&str, Option<&str>) {
        match span {
            CodeLabelSpan::Literal(literal) => {
                (literal.text.as_str(), literal.highlight_name.as_deref())
            }
            CodeLabelSpan::CodeRange(_) => panic!("unexpected code range"),
        }
    }

    #[test]
    fn release_tag_and_dir_follow_the_crate_version() {
        assert_eq!(release_tag(), format!("v{}", env!("CARGO_PKG_VERSION")));
        assert_eq!(
            server_dir(),
            format!("server-v{}", env!("CARGO_PKG_VERSION"))
        );
    }

    #[test]
    fn finds_the_server_asset_by_exact_name() {
        let assets = [
            asset("laravel-query-server.cjs.sha256"),
            asset("laravel-query-server.cjs"),
            asset("source.tar.gz"),
        ];
        assert_eq!(
            find_server_asset(&assets).map(|a| a.download_url.as_str()),
            Some("https://example.test/laravel-query-server.cjs")
        );
        assert!(find_server_asset(&[asset("other.js")]).is_none());
    }

    #[test]
    fn stale_servers_are_other_versions() {
        let current = "server-v0.2.0";
        assert!(!is_stale_server("server-v0.2.0", current));
        assert!(is_stale_server("server-v0.1.0", current));
        assert!(!is_stale_server("node_modules", current));
    }

    #[test]
    fn column_label_with_trend() {
        let label = completion_label(
            "email",
            Some("▲ users · varchar(255)"),
            Some(&CompletionKind::Field),
        );
        assert_eq!(label.code, "email ▲ users · varchar(255)");
        let spans: Vec<_> = label.spans.iter().map(literal).collect();
        assert_eq!(
            spans,
            vec![
                ("email", Some("property")),
                (" ", None),
                ("▲ ", Some("string")),
                ("users · varchar(255)", Some("comment")),
            ]
        );
        assert_eq!((label.filter_range.start, label.filter_range.end), (0, 5));
    }

    #[test]
    fn table_label_without_trend() {
        let label = completion_label(
            "users",
            Some("User · 6 columns"),
            Some(&CompletionKind::Class),
        );
        assert_eq!(label.code, "users User · 6 columns");
        assert_eq!(literal(&label.spans[0]), ("users", Some("type")));
    }

    #[test]
    fn reset_items_filter_by_the_column() {
        let label = completion_label(
            "↺ reset rank: users.email",
            Some("forget how often it was picked"),
            Some(&CompletionKind::Event),
        );
        let filter =
            &label.code[label.filter_range.start as usize..label.filter_range.end as usize];
        assert_eq!(filter, "users.email");
    }
}
