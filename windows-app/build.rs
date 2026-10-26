// Build script: the version (from the repository's package.json, the one version lu-minal has),
// a check that the embedded web assets are there, and on Windows the exe's icon, version info
// and manifest.
use std::path::{Path, PathBuf};

/// Embedded by src/app/web.rs; copied by scripts/windows-app-assets.mjs.
const ASSETS: &[&str] = &["xterm.mjs", "xterm.css", "addon-fit.mjs", "addon-unicode11.mjs", "addon-webgl.mjs", "lu-minal.ico"];
/// The app's own page (committed).
const WEB: &[&str] = &["index.html", "terminal.js", "app.css"];

const MANIFEST: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <assemblyIdentity type="win32" name="Luna-OS.lu-minal.window" version="@VERSION@" />
  <description>lu-minal window</description>
  <dependency>
    <dependentAssembly>
      <assemblyIdentity type="win32" name="Microsoft.Windows.Common-Controls" version="6.0.0.0" processorArchitecture="*" publicKeyToken="6595b64144ccf1df" language="*" />
    </dependentAssembly>
  </dependency>
  <compatibility xmlns="urn:schemas-microsoft-com:compatibility.v1">
    <application>
      <supportedOS Id="{8e0f7a12-bfb3-4fe8-b9a5-48fd50a15a9a}" />
    </application>
  </compatibility>
  <application xmlns="urn:schemas-microsoft-com:asm.v3">
    <windowsSettings>
      <dpiAwareness xmlns="http://schemas.microsoft.com/SMI/2016/WindowsSettings">PerMonitorV2</dpiAwareness>
      <longPathAware xmlns="http://schemas.microsoft.com/SMI/2016/WindowsSettings">true</longPathAware>
      <activeCodePage xmlns="http://schemas.microsoft.com/SMI/2019/WindowsSettings">UTF-8</activeCodePage>
    </windowsSettings>
  </application>
  <trustInfo xmlns="urn:schemas-microsoft-com:asm.v3">
    <security>
      <requestedPrivileges>
        <requestedExecutionLevel level="asInvoker" uiAccess="false" />
      </requestedPrivileges>
    </security>
  </trustInfo>
</assembly>
"#;

fn package_version(root: &Path) -> String {
    if let Ok(v) = std::env::var("LU_MINAL_VERSION") {
        if !v.trim().is_empty() {
            return v.trim().trim_start_matches('v').to_string();
        }
    }
    let file = root.join("package.json");
    let text = std::fs::read_to_string(&file).unwrap_or_else(|e| panic!("cannot read {}: {e}", file.display()));
    let json: serde_json::Value = serde_json::from_str(&text).unwrap_or_else(|e| panic!("{} is not JSON: {e}", file.display()));
    json["version"].as_str().unwrap_or_else(|| panic!("{} has no version", file.display())).to_string()
}

/// "0.2.0-rc.1+5" -> 0.2.0.0 as the four 16-bit words Windows wants.
fn numeric_version(version: &str) -> (String, u64) {
    let core = version.split(['-', '+']).next().unwrap_or("0.0.0");
    let mut parts = core.split('.').map(|p| p.parse::<u64>().unwrap_or(0).min(0xffff));
    let (major, minor, patch) = (parts.next().unwrap_or(0), parts.next().unwrap_or(0), parts.next().unwrap_or(0));
    (format!("{major}.{minor}.{patch}.0"), (major << 48) | (minor << 32) | (patch << 16))
}

fn main() {
    let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let root = manifest_dir.parent().expect("windows-app sits in the repository").to_path_buf();
    println!("cargo:rerun-if-changed={}", root.join("package.json").display());
    println!("cargo:rerun-if-env-changed=LU_MINAL_VERSION");
    let version = package_version(&root);
    println!("cargo:rustc-env=LU_MINAL_WINDOW_VERSION={version}");

    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    if target_os != "windows" {
        // `cargo test` on another OS builds only the pure parts.
        return;
    }

    let assets = manifest_dir.join("assets");
    let missing: Vec<&str> = ASSETS.iter().copied().filter(|f| !assets.join(f).is_file()).collect();
    if !missing.is_empty() {
        panic!(
            "\n\nwindows-app/assets is missing {}.\nRun `npm ci` and then `node scripts/windows-app-assets.mjs` in the repository root first.\n\n",
            missing.join(", ")
        );
    }
    for file in ASSETS {
        println!("cargo:rerun-if-changed={}", assets.join(file).display());
    }
    for file in WEB {
        let path = manifest_dir.join("web").join(file);
        assert!(path.is_file(), "windows-app/web/{file} is missing");
        println!("cargo:rerun-if-changed={}", path.display());
    }

    // The resource compiler (rc.exe) comes with the Windows SDK: only on a Windows build machine.
    if !cfg!(windows) {
        println!("cargo:warning=not building on Windows: the exe gets no icon, version info or manifest");
        return;
    }
    let (dotted, packed) = numeric_version(&version);
    let mut res = winresource::WindowsResource::new();
    res.set_icon(assets.join("lu-minal.ico").to_str().expect("UTF-8 path"))
        .set("FileDescription", "lu-minal")
        .set("ProductName", "lu-minal")
        .set("CompanyName", "Luna-OS")
        .set("LegalCopyright", "MIT License, Luna-OS")
        .set("OriginalFilename", "lu-minal-window.exe")
        .set("InternalName", "lu-minal-window")
        .set("FileVersion", &dotted)
        .set("ProductVersion", &version)
        .set_version_info(winresource::VersionInfo::FILEVERSION, packed)
        .set_version_info(winresource::VersionInfo::PRODUCTVERSION, packed)
        .set_language(0x0409)
        .set_manifest(&MANIFEST.replace("@VERSION@", &dotted));
    if let Err(e) = res.compile() {
        panic!("could not compile the Windows resources (icon, version info, manifest): {e}");
    }
}
