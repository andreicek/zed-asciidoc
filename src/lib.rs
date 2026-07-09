use std::fs;
use std::path::PathBuf;
use zed_extension_api::{
    self as zed,
    serde_json::{json, Value},
    settings::LspSettings,
    LanguageServerId, Result,
};

const ASCIIDOCTOR_D_REPO: &str = "dlang-supplemental/asciidoctor-d";
const ASCIIDOCTOR_D_PREFIX: &str = "asciidoctor-d-";

struct AsciiDocExtension {
    cached_asciidoctor_d: Option<PathBuf>,
}

impl AsciiDocExtension {
    fn engine_from_settings(settings: &Option<Value>) -> String {
        settings
            .as_ref()
            .and_then(|v| v.get("engine"))
            .and_then(|v| v.as_str())
            .unwrap_or("asciidoctor-js")
            .to_string()
    }

    fn resolve_asciidoctor_d(
        &mut self,
        language_server_id: &LanguageServerId,
        worktree: &zed::Worktree,
        settings: &Option<Value>,
    ) -> Result<PathBuf> {
        if let Some(path) = settings
            .as_ref()
            .and_then(|v| v.get("asciidoctorDPath"))
            .and_then(|v| v.as_str())
        {
            let p = PathBuf::from(path);
            if p.is_file() {
                return Ok(p);
            }
        }

        let binary_name = match zed::current_platform() {
            (zed::Os::Windows, _) => "asciidoctor-d.exe",
            _ => "asciidoctor-d",
        };

        if let Some(path) = worktree.which("asciidoctor-d") {
            return Ok(PathBuf::from(path));
        }

        if let Some(path) = &self.cached_asciidoctor_d {
            if path.is_file() {
                return Ok(path.clone());
            }
        }

        let path = Self::download_asciidoctor_d(language_server_id, binary_name)?;
        self.cached_asciidoctor_d = Some(path.clone());
        Ok(path)
    }

    fn download_asciidoctor_d(
        language_server_id: &LanguageServerId,
        binary_name: &str,
    ) -> Result<PathBuf> {
        zed::set_language_server_installation_status(
            language_server_id,
            &zed::LanguageServerInstallationStatus::CheckingForUpdate,
        );

        let release = zed::latest_github_release(
            ASCIIDOCTOR_D_REPO,
            zed::GithubReleaseOptions {
                require_assets: true,
                pre_release: false,
            },
        )
        .map_err(|e| format!("Failed to fetch asciidoctor-d release: {e}"))?;

        let (platform, arch) = zed::current_platform();
        let target = match (platform, arch) {
            (zed::Os::Windows, zed::Architecture::X8664) => "windows-x64",
            (zed::Os::Linux, zed::Architecture::X8664) => "linux-x64",
            (zed::Os::Mac, zed::Architecture::Aarch64) => "macos-arm64",
            (zed::Os::Mac, zed::Architecture::X8664) => "macos-x64",
            (zed::Os::Linux, zed::Architecture::Aarch64) => "linux-arm64",
            _ => {
                return Err(
                    "No asciidoctor-d binary for this platform yet. Build from source or set asciidoctorDPath."
                        .into(),
                )
            }
        };

        let archive_name = if platform == zed::Os::Windows {
            format!("asciidoctor-d-{target}.zip")
        } else {
            format!("asciidoctor-d-{target}.tar.gz")
        };

        let asset = release
            .assets
            .iter()
            .find(|a| a.name == archive_name)
            .ok_or_else(|| {
                format!(
                    "Release {} has no asset {archive_name}. Available: {}",
                    release.version,
                    release
                        .assets
                        .iter()
                        .map(|a| a.name.as_str())
                        .collect::<Vec<_>>()
                        .join(", ")
                )
            })?;

        let version_dir = format!("{ASCIIDOCTOR_D_PREFIX}{}", release.version);
        let binary_path = PathBuf::from(&version_dir).join(binary_name);

        if !binary_path.is_file() {
            zed::set_language_server_installation_status(
                language_server_id,
                &zed::LanguageServerInstallationStatus::Downloading,
            );

            let file_type = if platform == zed::Os::Windows {
                zed::DownloadedFileType::Zip
            } else {
                zed::DownloadedFileType::GzipTar
            };

            zed::download_file(&asset.download_url, &version_dir, file_type)
                .map_err(|e| format!("Failed to download asciidoctor-d: {e}"))?;

            // Archives may extract flat or nested; normalize to version_dir/binary_name.
            if !binary_path.is_file() {
                if let Ok(entries) = fs::read_dir(&version_dir) {
                    for entry in entries.flatten() {
                        let p = entry.path();
                        if p.file_name().and_then(|n| n.to_str()) == Some(binary_name) {
                            // already correct location conceptually
                            break;
                        }
                        if p.is_dir() {
                            let nested = p.join(binary_name);
                            if nested.is_file() {
                                fs::rename(&nested, &binary_path).map_err(|e| {
                                    format!("Failed to relocate asciidoctor-d: {e}")
                                })?;
                                break;
                            }
                        }
                    }
                }
            }

            if !binary_path.is_file() {
                return Err(format!(
                    "Downloaded archive but could not find {binary_name} under {version_dir}"
                ));
            }

            zed::make_file_executable(
                binary_path
                    .to_str()
                    .ok_or("Invalid asciidoctor-d path")?,
            )?;

            // Keep only the current version directory.
            if let Ok(entries) = fs::read_dir(".") {
                for entry in entries.flatten() {
                    if let Ok(name) = entry.file_name().into_string() {
                        if name.starts_with(ASCIIDOCTOR_D_PREFIX) && name != version_dir {
                            fs::remove_dir_all(entry.path()).ok();
                        }
                    }
                }
            }
        }

        zed::set_language_server_installation_status(
            language_server_id,
            &zed::LanguageServerInstallationStatus::None,
        );

        Ok(binary_path)
    }

    fn bundled_server_path() -> Result<String> {
        const CANDIDATES: &[&str] = &["lsp/dist/server.js", "./lsp/dist/server.js"];
        for candidate in CANDIDATES {
            if fs::metadata(candidate).is_ok() {
                return Ok(candidate.to_string());
            }
        }
        Err(
            "Bundled AsciiDoc LSP missing (lsp/dist/server.js). Run `pnpm install && pnpm build` in lsp/."
                .into(),
        )
    }
}

impl zed::Extension for AsciiDocExtension {
    fn new() -> Self {
        Self {
            cached_asciidoctor_d: None,
        }
    }

    fn language_server_command(
        &mut self,
        language_server_id: &LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Result<zed::Command> {
        let lsp_settings = LspSettings::for_worktree("asciidoc-lsp", worktree).ok();
        let settings = lsp_settings.and_then(|s| s.settings);
        let engine = Self::engine_from_settings(&settings);

        // Eagerly fetch the D CLI when selected so preview works without PATH setup.
        if engine == "asciidoctor-d" {
            let _ = self.resolve_asciidoctor_d(language_server_id, worktree, &settings)?;
        }

        if let Some(path) = worktree.which("asciidoc-lsp") {
            return Ok(zed::Command {
                command: path,
                args: vec![],
                env: Default::default(),
            });
        }

        let node = zed::node_binary_path().or_else(|_| {
            worktree
                .which("node")
                .ok_or_else(|| "Node.js is required for AsciiDoc LSP (node not found)".to_string())
        })?;

        let script = Self::bundled_server_path()?;
        Ok(zed::Command {
            command: node,
            args: vec![script],
            env: Default::default(),
        })
    }

    fn language_server_workspace_configuration(
        &mut self,
        language_server_id: &LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Result<Option<Value>> {
        let lsp_settings = LspSettings::for_worktree("asciidoc-lsp", worktree)?;
        let mut settings = lsp_settings.settings.unwrap_or_else(|| {
            json!({
                "engine": "asciidoctor-js"
            })
        });

        let engine = Self::engine_from_settings(&Some(settings.clone()));
        if engine == "asciidoctor-d" {
            let path = self.resolve_asciidoctor_d(language_server_id, worktree, &Some(settings.clone()))?;
            if let Some(obj) = settings.as_object_mut() {
                obj.insert(
                    "asciidoctorDPath".into(),
                    Value::String(path.to_string_lossy().into_owned()),
                );
            }
        }

        Ok(Some(settings))
    }
}

zed::register_extension!(AsciiDocExtension);
