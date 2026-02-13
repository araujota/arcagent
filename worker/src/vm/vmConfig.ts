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
  /** Vsock port the guest agent listens on. */
  vsockPort: number;
  /** Allowed egress domains for this language's package registry. */
  allowedDomains: string[];
}

// ---------------------------------------------------------------------------
// Configurations
// ---------------------------------------------------------------------------

/** Common domains allowed for all languages. */
const COMMON_DOMAINS = [
  "github.com",
  "*.github.com",
  "objects.githubusercontent.com",
];

const configs: Record<string, VMResourceConfig> = {
  typescript: {
    rootfsImage: "node-20.ext4",
    vcpuCount: 2,
    memSizeMib: 1024,
    defaultGateTimeoutMs: 120_000,
    vsockPort: 5000,
    allowedDomains: [...COMMON_DOMAINS, "registry.npmjs.org", "*.npmjs.org"],
  },
  javascript: {
    rootfsImage: "node-20.ext4",
    vcpuCount: 2,
    memSizeMib: 1024,
    defaultGateTimeoutMs: 120_000,
    vsockPort: 5000,
    allowedDomains: [...COMMON_DOMAINS, "registry.npmjs.org", "*.npmjs.org"],
  },
  python: {
    rootfsImage: "python-312.ext4",
    vcpuCount: 2,
    memSizeMib: 1024,
    defaultGateTimeoutMs: 120_000,
    vsockPort: 5000,
    allowedDomains: [...COMMON_DOMAINS, "pypi.org", "*.pypi.org", "files.pythonhosted.org"],
  },
  rust: {
    rootfsImage: "rust-stable.ext4",
    vcpuCount: 4,
    memSizeMib: 2048,
    defaultGateTimeoutMs: 300_000,
    vsockPort: 5000,
    allowedDomains: [...COMMON_DOMAINS, "crates.io", "*.crates.io", "static.crates.io"],
  },
  go: {
    rootfsImage: "go-122.ext4",
    vcpuCount: 2,
    memSizeMib: 1024,
    defaultGateTimeoutMs: 120_000,
    vsockPort: 5000,
    allowedDomains: [...COMMON_DOMAINS, "proxy.golang.org", "sum.golang.org", "storage.googleapis.com"],
  },
  java: {
    rootfsImage: "java-21.ext4",
    vcpuCount: 4,
    memSizeMib: 2048,
    defaultGateTimeoutMs: 180_000,
    vsockPort: 5000,
    allowedDomains: [...COMMON_DOMAINS, "repo1.maven.org", "*.maven.org", "plugins.gradle.org", "services.gradle.org"],
  },
  ruby: {
    rootfsImage: "ruby-33.ext4",
    vcpuCount: 2,
    memSizeMib: 1024,
    defaultGateTimeoutMs: 120_000,
    vsockPort: 5000,
    allowedDomains: [...COMMON_DOMAINS, "rubygems.org", "*.rubygems.org"],
  },
  php: {
    rootfsImage: "php-84.ext4",
    vcpuCount: 2,
    memSizeMib: 1024,
    defaultGateTimeoutMs: 120_000,
    vsockPort: 5000,
    allowedDomains: [...COMMON_DOMAINS, "packagist.org", "*.packagist.org", "repo.packagist.org"],
  },
  csharp: {
    rootfsImage: "dotnet-9.ext4",
    vcpuCount: 4,
    memSizeMib: 2048,
    defaultGateTimeoutMs: 180_000,
    vsockPort: 5000,
    allowedDomains: [...COMMON_DOMAINS, "api.nuget.org", "*.nuget.org"],
  },
  c: {
    rootfsImage: "cpp-gcc14.ext4",
    vcpuCount: 2,
    memSizeMib: 1024,
    defaultGateTimeoutMs: 180_000,
    vsockPort: 5000,
    allowedDomains: [...COMMON_DOMAINS],
  },
  cpp: {
    rootfsImage: "cpp-gcc14.ext4",
    vcpuCount: 4,
    memSizeMib: 2048,
    defaultGateTimeoutMs: 300_000,
    vsockPort: 5000,
    allowedDomains: [...COMMON_DOMAINS, "conan.io", "*.conan.io"],
  },
  swift: {
    rootfsImage: "swift-6.ext4",
    vcpuCount: 4,
    memSizeMib: 2048,
    defaultGateTimeoutMs: 180_000,
    vsockPort: 5000,
    allowedDomains: [...COMMON_DOMAINS, "swift.org"],
  },
  kotlin: {
    rootfsImage: "kotlin-jvm21.ext4",
    vcpuCount: 4,
    memSizeMib: 2048,
    defaultGateTimeoutMs: 180_000,
    vsockPort: 5000,
    allowedDomains: [...COMMON_DOMAINS, "repo1.maven.org", "*.maven.org", "plugins.gradle.org", "services.gradle.org"],
  },
};

/** Fallback configuration used when the language is unrecognised. */
const defaultConfig: VMResourceConfig = {
  rootfsImage: "base.ext4",
  vcpuCount: 2,
  memSizeMib: 512,
  defaultGateTimeoutMs: 120_000,
  vsockPort: 5000,
  allowedDomains: [...COMMON_DOMAINS],
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
