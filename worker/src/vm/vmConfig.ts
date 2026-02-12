/**
 * VM resource configuration per language / runtime.
 *
 * Each config specifies the rootfs image to use and the compute resources
 * allocated to the Firecracker microVM.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VMResourceConfig {
  /** Name of the rootfs ext4 image in the rootfs directory. */
  rootfsImage: string;
  /** Number of virtual CPUs to allocate. */
  vcpuCount: number;
  /** Memory in MiB to allocate. */
  memSizeMib: number;
  /** Default per-gate timeout in milliseconds. */
  defaultGateTimeoutMs: number;
}

// ---------------------------------------------------------------------------
// Configurations
// ---------------------------------------------------------------------------

const configs: Record<string, VMResourceConfig> = {
  typescript: {
    rootfsImage: "node-20.ext4",
    vcpuCount: 2,
    memSizeMib: 1024,
    defaultGateTimeoutMs: 120_000,
  },
  javascript: {
    rootfsImage: "node-20.ext4",
    vcpuCount: 2,
    memSizeMib: 1024,
    defaultGateTimeoutMs: 120_000,
  },
  python: {
    rootfsImage: "python-312.ext4",
    vcpuCount: 2,
    memSizeMib: 1024,
    defaultGateTimeoutMs: 120_000,
  },
  rust: {
    rootfsImage: "rust-stable.ext4",
    vcpuCount: 4,
    memSizeMib: 2048,
    defaultGateTimeoutMs: 300_000,
  },
  go: {
    rootfsImage: "go-122.ext4",
    vcpuCount: 2,
    memSizeMib: 1024,
    defaultGateTimeoutMs: 120_000,
  },
  java: {
    rootfsImage: "java-21.ext4",
    vcpuCount: 4,
    memSizeMib: 2048,
    defaultGateTimeoutMs: 180_000,
  },
  ruby: {
    rootfsImage: "ruby-33.ext4",
    vcpuCount: 2,
    memSizeMib: 1024,
    defaultGateTimeoutMs: 120_000,
  },
  php: {
    rootfsImage: "php-84.ext4",
    vcpuCount: 2,
    memSizeMib: 1024,
    defaultGateTimeoutMs: 120_000,
  },
  csharp: {
    rootfsImage: "dotnet-9.ext4",
    vcpuCount: 4,
    memSizeMib: 2048,
    defaultGateTimeoutMs: 180_000,
  },
  c: {
    rootfsImage: "cpp-gcc14.ext4",
    vcpuCount: 2,
    memSizeMib: 1024,
    defaultGateTimeoutMs: 180_000,
  },
  cpp: {
    rootfsImage: "cpp-gcc14.ext4",
    vcpuCount: 4,
    memSizeMib: 2048,
    defaultGateTimeoutMs: 300_000,
  },
  swift: {
    rootfsImage: "swift-6.ext4",
    vcpuCount: 4,
    memSizeMib: 2048,
    defaultGateTimeoutMs: 180_000,
  },
  kotlin: {
    rootfsImage: "kotlin-jvm21.ext4",
    vcpuCount: 4,
    memSizeMib: 2048,
    defaultGateTimeoutMs: 180_000,
  },
};

/** Fallback configuration used when the language is unrecognised. */
const defaultConfig: VMResourceConfig = {
  rootfsImage: "base.ext4",
  vcpuCount: 2,
  memSizeMib: 512,
  defaultGateTimeoutMs: 120_000,
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Return the VM resource configuration for the given language.
 * Falls back to a minimal base image if the language is unknown.
 */
export function getVMConfig(language: string): VMResourceConfig {
  const normalised = language.toLowerCase().trim();
  return configs[normalised] ?? defaultConfig;
}

/**
 * Return the list of supported language keys.
 */
export function getSupportedLanguages(): string[] {
  return Object.keys(configs);
}
