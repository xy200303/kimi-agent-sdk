const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const TARGETS = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-x64", "win32-arm64"];
const REQUIRED_DIST_FILES = ["extension/dist/extension.js", "extension/dist/webview.js"];

function getVsixFile(target) {
  return `spec-kimi-${target}.vsix`;
}

function listZipEntries(filePath) {
  return execFileSync("unzip", ["-Z1", filePath], {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  })
    .split(/\r?\n/)
    .filter(Boolean);
}

function readZipEntry(filePath, entry) {
  try {
    return execFileSync("unzip", ["-p", filePath, entry], {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    throw new Error(`Missing or unreadable ${entry}`);
  }
}

function readJsonEntry(filePath, entry) {
  const content = readZipEntry(filePath, entry);
  try {
    return JSON.parse(content);
  } catch (error) {
    throw new Error(`${entry} is not valid JSON: ${error.message}`);
  }
}

function verifyVsixFiles(rootDir, targets = TARGETS) {
  const packageJson = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8"));
  const expectedExtensionVersion = packageJson.version;
  const failures = [];
  const lines = [];

  for (const target of targets) {
    const file = getVsixFile(target);
    const filePath = path.join(rootDir, file);

    try {
      if (!fs.existsSync(filePath)) {
        throw new Error("file does not exist");
      }

      const bundledPackage = readJsonEntry(filePath, "extension/package.json");
      if (bundledPackage.version !== expectedExtensionVersion) {
        throw new Error(`extension version is ${bundledPackage.version}, expected ${expectedExtensionVersion}`);
      }

      const entries = listZipEntries(filePath);
      for (const entry of REQUIRED_DIST_FILES) {
        if (!entries.includes(entry)) {
          throw new Error(`Missing ${entry}`);
        }
      }
      if (entries.some((entry) => entry.startsWith("extension/bin/kimi/"))) {
        throw new Error("VSIX must not include a bundled Spec Kimi CLI");
      }

      lines.push(`${file}: extension ${bundledPackage.version}, ${target}, extension.js/webview.js OK, no bundled CLI`);
    } catch (error) {
      failures.push(`${file}: ${error.message}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(`VSIX verification failed:\n${failures.map((failure) => `  - ${failure}`).join("\n")}`);
  }

  console.log("\nVerified VSIX packages:");
  lines.forEach((line) => console.log(`  - ${line}`));

  return { extensionVersion: expectedExtensionVersion };
}

module.exports = {
  TARGETS,
  getVsixFile,
  verifyVsixFiles,
};

if (require.main === module) {
  const rootDir = path.join(__dirname, "..");
  const args = process.argv.slice(2);
  const targets = args.length === 0 || args.includes("all") ? TARGETS : args;

  for (const target of targets) {
    if (!TARGETS.includes(target)) {
      console.error(`Unknown target: ${target}`);
      console.error(`Expected one of: ${TARGETS.join(", ")}`);
      process.exit(1);
    }
  }

  try {
    const { extensionVersion } = verifyVsixFiles(rootDir, targets);
    if (process.env.GITHUB_OUTPUT) {
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `artifact_name=spec-kimi-vsix-${extensionVersion}\n`);
    }
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
