# Outbound HTTP

Status: **draft**. Part of the [architecture overview](README.md).

The only way to fetch a URL that someone outside the platform controls.

| | |
|---|---|
| Package | `common` (`net` module) |
| Owns | No data |
| Used by | [Proxy](proxy.md) (forwarding), [Payment routing](payment-routing.md) (probe, paid retry, opt-out file), [Service registry](service-registry.md) (OpenAPI documents), [Ownership verification](ownership-verification.md), [Config assistant](config-assistant.md) |
| [Build step](README.md#7-build-order) | 1 |

## Requirements

- **OH-1** Resolve the host first. Reject these addresses, in IPv4 and IPv6, including IPv4-mapped IPv6:
  - private ranges, loopback, link-local, multicast, unspecified;
  - shared address space (`100.64.0.0/10`);
  - cloud metadata addresses, such as `169.254.169.254`.
- **OH-2** Connect to the IP that passed the check. Never resolve again in between. Keep SNI and `Host` set to the hostname.
- **OH-3** The caller picks the redirect policy:
  - `none` for forwarding and routing. Redirects go back to the client.
  - `sameHost` for OpenAPI documents and `.well-known` files.
- **OH-4** Every call has a connect timeout, a total timeout, and a response size limit. Defaults for forwarding: connect 5 s, total 30 s, request body 1 MiB.
- **OH-5** Refuse our own hosts and IP addresses, from [platform config](platform-config.md). Payment routing turns this into `host_not_allowed`. For every other caller, it's a safety net.
- **OH-6** HTTPS only.
- **OH-7** The resolver and the address policy are injected. Tests run against localhost fakes and a fake DNS resolver. Production wiring can't turn the policy off.
- **OH-8** Pool and keep alive connections per origin.
