// SSRF guard for outbound fetches.
//
// Blocks server-side request forgery attempts by rejecting URLs that:
//   - use non-HTTP(S) protocols (file://, gopher://, etc.)
//   - target IP literals in private, loopback, link-local, multicast, or
//     cloud-metadata ranges
//   - target private hostnames like localhost / *.local / *.internal
//
// When `allowlist` is provided and non-empty, only hostnames matching one
// of those domains (the domain itself or a subdomain of it) are permitted.
//
// This performs a string/IP-literal check only. A remote DNS record could
// still rebind after validation (DNS-rebinding); defense-in-depth for that
// relies on the per-IP rate limit + auth on calling endpoints.
const net = require("net");

function isSafeURL(url, { allowlist = [] } = {}) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: "invalid_url" };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: "unsupported_protocol" };
  }

  const rawHost = parsed.hostname;
  if (!rawHost) return { ok: false, reason: "missing_host" };

  // Node's URL API keeps the brackets on IPv6 hostnames; strip them for
  // both the allowlist check and the IP-literal check.
  const host = rawHost.startsWith("[") && rawHost.endsWith("]")
    ? rawHost.slice(1, -1)
    : rawHost;

  if (allowlist.length > 0 && !matchesAllowlist(host, allowlist)) {
    return { ok: false, reason: "not_on_allowlist" };
  }

  const ipKind = net.isIP(host);
  if (ipKind === 4 && isPrivateIPv4(host)) {
    return { ok: false, reason: "private_ipv4" };
  }
  if (ipKind === 6 && isPrivateIPv6(host)) {
    return { ok: false, reason: "private_ipv6" };
  }

  if (ipKind === 0 && isPrivateHostname(host)) {
    return { ok: false, reason: "private_hostname" };
  }

  return { ok: true };
}

function matchesAllowlist(host, allowlist) {
  const lower = host.toLowerCase();
  for (const entry of allowlist) {
    const e = entry.toLowerCase().trim();
    if (!e) continue;
    if (lower === e) return true;
    if (lower.endsWith("." + e)) return true;
  }
  return false;
}

function isPrivateIPv4(ip) {
  const parts = ip.split(".").map((n) => parseInt(n, 10));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts;
  if (a === 10) return true;                         // 10.0.0.0/8 private
  if (a === 172 && b >= 16 && b <= 31) return true;  // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true;           // 192.168.0.0/16 private
  if (a === 127) return true;                        // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true;           // 169.254.0.0/16 link-local (incl. 169.254.169.254 metadata)
  if (a === 0) return true;                          // 0.0.0.0/8 this-network
  if (a >= 224) return true;                         // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 carrier-grade NAT
  return false;
}

function isPrivateIPv6(ip) {
  const lower = ip.toLowerCase();
  if (lower === "::1") return true;                            // loopback
  if (lower === "::") return true;                             // unspecified
  if (/^fc[0-9a-f]{2}:/.test(lower)) return true;              // fc00::/7 unique-local
  if (/^fd[0-9a-f]{2}:/.test(lower)) return true;              // fd00::/8 unique-local
  if (lower.startsWith("fe80:") || lower.startsWith("fe80::")) return true; // fe80::/10 link-local
  if (/^ff[0-9a-f]{2}:/.test(lower)) return true;              // multicast
  // IPv4-mapped IPv6: two accepted forms —
  //   ::ffff:1.2.3.4       (dotted)
  //   ::ffff:XXXX:YYYY     (hex pairs; Node's URL parser normalizes to this)
  const dotted = lower.match(/^::ffff:([\d.]+)$/);
  if (dotted && isPrivateIPv4(dotted[1])) return true;
  const hex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    if (!Number.isNaN(hi) && !Number.isNaN(lo)) {
      const dottedIp = [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff].join(".");
      if (isPrivateIPv4(dottedIp)) return true;
    }
  }
  return false;
}

function isPrivateHostname(host) {
  const lower = host.toLowerCase();
  if (lower === "localhost") return true;
  if (lower.endsWith(".localhost")) return true;
  if (lower.endsWith(".local")) return true;
  if (lower.endsWith(".internal")) return true;
  if (lower === "metadata" || lower === "metadata.google.internal") return true;
  return false;
}

module.exports = { isSafeURL, isPrivateIPv4, isPrivateIPv6, isPrivateHostname };
