import { describe, expect, it } from 'vitest';

import { parseTcpTarget, validateHttpTarget, validateTcpTarget } from '../src/monitor/targets';

describe('validateHttpTarget', () => {
  it('accepts valid public http/https targets', () => {
    expect(validateHttpTarget('https://example.com/health')).toBeNull();
    expect(validateHttpTarget('http://status.example.com:8080/ping')).toBeNull();
  });

  it('rejects invalid URL and unsupported protocols', () => {
    expect(validateHttpTarget('not-a-url')).toBe('target must be a valid URL');
    expect(validateHttpTarget('ftp://example.com')).toBe('target protocol must be http or https');
  });

  it('rejects blocked hosts and reserved addresses', () => {
    expect(validateHttpTarget('https://localhost/health')).toBe('target hostname is not allowed');
    expect(validateHttpTarget('https://10.0.1.2/health')).toBe('target hostname is not allowed');
    expect(validateHttpTarget('https://127.0.0.1/health')).toBe('target hostname is not allowed');
    expect(validateHttpTarget('https://[::1]/health')).toBe('target hostname is not allowed');
    expect(validateHttpTarget('https://[::ffff:127.0.0.1]/health')).toBe(
      'target hostname is not allowed',
    );
    expect(validateHttpTarget('https://[fc00::1]/health')).toBe('target hostname is not allowed');
    expect(validateHttpTarget('https://192.0.2.10/health')).toBe('target hostname is not allowed');
    expect(validateHttpTarget('https://198.51.100.1/health')).toBe(
      'target hostname is not allowed',
    );
    expect(validateHttpTarget('https://198.18.0.10/health')).toBe('target hostname is not allowed');
    expect(validateHttpTarget('https://203.0.113.1/health')).toBe('target hostname is not allowed');
    expect(validateHttpTarget('https://224.1.1.1/health')).toBe('target hostname is not allowed');
    expect(validateHttpTarget('https://240.0.0.1/health')).toBe('target hostname is not allowed');
  });

  it('rejects invalid ports', () => {
    expect(validateHttpTarget('https://example.com:0/health')).toBe('target port is invalid');
  });
});

describe('parseTcpTarget', () => {
  it('parses host:port and bracketed IPv6 targets', () => {
    expect(parseTcpTarget('db.example.com:5432')).toEqual({ host: 'db.example.com', port: 5432 });
    expect(parseTcpTarget('[2606:4700:4700::1111]:443')).toEqual({
      host: '2606:4700:4700::1111',
      port: 443,
    });
  });

  it('returns null for malformed targets', () => {
    expect(parseTcpTarget('')).toBeNull();
    expect(parseTcpTarget('missing-port')).toBeNull();
    expect(parseTcpTarget('2606:4700:4700::1111:443')).toBeNull();
    expect(parseTcpTarget('[::1]')).toBeNull();
    expect(parseTcpTarget('[::1')).toBeNull();
    expect(parseTcpTarget('[::1]443')).toBeNull();
    expect(parseTcpTarget('[::1]:0')).toBeNull();
    expect(parseTcpTarget('example.com:not-a-port')).toBeNull();
  });
});

describe('validateTcpTarget', () => {
  it('accepts reachable public targets', () => {
    expect(validateTcpTarget('example.com:443')).toBeNull();
    expect(validateTcpTarget('[2606:4700:4700::1111]:53')).toBeNull();
    expect(validateTcpTarget('[2001:3::1]:80')).toBeNull();
  });

  it('rejects blocked hosts and reserved IP ranges', () => {
    expect(validateTcpTarget('localhost:5432')).toBe('target host is not allowed');
    expect(validateTcpTarget('192.168.1.2:5432')).toBe('target host is not allowed');
    expect(validateTcpTarget('127.0.0.1:80')).toBe('target host is not allowed');
    expect(validateTcpTarget('127.1:80')).toBe('target host is not allowed');
    expect(validateTcpTarget('0x7f000001:80')).toBe('target host is not allowed');
    expect(validateTcpTarget('[::1]:443')).toBe('target host is not allowed');
    expect(validateTcpTarget('[::]:80')).toBe('target host is not allowed');
    expect(validateTcpTarget('[::ffff:127.0.0.1]:443')).toBe('target host is not allowed');
  });

  it('rejects the complete IPv6 link-local range', () => {
    expect(validateTcpTarget('[fe80::1]:22')).toBe('target host is not allowed');
    expect(validateTcpTarget('[fe90::1]:443')).toBe('target host is not allowed');
    expect(validateTcpTarget('[febf::1]:443')).toBe('target host is not allowed');
  });

  it('rejects IPv6 multicast and unique-local targets', () => {
    expect(validateTcpTarget('[ff02::1]:443')).toBe('target host is not allowed');
    expect(validateTcpTarget('[ff05::1]:443')).toBe('target host is not allowed');
    expect(validateTcpTarget('[fd12::1]:22')).toBe('target host is not allowed');
  });

  it('rejects equivalent IPv4-mapped blocked targets', () => {
    expect(validateTcpTarget('[::ffff:7f00:1]:443')).toBe('target host is not allowed');
    expect(validateTcpTarget('[0:0:0:0:0:ffff:7f00:1]:443')).toBe('target host is not allowed');
    expect(validateTcpTarget('[0:0:0:0:0:FFFF:0A00:0001]:443')).toBe('target host is not allowed');
  });

  it('rejects non-global IPv6 special-purpose ranges', () => {
    expect(validateTcpTarget('[64:ff9b:1::1]:80')).toBe('target host is not allowed');
    expect(validateTcpTarget('[100::1]:80')).toBe('target host is not allowed');
    expect(validateTcpTarget('[100:0:0:1::1]:80')).toBe('target host is not allowed');
    expect(validateTcpTarget('[2001:100::1]:80')).toBe('target host is not allowed');
    expect(validateTcpTarget('[2001:2::1]:80')).toBe('target host is not allowed');
    expect(validateTcpTarget('[2001:db8::1]:80')).toBe('target host is not allowed');
    expect(validateTcpTarget('[3fff::1]:80')).toBe('target host is not allowed');
    expect(validateTcpTarget('[5f00::1]:80')).toBe('target host is not allowed');
  });

  it('rejects malformed payloads and out-of-range ports', () => {
    expect(validateTcpTarget('bad-target')).toBe(
      'target must be in host:port format (IPv6: [addr]:port)',
    );
    expect(validateTcpTarget('example.com:65536')).toBe(
      'target must be in host:port format (IPv6: [addr]:port)',
    );
    expect(validateTcpTarget('[]:443')).toBe('target host is required');
  });

  it('rejects invalid IPv6 literals', () => {
    expect(validateTcpTarget('[garbage::1]:80')).toBe('target host is not allowed');
    expect(validateTcpTarget('[12345::1]:80')).toBe('target host is not allowed');
    expect(validateTcpTarget('[1::2::3]:80')).toBe('target host is not allowed');
  });
});
