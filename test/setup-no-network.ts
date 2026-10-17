// Tests never reach the real network. A fetch to anything but loopback fails at once, the way it does offline,
// so code that quietly tolerates network errors (the registry check for third-party names) can't call GitHub from CI.
// Unroutable test addresses (192.0.2.0/24, *.test) are refused too, which is what those tests expect anyway.

const real = globalThis.fetch;
const LOOPBACK = /^(127\.\d+\.\d+\.\d+|localhost|\[::1\])$/;

globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (!LOOPBACK.test(url.hostname)) return Promise.reject(new TypeError(`fetch failed: tests don't reach ${url.host}`));
  return real(input, init);
};
