//! Hardware detection utility for embedding configuration.
//! Combines frontend browser APIs with Tauri backend GPU detection.

import { invoke } from '@tauri-apps/api/core';

/** GPU adapter info from backend. */
export interface GpuAdapterInfo {
  name: string;
  device_type: 'discrete' | 'integrated' | 'cpu' | 'virtual' | 'unknown';
  vram_mb: number;
  backend: string;
  is_webgpu_compatible: boolean;
}

/** Overall GPU detection result. */
export interface GpuInfo {
  adapters: GpuAdapterInfo[];
  recommended_adapter_index: number | null;
  system_ram_mb: number;
}

/** Combined hardware profile for recommendation. */
export interface HardwareProfile {
  /** Whether WebGPU is available in browser. */
  webgpuSupported: boolean;
  /** Device memory in GB (from navigator.deviceMemory, 0 if unavailable). */
  deviceMemoryGB: number;
  /** CPU logical core count. */
  cpuCores: number;
  /** Backend GPU info (null if Tauri unavailable). */
  gpuInfo: GpuInfo | null;
  /** Best GPU for compute (null if none). */
  bestGpu: GpuAdapterInfo | null;
}

/** Recommended embedding configuration. */
export interface RecommendedConfig {
  /** Recommended inference backend. */
  backend: 'webgpu' | 'wasm';
  /** Recommended batch size for indexing. */
  batchSize: number;
  /** Human-readable explanation of the recommendation. */
  reason: { zh: string; en: string };
  /** Whether this is based on GPU detection or fallback heuristics. */
  precise: boolean;
}

/**
 * Detect hardware capabilities from both frontend and backend.
 * Never throws — returns best-effort results on any failure.
 */
export async function detectHardware(): Promise<HardwareProfile> {
  // Frontend quick detection
  const webgpuSupported = !!navigator.gpu;
  const deviceMemoryGB = (navigator as any).deviceMemory || 0;
  const cpuCores = navigator.hardwareConcurrency || 0;

  // Backend precise detection (use async command to prevent frontend freeze)
  let gpuInfo: GpuInfo | null = null;
  try {
    gpuInfo = await invoke<GpuInfo>('get_gpu_info_async');
  } catch {
    // Async command not available, try sync fallback
    try {
      gpuInfo = await invoke<GpuInfo>('get_gpu_info');
    } catch {
      // Tauri not available (e.g. browser preview) — use frontend-only
    }
  }

  // Determine best GPU
  let bestGpu: GpuAdapterInfo | null = null;
  if (gpuInfo && gpuInfo.recommended_adapter_index !== null) {
    bestGpu = gpuInfo.adapters[gpuInfo.recommended_adapter_index] ?? null;
  }

  return {
    webgpuSupported,
    deviceMemoryGB,
    cpuCores,
    gpuInfo,
    bestGpu,
  };
}

/**
 * Generate recommended embedding config based on hardware profile.
 */
export function recommendConfig(profile: HardwareProfile): RecommendedConfig {
  const { webgpuSupported, deviceMemoryGB, bestGpu } = profile;

  // No GPU or no WebGPU support → WASM fallback
  if (!webgpuSupported || !bestGpu) {
    const ram = deviceMemoryGB || 8;
    return {
      backend: 'wasm',
      batchSize: ram >= 8 ? 8 : 4,
      reason: {
        zh: webgpuSupported ? '未检测到独立/集成显卡，使用 WASM CPU 推理' : '浏览器不支持 WebGPU，回退到 WASM CPU 推理',
        en: webgpuSupported ? 'No dedicated/integrated GPU detected, using WASM CPU inference' : 'WebGPU not supported in browser, falling back to WASM CPU inference',
      },
      precise: false,
    };
  }

  // Discrete GPU — recommend based on VRAM
  if (bestGpu.device_type === 'discrete') {
    const vramGB = bestGpu.vram_mb / 1024;
    let batchSize: number;
    let label: { zh: string; en: string };

    if (vramGB >= 8) {
      batchSize = 32;
      label = { zh: '高性能独显', en: 'High-end GPU' };
    } else if (vramGB >= 4) {
      batchSize = 16;
      label = { zh: '中端独显', en: 'Mid-range GPU' };
    } else {
      batchSize = 8;
      label = { zh: '入门级独显', en: 'Entry-level GPU' };
    }

    return {
      backend: 'webgpu',
      batchSize,
      reason: {
        zh: `检测到${label.zh}（${formatVRAM(bestGpu.vram_mb)}），启用 WebGPU 加速`,
        en: `Detected ${label.en} (${formatVRAM(bestGpu.vram_mb)}), enabling WebGPU acceleration`,
      },
      precise: true,
    };
  }

  // Integrated GPU — use system RAM as guidance
  if (bestGpu.device_type === 'integrated') {
    const ram = deviceMemoryGB || 8;
    return {
      backend: 'webgpu',
      batchSize: ram >= 8 ? 16 : 8,
      reason: {
        zh: '检测到核显（共享系统内存），使用 WebGPU 加速',
        en: 'Integrated GPU detected (shared memory), using WebGPU acceleration',
      },
      precise: true,
    };
  }

  // Unknown GPU type — conservative
  return {
    backend: webgpuSupported ? 'webgpu' : 'wasm',
    batchSize: 8,
    reason: {
      zh: '检测到图形设备，使用保守配置',
      en: 'Graphics device detected, using conservative configuration',
    },
    precise: false,
  };
}

/**
 * Format VRAM for display.
 */
export function formatVRAM(mb: number): string {
  if (mb >= 1024) {
    return `${(mb / 1024).toFixed(1)} GB`;
  }
  return `${mb} MB`;
}

/**
 * Get device type display label.
 */
export function getDeviceTypeLabel(type: string, isZh: boolean): string {
  const labels: Record<string, { zh: string; en: string }> = {
    discrete: { zh: '独立显卡', en: 'Discrete GPU' },
    integrated: { zh: '集成显卡', en: 'Integrated GPU' },
    cpu: { zh: '软件渲染', en: 'Software' },
    virtual: { zh: '虚拟 GPU', en: 'Virtual GPU' },
    unknown: { zh: '未知设备', en: 'Unknown' },
  };
  return labels[type]?.[isZh ? 'zh' : 'en'] || type;
}

/**
 * Get a user-friendly GPU summary string for UI display.
 */
export function getGpuSummary(profile: HardwareProfile, isZh: boolean): string {
  const { bestGpu, webgpuSupported } = profile;

  if (!bestGpu) {
    return webgpuSupported
      ? (isZh ? '未检测到 GPU' : 'No GPU detected')
      : (isZh ? 'WebGPU 不可用' : 'WebGPU unavailable');
  }

  const typeLabel = getDeviceTypeLabel(bestGpu.device_type, isZh);
  const vramStr = bestGpu.vram_mb > 0 ? ` · ${formatVRAM(bestGpu.vram_mb)}` : '';

  return `${typeLabel}${vramStr}`;
}
