// The console's Extensions page decisions (src/components/extensions/extension-logic.ts) on the /api/extensions DTOs.
import { describe, expect, it } from "vitest";
import type { ExtensionRegistryEntryView, ExtensionView } from "../shared/extensions.ts";
import { originView, registryAction, shortCommit, updateRows, usedByLabel } from "../src/components/extensions/extension-logic.ts";

const ext = (patch: Partial<ExtensionView> = {}): ExtensionView => ({
  name: "whoop",
  displayName: "WHOOP",
  description: "",
  kind: "code",
  version: "1.0.0",
  source: "whoop",
  commit: "a".repeat(40),
  integrity: `sha256-${"A".repeat(43)}=`,
  official: true,
  network: ["api.prod.whoop.com"],
  usedBy: [],
  installedAt: "2026-10-16T00:00:00.000Z",
  ...patch,
});

const entry = (patch: Partial<ExtensionRegistryEntryView> = {}): ExtensionRegistryEntryView => ({
  name: "whoop",
  displayName: "WHOOP",
  description: "",
  kind: "code",
  version: "1.0.0",
  commit: "a".repeat(40),
  integrity: `sha256-${"A".repeat(43)}=`,
  installed: null,
  ...patch,
});

describe("Extensions page", () => {
  it("shows official or third-party, the short commit and who uses it", () => {
    expect(originView(ext())).toEqual({ label: "Official", tone: "good" });
    expect(originView(ext({ official: false }))).toEqual({ label: "Third-party", tone: "warn" });
    expect(shortCommit("0123456789abcdef0123456789abcdef01234567")).toBe("0123456789ab");
    expect(shortCommit(null)).toBe("local directory");
    expect(usedByLabel([])).toBe("No connections");
    expect(usedByLabel(["whoop", "whoop-2"])).toBe("whoop, whoop-2");
  });

  it("offers install, update or nothing for a registry entry", () => {
    expect(registryAction(entry())).toBe("install");
    expect(registryAction(entry({ installed: { version: "1.0.0", integrity: entry().integrity, official: true } }))).toBe("installed");
    expect(registryAction(entry({ installed: { version: "0.9.0", integrity: `sha256-${"B".repeat(43)}=`, official: true } }))).toBe("update");
    expect(registryAction(entry({ installed: { version: "1.0.0", integrity: entry().integrity, official: false } }))).toBe("conflict");
  });

  it("the update diff: version, commit and integrity always; kind, source and hosts when they change", () => {
    const from = ext();
    const to = ext({ version: "1.1.0", commit: "b".repeat(40), integrity: `sha256-${"B".repeat(43)}=`, network: ["api.prod.whoop.com", "new.example"] });
    expect(updateRows(from, to)).toEqual([
      { label: "Version", from: "1.0.0", to: "1.1.0", changed: true },
      { label: "Commit", from: "aaaaaaaaaaaa", to: "bbbbbbbbbbbb", changed: true },
      { label: "Integrity", from: from.integrity, to: to.integrity, changed: true },
      { label: "Network hosts", from: "api.prod.whoop.com", to: "api.prod.whoop.com, new.example", changed: true },
    ]);
    expect(updateRows(from, ext({ kind: "remote", network: [] })).map((r) => r.label)).toEqual(["Version", "Commit", "Integrity", "Kind", "Network hosts"]);
    expect(updateRows(from, ext({ version: "1.0.1" })).filter((r) => r.changed).map((r) => r.label)).toEqual(["Version"]);
  });
});
