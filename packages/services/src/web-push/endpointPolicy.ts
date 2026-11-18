import type { LookupAddress } from "node:dns";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { WebPushValidationError } from "./contract.js";

const MAX_ENDPOINT_LENGTH = 2048;

export type WebPushDnsLookup = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<LookupAddress[]>;

function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

export function isLoopbackHostname(hostname: string): boolean {
  const bare = stripIpv6Brackets(hostname.toLowerCase());
  return bare === "127.0.0.1" || bare === "::1" || bare === "localhost";
}

function parseIpv4Octets(ip: string): [number, number, number, number] | null {
  if (isIP(ip) !== 4) return null;
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => Number(part));
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return [octets[0]!, octets[1]!, octets[2]!, octets[3]!];
}

function isBlockedIpv4Octets(octets: readonly [number, number, number, number]): boolean {
  const [a, b, c] = octets;
  if (a === 0) return true; // 0.0.0.0/8 (unspecified / "this network")
  if (a === 10) return true; // 10.0.0.0/8 (RFC 1918 private)
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (CGNAT RFC 6598)
  if (a === 127) return true; // 127.0.0.0/8 (loopback)
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 (link-local & cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 (RFC 1918 private)
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24 (IETF protocol assignments)
  if (a === 192 && b === 0 && c === 2) return true; // 192.0.2.0/24 (TEST-NET-1)
  if (a === 192 && b === 88 && c === 99) return true; // 192.88.99.0/24 (6to4 relay anycast)
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 (RFC 1918 private)
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 (benchmarking)
  if (a === 198 && b === 51 && c === 100) return true; // 198.51.100.0/24 (TEST-NET-2)
  if (a === 203 && b === 0 && c === 113) return true; // 203.0.113.0/24 (TEST-NET-3)
  if (a >= 224) return true; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved & broadcast
  return false;
}

function parseIpv6Hextets(ip: string): number[] | null {
  if (ip.includes("%")) return null;
  const doubleColonParts = ip.split("::");
  if (doubleColonParts.length > 2) return null;

  const parseGroups = (segment: string): number[] | null => {
    if (!segment) return [];
    const tokens = segment.split(":");
    const groups: number[] = [];
    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i]!;
      if (token.includes(".")) {
        if (i !== tokens.length - 1) return null;
        const ipv4 = parseIpv4Octets(token);
        if (!ipv4) return null;
        groups.push((ipv4[0] << 8) | ipv4[1], (ipv4[2] << 8) | ipv4[3]);
      } else {
        if (!/^[0-9a-fA-F]{1,4}$/.test(token)) return null;
        groups.push(Number.parseInt(token, 16));
      }
    }
    return groups;
  };

  if (doubleColonParts.length === 1) {
    const groups = parseGroups(doubleColonParts[0]!);
    return groups && groups.length === 8 ? groups : null;
  }

  const left = parseGroups(doubleColonParts[0]!);
  const right = parseGroups(doubleColonParts[1]!);
  if (!left || !right) return null;
  const missing = 8 - (left.length + right.length);
  if (missing < 1) return null;
  return [...left, ...Array.from({ length: missing }, () => 0), ...right];
}

function isBlockedIpv6Hextets(h: readonly number[]): boolean {
  // 0000::/96 (includes :: unspecified, ::1 loopback, and deprecated IPv4-compatible ::x.x.x.x)
  if (h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0) {
    return true;
  }
  // IPv4-mapped IPv6 ::ffff:0:0/96 -> extract embedded IPv4 and validate against IPv4 policy
  if (h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0xffff) {
    return isBlockedIpv4Octets([
      (h[6]! >> 8) & 0xff,
      h[6]! & 0xff,
      (h[7]! >> 8) & 0xff,
      h[7]! & 0xff,
    ]);
  }
  // NAT64 64:ff9b::/96 -> extract embedded IPv4
  if (h[0] === 0x0064 && h[1] === 0xff9b && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0) {
    return isBlockedIpv4Octets([
      (h[6]! >> 8) & 0xff,
      h[6]! & 0xff,
      (h[7]! >> 8) & 0xff,
      h[7]! & 0xff,
    ]);
  }
  // Local-use NAT64 64:ff9b:1::/48
  if (h[0] === 0x0064 && h[1] === 0xff9b && h[2] === 0x0001) return true;
  // Discard-Only 100::/64
  if (h[0] === 0x0100 && h[1] === 0 && h[2] === 0 && h[3] === 0) return true;
  // Teredo 2001::/32
  if (h[0] === 0x2001 && h[1] === 0) return true;
  // Benchmarking 2001:2::/48
  if (h[0] === 0x2001 && h[1] === 0x0002 && h[2] === 0) return true;
  // Documentation 2001:db8::/32
  if (h[0] === 0x2001 && h[1] === 0x0db8) return true;
  // Documentation 3fff::/20 (RFC 9637)
  if (h[0] === 0x3fff && (h[1]! & 0xf000) === 0) return true;
  // 6to4 2002::/16 -> inspect embedded IPv4
  if (h[0] === 0x2002) {
    return isBlockedIpv4Octets([
      (h[1]! >> 8) & 0xff,
      h[1]! & 0xff,
      (h[2]! >> 8) & 0xff,
      h[2]! & 0xff,
    ]);
  }
  // Unique Local Addresses fc00::/7
  if ((h[0]! & 0xfe00) === 0xfc00) return true;
  // Link-Local fe80::/10
  if ((h[0]! & 0xffc0) === 0xfe80) return true;
  // Deprecated Site-Local fec0::/10
  if ((h[0]! & 0xffc0) === 0xfec0) return true;
  // Multicast ff00::/8
  if ((h[0]! & 0xff00) === 0xff00) return true;
  return false;
}

export function isBlockedIpAddress(rawAddress: string): boolean {
  const bare = stripIpv6Brackets(rawAddress.trim());
  if (!bare || bare.includes("%")) return true;
  const family = isIP(bare);
  if (family === 4) {
    const octets = parseIpv4Octets(bare);
    return !octets || isBlockedIpv4Octets(octets);
  }
  if (family === 6) {
    const hextets = parseIpv6Hextets(bare);
    return !hextets || isBlockedIpv6Hextets(hextets);
  }
  return true;
}

export function isLoopbackIpAddress(rawAddress: string): boolean {
  const bare = stripIpv6Brackets(rawAddress.trim());
  if (!bare || bare.includes("%")) return false;
  const family = isIP(bare);
  if (family === 4) {
    const octets = parseIpv4Octets(bare);
    return Boolean(octets && octets[0] === 127);
  }
  if (family === 6) {
    const hextets = parseIpv6Hextets(bare);
    if (!hextets) return false;
    if (
      hextets[0] === 0 &&
      hextets[1] === 0 &&
      hextets[2] === 0 &&
      hextets[3] === 0 &&
      hextets[4] === 0 &&
      hextets[5] === 0 &&
      hextets[6] === 0 &&
      hextets[7] === 1
    ) {
      return true;
    }
    if (
      hextets[0] === 0 &&
      hextets[1] === 0 &&
      hextets[2] === 0 &&
      hextets[3] === 0 &&
      hextets[4] === 0 &&
      hextets[5] === 0xffff
    ) {
      return ((hextets[6]! >> 8) & 0xff) === 127;
    }
  }
  return false;
}

export async function resolveAndValidatePushAddresses(
  hostname: string,
  options?: {
    allowLoopback?: boolean;
    lookupImpl?: WebPushDnsLookup;
  },
): Promise<LookupAddress[]> {
  const bareHost = stripIpv6Brackets(hostname.trim());
  const allowLoopback = options?.allowLoopback === true;

  if (isIP(bareHost) !== 0) {
    const family = isIP(bareHost) as 4 | 6;
    if (allowLoopback && isLoopbackIpAddress(bareHost)) {
      return [{ address: bareHost, family }];
    }
    if (isBlockedIpAddress(bareHost)) {
      throw new WebPushValidationError(`Push endpoint resolved to blocked IP address: ${bareHost}`);
    }
    throw new WebPushValidationError("Push endpoint must not use a literal IP address");
  }

  const lookup =
    options?.lookupImpl ??
    ((host, opts) => dnsLookup(host, { ...opts, all: true, verbatim: true }));
  const addresses = await lookup(bareHost, { all: true, verbatim: true });
  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw new WebPushValidationError(`DNS lookup returned no addresses for ${bareHost}`);
  }

  for (const entry of addresses) {
    if (allowLoopback) {
      if (!isLoopbackIpAddress(entry.address)) {
        throw new WebPushValidationError(
          `Loopback endpoint resolved to non-loopback address: ${entry.address}`,
        );
      }
      continue;
    }
    if (isBlockedIpAddress(entry.address)) {
      throw new WebPushValidationError(
        `Push endpoint resolved to blocked IP address: ${entry.address}`,
      );
    }
  }

  return addresses.map((entry) => ({
    address: entry.address,
    family: entry.family === 6 ? 6 : 4,
  }));
}

export function validatePushEndpoint(
  rawEndpoint: string,
  options?: { allowLoopbackEndpoint?: boolean },
): URL {
  const trimmed = rawEndpoint.trim();
  if (!trimmed || trimmed.length > MAX_ENDPOINT_LENGTH) {
    throw new WebPushValidationError("Invalid push endpoint length");
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new WebPushValidationError("Invalid push endpoint URL");
  }

  if (url.username || url.password) {
    throw new WebPushValidationError("Push endpoint must not contain credentials");
  }

  const hostLower = url.hostname.toLowerCase();
  const bareHost = stripIpv6Brackets(hostLower);
  if (!bareHost) {
    throw new WebPushValidationError("Push endpoint host is missing");
  }

  const allowLoopback = options?.allowLoopbackEndpoint === true;
  if (allowLoopback && isLoopbackHostname(hostLower)) {
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new WebPushValidationError("Loopback push endpoint must use http: or https:");
    }
    return url;
  }

  if (url.protocol !== "https:") {
    throw new WebPushValidationError("Push endpoint must use https:");
  }

  if (isIP(bareHost) !== 0) {
    throw new WebPushValidationError("Push endpoint must not use a literal IP address");
  }

  if (
    bareHost === "localhost" ||
    bareHost.endsWith(".localhost") ||
    bareHost.endsWith(".local") ||
    bareHost.endsWith(".internal") ||
    bareHost.endsWith(".localdomain") ||
    !bareHost.includes(".")
  ) {
    throw new WebPushValidationError("Push endpoint host is not allowed");
  }

  return url;
}
