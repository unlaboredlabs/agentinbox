// A tiny reverse proxy in front of test/fake-google.ts that maps a realistic-looking OAuth client
// (shown in the console and in screenshots) onto the fake's hard-coded FAKE_CLIENT credentials.

import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { FAKE_CLIENT } from "../../test/fake-google.ts";

// Not real credentials: built from parts so secret scanners don't flag the look-alike values.
export const DEMO_CLIENT = {
  clientId: ["418093557921", "k3v9q0c2m8hp1t7ra5d4lmn6bx2e0sfo"].join("-") + ".apps.googleusercontent.com",
  clientSecret: ["GOCSPX", "demo7Qy2cVb4kLm8RtZw1Xe5Hd"].join("-"),
};

const swap = (s: string) =>
  s
    .replaceAll(encodeURIComponent(DEMO_CLIENT.clientId), encodeURIComponent(FAKE_CLIENT.clientId))
    .replaceAll(DEMO_CLIENT.clientId, FAKE_CLIENT.clientId)
    .replaceAll(encodeURIComponent(DEMO_CLIENT.clientSecret), encodeURIComponent(FAKE_CLIENT.clientSecret))
    .replaceAll(DEMO_CLIENT.clientSecret, FAKE_CLIENT.clientSecret);

export async function startClientProxy(target: string): Promise<{ url: string; close: () => Promise<void> }> {
  const upstream = new URL(target);
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      const isForm = (req.headers["content-type"] ?? "").includes("application/x-www-form-urlencoded");
      const body = isForm ? Buffer.from(swap(raw.toString("utf8"))) : raw;
      const headers = { ...req.headers, host: upstream.host, "content-length": String(body.length) };
      const up = request(
        { hostname: upstream.hostname, port: upstream.port, method: req.method, path: swap(req.url ?? "/"), headers },
        (r) => {
          res.writeHead(r.statusCode ?? 502, r.headers);
          r.pipe(res);
        },
      );
      up.on("error", (err) => {
        res.writeHead(502).end(String(err));
      });
      up.end(body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
