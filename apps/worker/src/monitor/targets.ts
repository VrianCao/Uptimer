function isValidPort(n: number): boolean {
  return Number.isInteger(n) && n >= 1 && n <= 65535;
}

function normalizeLiteralHost(host: string): string {
  if (host.startsWith('[') && host.endsWith(']')) {
    return host.slice(1, -1);
  }
  return host;
}

// v0.x baseline:
// - allow any valid TCP port (1-65535)
// NOTE: This increases SSRF/port-scan abuse potential. Keep the blocked host/IP rules below, and rely on
// admin auth + rate limiting (Cloudflare layer) for additional protection.
function isAllowedPort(n: number): boolean {
  return n >= 1 && n <= 65535;
}

function isIpv4Literal(host: string): boolean {
  const parts = host.split('.');
  if (parts.length !== 4) return false;
  return parts.every((p) => {
    if (p.length === 0) return false;
    if (!/^[0-9]+$/.test(p)) return false;
    const n = Number(p);
    return Number.isInteger(n) && n >= 0 && n <= 255;
  });
}

function ipv4ToInt(host: string): number {
  const parts = host.split('.');
  if (parts.length !== 4) {
    throw new Error('Invalid IPv4 literal');
  }
  const [aStr, bStr, cStr, dStr] = parts as [string, string, string, string];
  const a = Number(aStr);
  const b = Number(bStr);
  const c = Number(cStr);
  const d = Number(dStr);
  return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
}

function ipv4InCidr(ip: number, base: string, maskBits: number): boolean {
  const baseInt = ipv4ToInt(base);
  const mask = maskBits === 0 ? 0 : (0xffffffff << (32 - maskBits)) >>> 0;
  return (ip & mask) === (baseInt & mask);
}

function ipv6ToInt(host: string): bigint | null {
  const normalized = normalizeLiteralHost(host).toLowerCase();
  const halves = normalized.split('::');
  if (halves.length > 2) return null;

  const parseHalf = (half: string): string[] => (half.length === 0 ? [] : half.split(':'));
  const left = parseHalf(halves[0] ?? '');
  const right = parseHalf(halves[1] ?? '');
  const omittedHextets = 8 - left.length - right.length;

  if (halves.length === 1 ? omittedHextets !== 0 : omittedHextets < 1) return null;

  const hextets = [...left, ...Array<string>(omittedHextets).fill('0'), ...right];
  if (hextets.length !== 8 || !hextets.every((hextet) => /^[0-9a-f]{1,4}$/.test(hextet))) {
    return null;
  }

  return hextets.reduce((value, hextet) => (value << 16n) | BigInt(`0x${hextet}`), 0n);
}

function ipv6InCidr(ip: bigint, base: string, maskBits: number): boolean {
  const baseInt = ipv6ToInt(base);
  if (baseInt === null) throw new Error('Invalid IPv6 CIDR base');

  const shift = BigInt(128 - maskBits);
  return ip >> shift === baseInt >> shift;
}

function isBlockedIpv4Int(ip: number): boolean {
  return (
    ipv4InCidr(ip, '0.0.0.0', 8) || // "this" network
    ipv4InCidr(ip, '10.0.0.0', 8) ||
    ipv4InCidr(ip, '100.64.0.0', 10) || // carrier-grade NAT
    ipv4InCidr(ip, '127.0.0.0', 8) ||
    ipv4InCidr(ip, '169.254.0.0', 16) || // link-local
    ipv4InCidr(ip, '172.16.0.0', 12) ||
    ipv4InCidr(ip, '192.0.0.0', 24) || // IETF protocol assignments
    ipv4InCidr(ip, '192.0.2.0', 24) || // TEST-NET-1
    ipv4InCidr(ip, '192.168.0.0', 16) ||
    ipv4InCidr(ip, '198.18.0.0', 15) || // benchmark
    ipv4InCidr(ip, '198.51.100.0', 24) || // TEST-NET-2
    ipv4InCidr(ip, '203.0.113.0', 24) || // TEST-NET-3
    ipv4InCidr(ip, '224.0.0.0', 4) || // multicast
    ipv4InCidr(ip, '240.0.0.0', 4) // reserved
  );
}

function isBlockedIpv6Int(ip: bigint): boolean {
  const isAllowedException =
    ipv6InCidr(ip, '2001::', 32) || // Teredo: reachability depends on embedded IPv4
    ipv6InCidr(ip, '2001:1::1', 128) || // PCP anycast
    ipv6InCidr(ip, '2001:1::2', 128) || // TURN anycast
    ipv6InCidr(ip, '2001:1::3', 128) || // DNS-SD service registration anycast
    ipv6InCidr(ip, '2001:3::', 32) || // AMT
    ipv6InCidr(ip, '2001:4:112::', 48) || // AS112-v6
    ipv6InCidr(ip, '2001:20::', 28) || // ORCHIDv2
    ipv6InCidr(ip, '2001:30::', 28); // Drone Remote ID protocol entity tags
  if (isAllowedException) return false;

  return (
    ipv6InCidr(ip, '::', 128) || // unspecified
    ipv6InCidr(ip, '::1', 128) || // loopback
    ipv6InCidr(ip, '64:ff9b:1::', 48) || // local-use IPv4/IPv6 translation
    ipv6InCidr(ip, '100::', 64) || // discard-only
    ipv6InCidr(ip, '100:0:0:1::', 64) || // dummy prefix
    ipv6InCidr(ip, '2001::', 23) || // IETF protocol assignments
    ipv6InCidr(ip, '2001:db8::', 32) || // documentation
    ipv6InCidr(ip, '3fff::', 20) || // documentation
    ipv6InCidr(ip, '5f00::', 16) || // segment routing SIDs
    ipv6InCidr(ip, 'fc00::', 7) || // unique-local
    ipv6InCidr(ip, 'fe80::', 10) || // link-local
    ipv6InCidr(ip, 'ff00::', 8) // multicast
  );
}

function parseIpv6MappedIpv4(host: string): number | null {
  const lower = normalizeLiteralHost(host).toLowerCase();
  if (!lower.startsWith('::ffff:')) return null;

  const tail = lower.slice('::ffff:'.length);
  if (isIpv4Literal(tail)) {
    return ipv4ToInt(tail);
  }

  // Canonical mapped form from URL parser, e.g. ::ffff:7f00:1
  const parts = tail.split(':');
  if (parts.length !== 2) return null;
  if (!parts.every((part) => /^[0-9a-f]{1,4}$/.test(part))) return null;

  const hi = Number.parseInt(parts[0] ?? '', 16);
  const lo = Number.parseInt(parts[1] ?? '', 16);
  if (!Number.isFinite(hi) || !Number.isFinite(lo)) return null;

  const a = (hi >>> 8) & 0xff;
  const b = hi & 0xff;
  const c = (lo >>> 8) & 0xff;
  const d = lo & 0xff;
  return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
}

function isBlockedIpLiteral(host: string): boolean {
  const normalized = normalizeLiteralHost(host);

  const mappedIpv4 = parseIpv6MappedIpv4(normalized);
  if (mappedIpv4 !== null) {
    return isBlockedIpv4Int(mappedIpv4);
  }

  const ipv6 = ipv6ToInt(normalized);
  if (ipv6 !== null) {
    return isBlockedIpv6Int(ipv6);
  }

  if (!isIpv4Literal(normalized)) return false;
  return isBlockedIpv4Int(ipv4ToInt(normalized));
}

function normalizeHostForValidation(host: string): string | null {
  const trimmed = normalizeLiteralHost(host.trim());
  if (!trimmed) return trimmed;

  // Canonicalize equivalent IPv6 forms so mapped IPv4 checks also cover expanded literals.
  if (trimmed.includes(':')) {
    try {
      return normalizeLiteralHost(new URL(`http://[${trimmed}]`).hostname);
    } catch {
      return null;
    }
  }

  // Normalize unusual IPv4 notations (e.g. 127.1 / 0x7f000001) before blocked-range checks.
  try {
    return new URL(`http://${trimmed}`).hostname;
  } catch {
    return trimmed;
  }
}

export function validateHttpTarget(target: string): string | null {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return 'target must be a valid URL';
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return 'target protocol must be http or https';
  }

  const hostname = url.hostname;
  if (!hostname) return 'target must include a hostname';
  if (hostname.toLowerCase() === 'localhost') return 'target hostname is not allowed';
  if (isBlockedIpLiteral(hostname)) return 'target hostname is not allowed';

  const port = url.port ? Number(url.port) : url.protocol === 'http:' ? 80 : 443;
  if (!isValidPort(port)) return 'target port is invalid';
  if (!isAllowedPort(port)) return 'target port is not allowed';

  return null;
}

export function parseTcpTarget(target: string): { host: string; port: number } | null {
  const trimmed = target.trim();
  if (trimmed.length === 0) return null;

  // IPv6 form: [::1]:443
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']');
    if (end === -1) return null;
    const host = trimmed.slice(1, end);
    const rest = trimmed.slice(end + 1);
    if (!rest.startsWith(':')) return null;
    const port = Number(rest.slice(1));
    if (!isValidPort(port)) return null;
    return { host, port };
  }

  const idx = trimmed.lastIndexOf(':');
  if (idx <= 0) return null;
  const host = trimmed.slice(0, idx);
  if (host.includes(':')) return null; // IPv6 must use [addr]:port
  const port = Number(trimmed.slice(idx + 1));
  if (!isValidPort(port)) return null;
  return { host, port };
}

export function validateTcpTarget(target: string): string | null {
  const parsed = parseTcpTarget(target);
  if (!parsed) return 'target must be in host:port format (IPv6: [addr]:port)';

  const host = normalizeHostForValidation(parsed.host);
  if (host === null) return 'target host is not allowed';
  if (host.length === 0) return 'target host is required';
  if (host.toLowerCase() === 'localhost') return 'target host is not allowed';
  if (isBlockedIpLiteral(host)) return 'target host is not allowed';

  if (!isAllowedPort(parsed.port)) return 'target port is not allowed';
  return null;
}
