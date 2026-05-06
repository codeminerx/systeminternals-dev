---
title: "DNS Deep Dive: How Domain Name Resolution Actually Works"
description: "A thorough look at DNS — recursive vs iterative queries, record types, DNSSEC, DoH/DoT, TTL behavior, and why your cache matters more than you think."
date: 2026-05-03
tags: ["networking", "dns", "internet", "protocols", "security", "infrastructure"]
---

Every URL you type, every API call you make, every email you send — it all starts with a DNS lookup. Most engineers know DNS translates names to IP addresses. Far fewer understand how that translation actually happens, why it sometimes breaks in subtle ways, or howDNSSEC, DoH, and DoT change the security model.

Let's fix that.

## The Problem DNS Solves

IP addresses are how computers talk to each other, but humans can't remember 93.184.216.34. DNS is the global distributed database that maps `example.com` to `93.184.216.34` — and it does this at internet scale, with sub-millisecond latency, 99.999% uptime, and no central authority.

The name comes from its original architecture: domains were organized in a tree structure rooted at `.` (the root). Each label in `www.example.com` represents a level in that tree.

## The DNS Hierarchy

```
                         . (root)
                          │
     ┌──────────┬─────────┼─────────┬──────────┐
    com       org       net       edu       ... TLDs
     │
   example
     │
    www
```

The root zone contains all top-level domains (TLDs: .com, .net, .org, country codes). Below TLDs are second-level domains (like `example.com`). Below those are subdomains (`www.example.com`, `api.example.com`).

No single server holds all the records. Instead, DNS distributes the load through delegation.

## Recursive vs Iterative Queries

There are two fundamentally different ways a DNS query can travel through the system.

### Recursive Resolution

When your browser asks a recursive resolver ("Give me the IP for example.com"), the resolver does all the work:

```
Browser ──▶ Resolver (8.8.8.8) ──▶ Root Server ──▶ TLD Server ──▶ Authoritative NS ──▶ Resolver ──▶ Browser
                         [recursive resolver does all the chasing]
```

Your computer doesn't talk to root servers. It talks to whatever resolver is configured (often via DHCP — your router or ISP's DNS). That resolver chases down the answer recursively and hands you the result.

### Iterative Resolution

In iterative resolution, each server hands back what it knows — either the answer or a referral to the next server closer to the answer:

```
Resolver ──▶ Root Server
             "I don't know example.com, but here are the .com servers: [TLD NS list]"
                  │
                  ▼
             TLD Server (.com)
             "I don't know example.com, but here are the authoritative servers: [example.com NS list]"
                  │
                  ▼
             Authoritative NS (example.com)
             "93.184.216.34"
```

The root servers don't store every domain. They only store the addresses of TLD name servers. This delegation chain is what makes DNS scalable.

### Where Your Queries Actually Go

Most desktop and mobile devices use recursive resolution:

```
Your Computer ──▶ Configured Resolver (1.1.1.1, 8.8.8.8, or router) ──▶ Recursive Resolution
```

The resolver caches aggressively. If someone in your ISP already looked up `example.com` in the last few minutes, your resolver gets a cached answer. This is why DNS can be fast even though the full chain involves multiple servers.

## DNS Record Types

DNS isn't just A records. Here's what the main types do:

| Record Type | Purpose | Example |
|-------------|---------|---------|
| **A** | IPv4 address mapping | `example.com → 93.184.216.34` |
| **AAAA** | IPv6 address mapping | `example.com → 2606:2800:220:1::` |
| **CNAME** | Canonical name (alias) | `www.example.com → example.com` |
| **MX** | Mail exchange (mail servers) | `example.com → mail.example.com` |
| **NS** | Authoritative name servers | `example.com → ns1.example.com` |
| **TXT** | Arbitrary text (verification, SPF, etc.) | `example.com → "v=spf1 include:_spf.example.com ~all"` |
| **SOA** | Start of authority (zone metadata) | Serial number, refresh timers, admin email |
| **PTR** | Reverse DNS (IP → hostname) | `34.216.184.93.in-addr.arpa → example.com` |
| **SRV** | Service location | `_http._tcp.example.com → 0 5 80 web.example.com` |
| **CAA** | Certification Authority Authorization | Controls which CAs can issue certificates |

### A and AAAA Records

These are the workhorses. An A record maps a name to an IPv4 address:

```
example.com.    300    IN    A    93.184.216.34
```

The `300` is the TTL in seconds. More on that later.

AAAA records do the same for IPv6:

```
example.com.    300    IN    AAAA    2606:2800:220:1::247d:18d5:3736:1
```

### CNAME Records

A CNAME creates an alias. `www.example.com` might be a CNAME pointing to `example.com`:

```
www.example.com.    600    IN    CNAME    example.com.
```

When resolving a CNAME, the resolver follows the chain until it hits an A/AAAA record. This is why you can't have a CNAME at the apex of a domain (`example.com` itself) — it would conflict with other record types like MX or NS that need to coexist at the same node.

### MX Records

Mail servers use MX records with a priority value:

```
example.com.    3600    IN    MX    10 mail.example.com.
example.com.    3600    IN    MX    20 mail2.example.com.
```

Lower priority is preferred. Mail servers try `mail.example.com` first, and only fall back to `mail2.example.com` if that fails.

### NS Records

NS records delegate a zone to a nameserver:

```
example.com.    86400    IN    NS    ns1.example.com.
example.com.    86400    IN    NS    ns2.example.com.
```

These are what tell the world "if you want to know about `example.com`, ask `ns1.example.com`."

## The DNS Resolution Process: Step by Step

Here's exactly what happens when you type `https://api.example.com` into a browser:

```
1. Browser checks its own DNS cache
   └── If not found, asks the system resolver (getaddrinfo)

2. System resolver asks configured recursive resolver (e.g., 8.8.8.8:53)
   └── If resolver has it cached and TTL hasn't expired, return cached answer

3. Resolver checks root zone for .com TLD servers
   └── Root servers return: "here are the .com TLD nameservers"

4. Resolver asks a .com TLD server for example.com's nameservers
   └── TLD servers return: "here are example.com's authoritative NS"

5. Resolver asks example.com's authoritative NS for api.example.com
   └── Authoritative NS returns: 93.184.216.34

6. Resolver caches the result with the TTL from the record
   └── Return answer to browser
```

In practice, steps 3-5 are cached at multiple levels, so most queries only touch 1-2 servers.

## TTL: Why Your Changes Take Time to Propagate

Every DNS record has a TTL (Time To Live) value in seconds. This tells resolvers how long they can cache the record before they should re-fetch it.

Typical TTLs:

```
A/AAAA records:     300-3600 (5 minutes to 1 hour)
NS records:         86400-172800 (1-2 days)
MX records:         3600-86400 (1-24 hours)
CNAME records:      300-7200 (5 minutes to 2 hours)
```

When you change a DNS record, the old value stays cached at every resolver that queried it. If the TTL is 24 hours, you could be waiting that long for the change to propagate globally.

### Negative Caching: The DNS Dark Corner

When a domain doesn't exist, DNS caches that too — via the **SOA record's minimum TTL**:

```
example.com.    3600    IN    SOA    ns1.example.com. admin.example.com. (
                        2024010101 ; serial
                        3600       ; refresh (3h)
                        1800       ; retry (30min)
                        604800     ; expire (7 days)
                        3600 )     ; minimum TTL (negative cache)
```

The minimum TTL tells resolvers how long to cache the fact that a record doesn't exist. If this is 3600 (1 hour), every query for a non-existent subdomain will return NXDOMAIN for an hour after the first query.

This is why typos in DNS can be annoyingly persistent. If you accidentally create `*.example.com` and then delete it, users who hit that typo before deletion will be NXDOMAIN-cached for the negative TTL period.

## DNSSEC: Authenticating DNS Responses

Without DNSSEC, a DNS response could be forged. A man-in-the-middle could intercept your DNS query and return the IP of a malicious server. DNSSEC adds cryptographic authentication to DNS.

### How DNSSEC Works

DNSSEC adds a chain of cryptographic signatures:

```
Zone example.com has:
  - A record for example.com
  - RRSIG (record signature) signed by the zone's private key

The parent zone (com) has:
  - DS record (Delegation Signer) containing a hash of example.com's public key
  - RRSIG for the DS record

The root zone has:
  - DS records for .com
  - RRSIG for the .com DS records
```

This creates a chain of trust from the root down. When you query example.com with DNSSEC enabled, the resolver:
1. Verifies the A record's RRSIG using the zone's public key
2. Verifies the zone's public key hash against the parent zone's DS record
3. Verifies the parent DS record against its RRSIG
4. Continues up to the root

If any link in the chain is broken (expired signature, tampered record, missing DS), validation fails and the resolver returns SERVFAIL.

### DNSSEC Limitations

DNSSEC doesn't encrypt DNS queries — it only authenticates them. Your ISP can still see every domain you visit. For privacy, you need DoH or DoT.

## DNS over HTTPS (DoH) and DNS over TLS (DoT)

Traditional DNS travels over UDP port 53 in cleartext. Your ISP, employer, or anyone on the network can see every domain you query.

**DoT (DNS over TLS)** wraps DNS in TLS on port 853:

```
Traditional:  client ──▶ resolver:53 (cleartext)
DoT:         client ──▶ resolver:853 (encrypted TLS)
```

**DoH (DNS over HTTPS)** wraps DNS in HTTPS:

```
DoH:         client ──▶ resolver/https (looks like normal HTTPS traffic)
```

Major resolvers support both:
- Cloudflare: `1.1.1.1` (DoH: `https://cloudflare-dns.com/dns-query`)
- Google: `8.8.8.8` (DoH: `https://dns.google/dns-query`)
- Quad9: `9.9.9.9`

If you're evaluating DNS providers for privacy, Cloudflare's 1.1.1.1 is worth a close look — they're publicly committed to not logging browsing data and have published third-party audits.

Browsers now have built-in DoH support. When enabled, your browser bypasses the system resolver and queries DNS directly over HTTPS. This breaks local DNS-based splits (like private DNS entries for internal services) and can complicate network monitoring.

## Running Your Own DNS: What to Know

If you're running authoritative DNS for your own domains, here's what actually matters:

### Serial Numbers

Every zone has a serial number in the SOA record. When you make changes, you increment the serial. Secondary nameservers check if the serial has increased to know when to transfer the updated zone:

```
2024010101  ; YYYYMMDDNN format — common but not required
```

### Zone Transfers

Secondary nameservers periodically check in with the primary:

```
refresh:  How often secondaries should check for updates (e.g., 3 hours)
retry:   How long to wait if refresh fails (e.g., 30 minutes)
expire:  How long a secondary keeps serving if it can't reach primary (e.g., 7 days)
```

If your primary goes down for more than `expire` seconds, secondaries stop serving the zone.

### Common Pitfalls

1. **Forgetting to increment the serial** — Secondary servers don't pick up changes
2. **Too-low TTL on A records** — Creates load spikes when you change IPs
3. **Too-high TTL during outages** — Users stay pointed at dead IPs
4. **Missing glue records** — When the NS record points to a subdomain within the same zone, you need an A record for that NS (glue) or nameservers can't find it
5. **Chasing CNAMEs manually** — Resolvers do this automatically; external tools sometimes don't

## Tools for DNS Investigation

```bash
# Basic lookup
dig example.com A +short

# Full query with timing
dig +noall +answer +stats example.com A

# Query specific resolver
dig @1.1.1.1 example.com A

# Trace the full resolution path
dig +trace example.com A

# Check DNSSEC validation
dig +dnssec example.com A

# Reverse DNS
dig -x 93.184.216.34

# Check MX records
dig example.com MX

# Check CAA records
dig example.com CAA

# Check SOA
dig example.com SOA
```

## Conclusion

DNS is deceptively simple from a distance — names map to IPs — but the actual machinery involves hierarchical delegation, multi-level caching, negative caching with persistent TTLs, optional cryptographic authentication, and growing privacy mechanisms.

Understanding the full resolution chain matters when:
- DNS changes aren't propagating (check TTLs)
- Applications can't reach services (is it DNS? Is the resolver in a different cache state?)
- You're debugging mysterious timeouts (negative caching of NXDOMAIN)
- You're evaluating DoH/DoT for privacy vs. operational tooling tradeoffs
- You're troubleshooting DNSSEC validation failures

The next time you type a URL and it "just works," now you know how many servers, caches, and cryptographic checks made that possible.

## Related Posts

- [TCP/IP Internals](/posts/tcp-ip-internals-packet-journey) — DNS sits on top of the TCP/IP stack; understanding the full packet journey explains the network layer beneath DNS
- [Linux /proc Filesystem Deep Dive](/posts/linux-proc-filesystem-deep-dive) — DNS resolvers write cache data to filesystem entries; `/proc` is how you inspect what's actually stored
- [eBPF Linux Observability](/posts/ebpf-linux-observability-framework) — eBPF programs can intercept DNS resolution at the socket level for deep observability without traditional proxying

---

**External Resources**

- [Cloudflare's DNS primer](https://www.cloudflare.com/learning/dns/what-is-dns/) — Excellent visual explanations
- [DNS RFC 1035](https://datatracker.ietf.org/doc/html/rfc1035) — The original DNS specification
- [DNSSEC RFC 4033](https://datatracker.ietf.org/doc/html/rfc4033) — DNSSEC introduction and requirements
- [ISC Bind 9 Administrator Reference Manual](https://downloads.isc.org/isc/bind9/cur/32/doc/html/index.html) — For running your own DNS
- [DNS flag day 2020](https://dnsflagday.net/) — On EDNS client subnet and DNSSEC deployment