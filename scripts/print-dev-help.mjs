// Root `pnpm dev` help. Prints the available dev entrypoints so a
// developer landing on the repo can pick the surface they want to run
// without reading the README first.

const SECTIONS = [
  {
    title: "First-time setup",
    items: [
      ["pnpm install", "Install workspaces."],
      ["pnpm build", "Compile every TypeScript package via `tsc -b`."],
      ["pnpm test", "Run the full Vitest suite (incl. property-based tests)."],
      ["pnpm lint", "Run ESLint across the workspace."],
    ],
  },
  {
    title: "Run a UI surface",
    items: [
      [
        "pnpm dev:desktop",
        "Renderer-only Vite server for the Windows Desktop App " +
          "(http://localhost:1420). No Rust toolchain required.",
      ],
      [
        "pnpm desktop:dev",
        "Full Tauri shell for the Windows Desktop App. Requires Rust + " +
          "MSVC build tools (see apps/desktop-windows/RELEASING.md).",
      ],
      [
        "pnpm dev:web",
        "Web App on Vite (http://localhost:5173). Mounts the shared-ui " +
          "screens with placeholder gateways.",
      ],
      [
        "pnpm dev:backend",
        "Backend dev health server on http://127.0.0.1:4000 — " +
          "/health, /ready, /version endpoints.",
      ],
    ],
  },
  {
    title: "Build & ship",
    items: [
      [
        "pnpm desktop:build",
        "Build Windows installers (MSI + NSIS). Requires Rust + signing " +
          "key, see apps/desktop-windows/RELEASING.md.",
      ],
    ],
  },
];

function pad(s, width) {
  return s + " ".repeat(Math.max(0, width - s.length));
}

const COMMAND_WIDTH = 24;

console.log("");
console.log("AI Agent Orchestrator — root dev commands");
console.log("=========================================");
for (const section of SECTIONS) {
  console.log("");
  console.log(section.title);
  console.log("-".repeat(section.title.length));
  for (const [cmd, desc] of section.items) {
    console.log(`  ${pad(cmd, COMMAND_WIDTH)} ${desc}`);
  }
}
console.log("");
console.log("Tip: pick the surface you want and run that script directly.");
console.log("");
