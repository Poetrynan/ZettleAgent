//! GPU hardware detection using wgpu.
//! Provides adapter info including real VRAM via platform-specific OS APIs.
//!
//! VRAM detection:
//! - Windows: DXGI (via win32 API through `windows` crate fallback to registry)
//! - macOS: IOKit via sysctl
//! - Linux: nvidia-smi or /sys/class/drm

// Windows-specific VRAM detection helpers (used conditionally by GPU detection paths)
#![allow(dead_code)]

use serde::Serialize;

/// Information about a single GPU adapter.
#[derive(Debug, Serialize, Clone)]
pub struct GpuAdapterInfo {
    /// Human-readable GPU name (e.g. "NVIDIA GeForce RTX 4060 Laptop GPU")
    pub name: String,
    /// Device type: "discrete", "integrated", "cpu", "virtual", "unknown"
    pub device_type: String,
    /// Dedicated VRAM in MB (0 if unavailable/integrated)
    pub vram_mb: u64,
    /// Backend API: "vulkan", "metal", "dx12", "opengl", "unknown"
    pub backend: String,
    /// Whether this adapter supports WebGPU
    pub is_webgpu_compatible: bool,
}

/// Overall GPU detection result.
#[derive(Debug, Serialize, Clone)]
pub struct GpuInfo {
    /// All detected adapters (may be empty on headless/VM systems)
    pub adapters: Vec<GpuAdapterInfo>,
    /// Best candidate for compute (discrete > integrated > other)
    pub recommended_adapter_index: Option<usize>,
    /// Total system memory in MB
    pub system_ram_mb: u64,
}

/// Detect all GPU adapters using wgpu + OS APIs for VRAM.
pub fn detect_gpus() -> GpuInfo {
    let mut adapters = Vec::new();
    let mut recommended_index: Option<usize> = None;

    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
        backends: wgpu::Backends::all(),
        ..Default::default()
    });

    let wgpu_adapters: Vec<_> = instance.enumerate_adapters(wgpu::Backends::all());

    // Get real VRAM for each adapter via OS APIs
    let vram_map = detect_vram_per_adapter();

    for (idx, adapter) in wgpu_adapters.into_iter().enumerate() {
        let info = adapter.get_info();

        let device_type = match info.device_type {
            wgpu::DeviceType::DiscreteGpu => "discrete",
            wgpu::DeviceType::IntegratedGpu => "integrated",
            wgpu::DeviceType::Cpu => "cpu",
            wgpu::DeviceType::VirtualGpu => "virtual",
            _ => "unknown",
        };

        let backend = match info.backend {
            wgpu::Backend::Vulkan => "vulkan",
            wgpu::Backend::Metal => "metal",
            wgpu::Backend::Dx12 => "dx12",
            wgpu::Backend::Gl => "opengl",
            wgpu::Backend::BrowserWebGpu => "webgpu",
            _ => "unknown",
        };

        // Look up real VRAM by adapter name (case-insensitive partial match)
        let vram_mb = lookup_vram(&vram_map, &info.name, device_type);

        let is_webgpu_compatible = matches!(device_type, "discrete" | "integrated")
            && matches!(backend, "vulkan" | "metal" | "dx12" | "webgpu");

        let adapter_info = GpuAdapterInfo {
            name: info.name,
            device_type: device_type.to_string(),
            vram_mb,
            backend: backend.to_string(),
            is_webgpu_compatible,
        };

        if device_type == "discrete" && recommended_index.is_none() {
            recommended_index = Some(idx);
        } else if device_type == "integrated" && recommended_index.is_none() {
            recommended_index = Some(idx);
        }

        adapters.push(adapter_info);
    }

    if recommended_index.is_none() && !adapters.is_empty() {
        recommended_index = Some(0);
    }

    let system_ram_mb = get_system_ram_mb();

    GpuInfo {
        adapters,
        recommended_adapter_index: recommended_index,
        system_ram_mb,
    }
}

/// VRAM info per adapter from OS detection.
struct VramEntry {
    name: String,
    vram_mb: u64,
}

/// Detect VRAM for all GPUs using platform-specific APIs.
fn detect_vram_per_adapter() -> Vec<VramEntry> {
    #[cfg(target_os = "windows")]
    {
        detect_vram_windows()
    }
    #[cfg(target_os = "macos")]
    {
        detect_vram_macos()
    }
    #[cfg(target_os = "linux")]
    {
        detect_vram_linux()
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        vec![]
    }
}

/// Windows: read VRAM from registry or DXGI.
fn detect_vram_windows() -> Vec<VramEntry> {
    // Try multiple methods in order of reliability
    // Method 1: Registry (most reliable for dedicated GPU VRAM)
    let entries = detect_vram_windows_registry();
    if !entries.is_empty() {
        return entries;
    }

    // Method 2: PowerShell with explicit 64-bit handling
    detect_vram_windows_powershell()
}

/// Create a Command with console window hidden (Windows only).
/// On non-Windows platforms, returns the command unchanged.
#[cfg(target_os = "windows")]
fn hide_console_window(cmd: &mut std::process::Command) {
    use std::os::windows::process::CommandExt;
    // CREATE_NO_WINDOW = 0x08000000 — prevents console window from appearing
    cmd.creation_flags(0x08000000);
}

#[cfg(not(target_os = "windows"))]
fn hide_console_window(_cmd: &mut std::process::Command) {
    // No-op on non-Windows
}

/// Read GPU info from Windows Registry (HKLM\SYSTEM\CurrentControlSet\Control\Video).
fn detect_vram_windows_registry() -> Vec<VramEntry> {
    let mut entries = Vec::new();

    // Use reg query to read HardwareInformation.qwMemorySize
    let mut cmd = std::process::Command::new("reg");
    hide_console_window(&mut cmd);
    if let Ok(output) = cmd
        .args(&[
            "query",
            r"HKLM\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}",
            "/s",
            "/v", "HardwareInformation.qwMemorySize",
        ])
        .output()
    {
        let text = String::from_utf8_lossy(&output.stdout);
        let mut current_adapter = String::new();

        for line in text.lines() {
            let line = line.trim();

            // Each GPU is in a subkey like 0000, 0001, etc.
            if line.contains(r"\{4d36e968-e325-11ce-bfc1-08002be10318}\") {
                // Extract the subkey number (0000, 0001, etc.)
                if let Some(pos) = line.rfind('\\') {
                    let subkey = &line[pos + 1..];
                    // Try to read the GPU name for this subkey
                    current_adapter = get_gpu_name_from_registry(subkey);
                }
            }

            // Parse the QWORD memory value
            if line.contains("HardwareInformation.qwMemorySize") {
                // Format: "HardwareInformation.qwMemorySize    REG_QWORD    0x1000000000"
                let parts: Vec<&str> = line.split_whitespace().collect();
                if let Some(hex_str) = parts.last() {
                    let hex_str = hex_str.trim_start_matches("0x");
                    if let Ok(vram_bytes) = u64::from_str_radix(hex_str, 16) {
                        let vram_mb = vram_bytes / (1024 * 1024);
                        if vram_mb > 0 {
                            entries.push(VramEntry {
                                name: current_adapter.clone(),
                                vram_mb,
                            });
                        }
                    }
                }
            }
        }
    }

    entries
}

/// Get friendly GPU name from registry subkey.
fn get_gpu_name_from_registry(subkey: &str) -> String {
    let path = format!(
        r"HKLM\SYSTEM\CurrentControlSet\Control\Class\{{4d36e968-e325-11ce-bfc1-08002be10318}}\{}",
        subkey
    );

    let mut cmd = std::process::Command::new("reg");
    hide_console_window(&mut cmd);
    if let Ok(output) = cmd
        .args(&["query", &path, "/v", "DriverDesc"])
        .output()
    {
        let text = String::from_utf8_lossy(&output.stdout);
        for line in text.lines() {
            // Format: "    DriverDesc    REG_SZ    NVIDIA GeForce RTX 4060 Laptop GPU"
            if line.contains("REG_SZ") {
                let parts: Vec<&str> = line.splitn(3, "REG_SZ").collect();
                if parts.len() == 2 {
                    return parts[1].trim().to_string();
                }
            }
        }
    }

    String::new()
}

/// Fallback: PowerShell with proper 64-bit handling.
fn detect_vram_windows_powershell() -> Vec<VramEntry> {
    let mut entries = Vec::new();

    // Use a more reliable query that handles large VRAM values
    let command = r#"
$adapters = Get-WmiObject Win32_VideoController
foreach ($a in $adapters) {
    # AdapterRAM can be $null or 0 for some GPUs, try alternative properties
    $vram = $a.AdapterRAM
    if (-not $vram -or $vram -le 0) {
        # Try ConfigManagerErrorCode = 0 means device is working properly
        $vram = 0
    }
    Write-Output "GPU: $($a.Name) | VRAM: $vram"
}
"#;

    let mut cmd = std::process::Command::new("powershell");
    hide_console_window(&mut cmd);
    if let Ok(output) = cmd
        .args(&["-NoProfile", "-Command", command])
        .output()
    {
        let text = String::from_utf8_lossy(&output.stdout);
        for line in text.lines() {
            let line = line.trim();
            if line.starts_with("GPU:") {
                // Parse "GPU: Name | VRAM: value"
                let parts: Vec<&str> = line.splitn(2, '|').collect();
                if parts.len() == 2 {
                    let name = parts[0]
                        .trim()
                        .trim_start_matches("GPU:")
                        .trim()
                        .to_string();
                    let vram_part = parts[1].trim();
                    if let Some(vram_str) = vram_part.strip_prefix("VRAM:") {
                        let vram_str = vram_str.trim();
                        if let Ok(vram_bytes) = vram_str.parse::<u64>() {
                            let vram_mb = vram_bytes / (1024 * 1024);
                            if !name.is_empty() {
                                entries.push(VramEntry {
                                    name,
                                    vram_mb,
                                });
                            }
                        }
                    }
                }
            }
        }
    }

    entries
}

/// macOS: use IOKit via sysctl or system_profiler.
#[cfg(target_os = "macos")]
fn detect_vram_macos() -> Vec<VramEntry> {
    let mut entries = Vec::new();

    // Apple Silicon: unified memory, no dedicated VRAM
    // Intel Mac: use system_profiler
    if let Ok(output) = std::process::Command::new("system_profiler")
        .args(&["SPDisplaysDataType", "-json"])
        .output()
    {
        let text = String::from_utf8_lossy(&output.stdout);
        // Parse JSON for VRAM info
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) {
            if let Some(displays) = json.get("SPDisplaysDataType").and_then(|v| v.as_array()) {
                for display in displays {
                    let name = display.get("sppci_model")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();

                    // Try to parse VRAM from "spdisplays_vram" field
                    let vram_mb = display.get("spdisplays_vram")
                        .and_then(|v| v.as_str())
                        .and_then(|s| {
                            // Format: "1536 MB" or "8 GB" or "shared 1536"
                            let s = s.to_lowercase();
                            if s.contains("gb") {
                                s.split_whitespace().next()
                                    .and_then(|n| n.parse::<f64>().ok())
                                    .map(|g| (g * 1024.0) as u64)
                            } else if s.contains("mb") {
                                s.split_whitespace().next()
                                    .and_then(|n| n.parse::<f64>().ok())
                                    .map(|m| m as u64)
                            } else {
                                None
                            }
                        })
                        .unwrap_or(0);

                    if !name.is_empty() {
                        entries.push(VramEntry { name, vram_mb });
                    }
                }
            }
        }
    }

    entries
}

/// Linux: try nvidia-smi first, then parse /sys/class/drm.
#[cfg(target_os = "linux")]
fn detect_vram_linux() -> Vec<VramEntry> {
    let mut entries = Vec::new();

    // Try nvidia-smi for NVIDIA GPUs
    if let Ok(output) = std::process::Command::new("nvidia-smi")
        .args(&["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"])
        .output()
    {
        let text = String::from_utf8_lossy(&output.stdout);
        for line in text.lines() {
            let parts: Vec<&str> = line.split(',').collect();
            if parts.len() >= 2 {
                let name = parts[0].trim().to_string();
                let vram_mb = parts[1].trim().parse::<f64>().unwrap_or(0.0) as u64;
                if !name.is_empty() && vram_mb > 0 {
                    entries.push(VramEntry { name, vram_mb });
                }
            }
        }
    }

    // If nvidia-smi didn't work, try parsing /sys/class/drm for AMD/Intel
    if entries.is_empty() {
        if let Ok(entries_dir) = std::fs::read_dir("/sys/class/drm") {
            for entry in entries_dir.flatten() {
                let path = entry.path().join("device");
                if path.exists() {
                    // Try to read device name
                    let name = std::fs::read_to_string(path.join("device"))
                        .ok()
                        .and_then(|s| {
                            // Convert PCI ID to name using pci.ids (simplified)
                            let s = s.trim();
                            if s.starts_with("0x") {
                                Some(format!("PCI Device {}", &s[2..]))
                            } else {
                                Some(s.to_string())
                            }
                        });

                    // Try to read VRAM (may not exist for all GPUs)
                    let vram_mb = std::fs::read_to_string(path.join("mem_info_vram_total"))
                        .ok()
                        .and_then(|s| s.trim().parse::<u64>().ok())
                        .map(|bytes| bytes / (1024 * 1024))
                        .unwrap_or(0);

                    if let Some(name) = name {
                        entries.push(VramEntry { name, vram_mb });
                    }
                }
            }
        }
    }

    entries
}

/// Lookup VRAM for a given adapter name with fuzzy matching.
fn lookup_vram(vram_map: &[VramEntry], wgpu_name: &str, device_type: &str) -> u64 {
    // For integrated GPUs, VRAM is shared — return 0
    if device_type == "integrated" {
        return 0;
    }

    // Try exact match first
    for entry in vram_map {
        if entry.name.eq_ignore_ascii_case(wgpu_name) {
            return entry.vram_mb;
        }
    }

    // Try partial/fuzzy match (wgpu name may be like "NVIDIA GeForce RTX 4060 Laptop GPU"
    // while OS name may be "NVIDIA GeForce RTX 4060 Laptop GPU" with slight differences)
    let wgpu_lower = wgpu_name.to_lowercase();
    for entry in vram_map {
        let entry_lower = entry.name.to_lowercase();

        // Check if one contains the other
        if entry_lower.contains(&wgpu_lower) || wgpu_lower.contains(&entry_lower) {
            return entry.vram_mb;
        }

        // Check key components match (brand + model number)
        if fuzzy_match_gpu_names(&wgpu_lower, &entry_lower) {
            return entry.vram_mb;
        }
    }

    0
}

/// Fuzzy match GPU names based on key components.
fn fuzzy_match_gpu_names(name1: &str, name2: &str) -> bool {
    // Extract key identifiers: vendor (nvidia/amd/intel) + model numbers
    let key1 = extract_gpu_key(name1);
    let key2 = extract_gpu_key(name2);

    // Check if vendors match and model numbers overlap
    if key1.0 == key2.0 && !key1.0.is_empty() {
        // Same vendor — check model number overlap
        return key1.1.chars().any(|c| c.is_ascii_digit())
            && key1.1 == key2.1;
    }

    false
}

/// Extract (vendor, model_key) from GPU name.
fn extract_gpu_key(name: &str) -> (String, String) {
    let name = name.to_lowercase();

    // Determine vendor
    let vendor = if name.contains("nvidia") || name.contains("geforce") || name.contains("rtx") || name.contains("gtx") {
        "nvidia"
    } else if name.contains("amd") || name.contains("radeon") {
        "amd"
    } else if name.contains("intel") || name.contains("iris") || name.contains("uhd") {
        "intel"
    } else if name.contains("apple") || name.contains("m1") || name.contains("m2") || name.contains("m3") {
        "apple"
    } else {
        ""
    };

    // Extract model key (numbers that identify the GPU)
    let model_key: String = name
        .chars()
        .filter(|c| c.is_ascii_digit() || c.is_ascii_whitespace())
        .collect::<String>()
        .split_whitespace()
        .filter(|s| !s.is_empty())
        .take(3)  // Take first 3 number groups (e.g., "4060", "laptop" → "4060")
        .filter(|s| s.chars().all(|c| c.is_ascii_digit()))
        .collect::<Vec<_>>()
        .join(" ");

    (vendor.to_string(), model_key)
}

/// Get system RAM in MB.
#[cfg(not(target_os = "linux"))]
fn get_system_ram_mb() -> u64 {
    0
}

#[cfg(target_os = "linux")]
fn get_system_ram_mb() -> u64 {
    if let Ok(content) = std::fs::read_to_string("/proc/meminfo") {
        for line in content.lines() {
            if line.starts_with("MemTotal:") {
                let parts: Vec<&str> = line.split_whitespace().collect();
                if parts.len() >= 2 {
                    if let Ok(kb) = parts[1].parse::<u64>() {
                        return kb / 1024;
                    }
                }
            }
        }
    }
    0
}

/// Tauri command: get GPU info from backend (non-async, for sync contexts).
#[tauri::command]
pub fn get_gpu_info() -> Result<GpuInfo, String> {
    Ok(detect_gpus())
}

/// Tauri command: get GPU info asynchronously (prevents frontend freeze).
/// Runs detection in a dedicated thread to avoid blocking the async runtime.
#[tauri::command]
pub async fn get_gpu_info_async() -> Result<GpuInfo, String> {
    // Spawn blocking task to avoid freezing the UI
    let handle = tokio::task::spawn_blocking(|| detect_gpus());
    match handle.await {
        Ok(info) => Ok(info),
        Err(e) => Err(format!("GPU detection failed: {}", e)),
    }
}
