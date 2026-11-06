/**
 * Which peer is trusted as the reverse proxy (SPEC-004 §7 `TRUST_PROXY`, D6). With
 * `TRUST_PROXY=true` only the nearest hop can be the proxy, and only when it connects from a
 * loopback, private, link-local or shared (CGNAT) address. Every documented setup has the proxy
 * on such an address: on the compose network, on the host (loopback or the Docker gateway), or
 * on the private address `SURFACE_BIND` recommends. A client that reaches the published port
 * from a public address is never taken for the proxy, so its X-Forwarded-* headers are ignored.
 * Fastify's own guidance: a trust rule must check the address, not only the hop.
 */
import { BlockList, isIP } from 'node:net';

const PRIVATE = new BlockList();
for (const [network, prefix] of [
  ['127.0.0.0', 8],
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['169.254.0.0', 16],
  ['100.64.0.0', 10],
] as const) {
  PRIVATE.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
] as const) {
  PRIVATE.addSubnet(network, prefix, 'ipv6');
}

/** Loopback, private, link-local or shared address space (IPv4-mapped IPv6 included). */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  return PRIVATE.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

/** Fastify `trustProxy`: only the socket peer (hop 0), and only from a private address. */
export function trustReverseProxy(address: string, hop: number): boolean {
  return hop === 0 && isPrivateAddress(address);
}
