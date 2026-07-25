import { describe, expect, it } from "vitest";
import { isPrivateIpv4, safeUrl } from "../src/ssrf";

describe("isPrivateIpv4", () => {
  it("rejects loopback, private, link-local, CGNAT, and multicast ranges", () => {
    for (const host of [
      "0.0.0.0",
      "10.1.2.3",
      "127.0.0.1",
      "169.254.169.254", // cloud metadata
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "100.64.0.1",
      "224.0.0.1",
      "255.255.255.255"
    ]) {
      expect(isPrivateIpv4(host), host).toBe(true);
    }
  });

  it("accepts ordinary public addresses", () => {
    for (const host of ["8.8.8.8", "1.1.1.1", "172.15.0.1", "172.32.0.1", "100.63.0.1"]) {
      expect(isPrivateIpv4(host), host).toBe(false);
    }
  });

  it("rejects malformed octets and wrong-length addresses", () => {
    for (const host of ["1.2.3", "1.2.3.4.5", "1.2.3.999", "a.b.c.d", "1.2.3.-1"]) {
      expect(isPrivateIpv4(host), host).toBe(true);
    }
  });
});

describe("safeUrl", () => {
  it("returns the normalized URL for a public https target", () => {
    expect(safeUrl("https://acme.wd1.myworkdayjobs.com/en-US/careers/job/1")).toBe(
      "https://acme.wd1.myworkdayjobs.com/en-US/careers/job/1"
    );
  });

  it("allows plain http", () => {
    expect(safeUrl("http://example.com/")).toBe("http://example.com/");
  });

  it("rejects non-http schemes", () => {
    for (const raw of [
      "file:///etc/passwd",
      "ftp://example.com",
      "javascript:alert(1)",
      "data:text/html,x"
    ]) {
      expect(safeUrl(raw), raw).toBeNull();
    }
  });

  it("rejects unparseable input", () => {
    expect(safeUrl("not a url")).toBeNull();
    expect(safeUrl("")).toBeNull();
  });

  it("rejects localhost and its subdomains", () => {
    expect(safeUrl("http://localhost:8080/")).toBeNull();
    expect(safeUrl("http://foo.localhost/")).toBeNull();
  });

  it("rejects metadata and .internal hosts", () => {
    expect(safeUrl("http://metadata/")).toBeNull();
    expect(safeUrl("http://metadata.google.internal/")).toBeNull();
    expect(safeUrl("http://anything.internal/")).toBeNull();
  });

  it("rejects IPv6 literals outright", () => {
    expect(safeUrl("http://[::1]/")).toBeNull();
    expect(safeUrl("http://[fd00::1]/")).toBeNull();
  });

  it("rejects private IPv4 literals but allows public ones", () => {
    expect(safeUrl("http://127.0.0.1/")).toBeNull();
    expect(safeUrl("http://169.254.169.254/latest/meta-data/")).toBeNull();
    expect(safeUrl("http://8.8.8.8/")).toBe("http://8.8.8.8/");
  });
});
