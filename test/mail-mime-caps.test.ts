// Sender-controlled header values are capped before decoding and address parsing (main-thread cost).

import { describe, expect, it } from "vitest";
import { MAX_HEADER_CHARS, parse, parseAddresses, summarize } from "../server/google/mime.ts";
import type { GmailMessage } from "../server/google/types.ts";

const time = (fn: () => unknown) => {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
};

describe("header caps", () => {
  const groups = "g:".repeat(200_000) + "a@b.example;";
  const msg = (from: string): GmailMessage => ({
    id: "m1",
    threadId: "t1",
    labelIds: ["INBOX"],
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: from },
        { name: "To", value: groups },
        { name: "Cc", value: groups },
        { name: "Subject", value: "=?UTF-8?B?SGk=?= ".repeat(50_000) },
      ],
      body: { size: 2, data: Buffer.from("hi").toString("base64url") },
    },
  });

  it("bounds address parsing of heavy group syntax", () => {
    parseAddresses(groups);
    expect(time(() => parseAddresses(groups))).toBeLessThan(100);
  });

  it("bounds summarize/parse of a message with huge headers", () => {
    const m = msg("Alice <alice@client.example>");
    summarize(m);
    expect(time(() => summarize(m))).toBeLessThan(150);
    expect(time(() => parse(m))).toBeLessThan(150);
    expect(summarize(m).from).toEqual({ name: "Alice", email: "alice@client.example" });
    expect(summarize(m).subject.length).toBeLessThanOrEqual(MAX_HEADER_CHARS);
  });

  it("keeps normal headers intact", () => {
    expect(parseAddresses('"Bob, Jr." <bob@x.example>, carol@y.example')).toEqual([
      { name: "Bob, Jr.", email: "bob@x.example" },
      { name: null, email: "carol@y.example" },
    ]);
  });
});
