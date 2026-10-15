import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { launchdLabel, launchdListenPlist, systemdListenUnit, unitName } from "../server/listen/service.ts";
import { FAKE_KEY, isolateXdg } from "./listen-client-fake.ts";

let env: ReturnType<typeof isolateXdg>;
beforeEach(() => {
  env = isolateXdg();
});
afterEach(() => env.restore());

describe("listener service units", () => {
  it("systemd: one unit per profile, runs the stable install, keeps the key out, doesn't restart on revocation", () => {
    process.env.AGENTINBOX_TEST_SECRET_IN_ENV = FAKE_KEY;
    try {
      const unit = systemdListenUnit("work", "/home/u/.local/share/agentinbox/listen-app/node_modules/agentinbox-cli/dist/cli.js", "/home/u/projects/100%");
      expect(unitName("work")).toBe("agentinbox-listen-work");
      expect(unit).toContain(`ExecStart="${process.execPath}" "/home/u/.local/share/agentinbox/listen-app/node_modules/agentinbox-cli/dist/cli.js" listen --profile work`);
      expect(unit).toContain("WorkingDirectory=/home/u/projects/100%%");
      expect(unit).toContain("Restart=on-failure");
      expect(unit).toContain("RestartPreventExitStatus=78");
      expect(unit).toContain('Environment="AGENTINBOX_SERVICE=1"');
      expect(unit).toMatch(/Environment="PATH=/);
      expect(unit).toContain(`Environment="XDG_CONFIG_HOME=${process.env.XDG_CONFIG_HOME}"`);
      expect(unit).not.toContain(FAKE_KEY);
      expect(unit).not.toContain("_npx");
    } finally {
      delete process.env.AGENTINBOX_TEST_SECRET_IN_ENV;
    }
  });

  it("launchd: label per profile, restarts only on failure, escapes XML", () => {
    const plist = launchdListenPlist("default", "/opt/a&b/cli.js", "/Users/u");
    expect(launchdLabel("default")).toBe("com.unlaboredlabs.agentinbox.listen.default");
    expect(plist).toContain("<string>com.unlaboredlabs.agentinbox.listen.default</string>");
    expect(plist).toContain("<string>/opt/a&amp;b/cli.js</string>");
    expect(plist).toContain("<key>SuccessfulExit</key><false/>");
    expect(plist).toContain("<string>--profile</string>\n    <string>default</string>");
  });
});
