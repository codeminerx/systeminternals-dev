---
title: "HTTP/2 and HTTP/3 Internals: How the Web Actually Gets Faster"
description: "Deep dive into HTTP/2 frames, streams, multiplexing, HPACK compression, server push, and HTTP/3's QUIC protocol, 0-RTT, and connection migration."
date: 2026-05-06
tags: ["networking", "http", "http2", "http3", "quic", "performance", "linux"]
---

If you've ever wondered why loading a page with dozens of CSS, JS, and image requests is faster over HTTP/2 than HTTP/1.1, or why HTTP/3 eliminates the HOL blocking that plagues HTTP/2 — this is the post that gets you all the way there.

HTTP/1.1 served us for 15 years, but its fundamental limitation is that it was designed for a web of simple document fetches, not the complex dependency graphs of modern SPAs. Understanding what HTTP/2 and HTTP/3 actually do under the hood lets you reason about when they help, when they hurt, and how to tune them.

> **Prerequisites:** This post assumes familiarity with TCP/IP fundamentals. If you need a refresher on how packets travel across the network, start with [TCP/IP Internals: How a Packet Travels Across the Network](/posts/tcp-ip-internals-packet-journey/).

## HTTP/1.1: The Problem

HTTP/1.1 opens a TCP connection and serializes requests over it:

```
Client                          Server
  |--- GET /index.html -------->|     (connection opened)
  |<-- 200 OK + index.html -----|     (wait, receive, parse)
  |--- GET /style.css --------->|
  |<-- 200 OK + style.css ------|
  |--- GET /app.js ------------>|
  |<-- 200 OK + app.js ---------|
  |--- GET /logo.png ---------->|
  |<-- 200 OK + logo.png -------|
  ...
```

Each request blocks the next. To work around this, browsers opened **6 TCP connections per origin** (HTTP/1.0/pipelining was widely broken). This created **head-of-line blocking** at the application layer — even though the underlying TCP connection was full-duplex, applications had to wait in line.

Worse, every connection requires a full TCP handshake (1 RTT minimum, more with TLS). For a page with 100 resources across 10 origins, that's 10 separate handshakes before a single byte of data.

## HTTP/2: Multiplexing with Streams and Frames

HTTP/2's core innovation is **stream multiplexing** — multiple logical request/response exchanges ride on a single TCP connection simultaneously. The key abstraction is the **frame**:

### Frames: The Atomic Unit

Every HTTP/2 message is broken into frames. There are 10 frame types:

| Frame Type | Purpose |
|------------|---------|
| `DATA` | Application request/response body |
| `HEADERS` | Request/response headers (compressed) |
| `SETTINGS` | Connection configuration (initial handshake) |
| `WINDOW_UPDATE` | Flow control |
| `RST_STREAM` | Abrupt stream termination |
| `PING` | Round-trip time measurement |
| `GOAWAY` | Graceful connection shutdown |
| `PRIORITY` | Stream dependency weighting |
| `PUSH_PROMISE` | Server-initiated push |
| `CONTINUATION` | Header fragment continuation |

Each frame has a simple structure:

```
+-----------------------------------------------+
|  Length (24 bits)  |  Type (8)  |  Flags (8)  |
+-----------------------------------------------+
|  R (1)  |        Stream ID (31 bits)          |
+-----------------------------------------------+
|              Frame Payload (variable)         |
+-----------------------------------------------+
```

- **Length:** 3 bytes, allowing frames up to 16 MB (16,777,215 bytes)
- **Type:** Identifies the frame semantics
- **Flags:** Type-specific flags (e.g., `END_HEADERS`, `END_STREAM`)
- **Stream ID:** Odd for client-initiated, even for server-initiated (push)

### Streams: Virtual Conversations

A **stream** is an independent, bidirectional sequence of frames between client and server. Each stream has:

- A unique integer ID (1, 3, 5, ... for client-initiated)
- Its own state machine (open, half-closed, closed)
- Priority/weight for scheduling

Multiple streams interleave on the wire:

```
TCP Connection (single)

 Stream 1 (GET /index.html)    DATA [............]
 Stream 3 (GET /style.css)         HEADERS [.]. DATA [....]
 Stream 5 (GET /app.js)                 HEADERS [.] DATA [........]
 Stream 7 (GET /logo.png)     HEADERS [.]  DATA [..]
```

The TCP layer sees one byte stream. The HTTP/2 layer sees multiple virtual conversations. Frames are tagged with stream IDs so the receiver can demultiplex them.

### HPACK: Header Compression That Matters

HTTP headers are verbose. A typical request:

```
GET / HTTP/1.1
Host: example.com
User-Agent: Mozilla/5.0...
Accept: text/html,application/xhtml+xml...
Accept-Language: en-US,en;q=0.9
Accept-Encoding: gzip, deflate, br
Cache-Control: no-cache
```

Thousands of bytes before a single content byte. Over a persistent connection with dozens of requests to the same origin, this is wasteful.

HTTP/1.1 used `Content-Encoding: gzip` on the body, but headers were always plaintext and always re-sent in full.

HTTP/2 uses **HPACK**, a stateful header compression scheme with two major components:

**1. Static Table** — A predefined list of 61 common header fields (e.g., `:method: GET`, `:status: 200`, `content-type: text/plain`). Both endpoints know these by index.

**2. Dynamic Table** — Learned entries specific to this connection. If you send `x-custom-header: some-value` once, it's added to the dynamic table and referred to by index in subsequent requests.

**3. Huffman Encoding** — String literals are encoded with Huffman coding, with frequency distribution tuned to HTTP header values.

A typical HPACK-encoded request might look like:

```
:method: GET          → index 2  (static table, 1 byte)
:scheme: https        → index 6  (static table, 1 byte)
:path: /             → index 4  (static table, 1 byte)
:authority: example.com → index 1 (static table, 1 byte)
```

vs. the full uncompressed text: 9 bytes vs. 5 bytes.

HPACK also uses **never-indexed** representation for privacy-sensitive headers (cookies, auth tokens), encoding them as literal strings that must never be added to the dynamic table.

### Server Push: Promise Before You Ask

HTTP/2 server push lets the server preemptively send resources the client will need, before the client requests them. The server sends a `PUSH_PROMISE` frame:

```
Client                              Server
  |--- GET /index.html ------------>|   (stream 1)
  |<-- 200 OK + headers (stream 1)--|
  |<-- PUSH_PROMISE [stream 3] -----|   (promises /style.css)
  |     + HEADERS (css request)     |   (server-initiated synthetic request)
  |<-- DATA + style.css (stream 3)--|
  |<-- 200 OK + index.html (stream 1)|
  |--- HEADERS + GET /style.css --->|   (stream 5)
  |<-- (already pushed, ignored) ----|
```

The client can `RST_STREAM` the push promise if it already has the resource cached. In practice, server push has seen limited adoption because of cache complexity and the difficulty of predicting what the client needs.

### Flow Control: Not Just TCP's Job

TCP has flow control (receiver buffer), and HTTP/2 adds its own **per-stream and connection-level flow control** using `WINDOW_UPDATE` frames.

Each endpoint advertises a flow control window for each stream and for the connection. By default it's 65,535 bytes. As bytes are received, the window shrinks. When it approaches zero, the sender blocks.

This is different from TCP flow control:

- **TCP flow control:** Prevents the sender from overwhelming the receiver's socket buffer (OS-level)
- **HTTP/2 flow control:** Prevents a single stream from monopolizing the connection (application-level)

A greedy stream can't starve other streams because each has its own window tracked by the receiver.

## HTTP/3: QUIC Takes Over

HTTP/3 replaces TCP with **QUIC**, a UDP-based multiplexed transport protocol. The reasons are fundamental:

### The TCP HOL Blocking Problem

HTTP/2 solves application-layer head-of-line blocking but introduces a new one at the transport layer:

```
Stream 1: DATA [.................................................................]
Stream 3: DATA [........]
Stream 5: DATA [........]
```

If Stream 3's packet is lost, TCP can't deliver Stream 5's data to the application either — even if Stream 5's data arrived and was perfectly intact. TCP treats the byte stream as a single ordered sequence.

The solution: decouple stream delivery from connection-level reliability.

### QUIC: Streams as First-Class Citizens

QUIC runs over UDP. Each QUIC connection has its own encryption layer (TLS 1.3 mandatory), and streams are first-class objects:

```
UDP (connectionless)

  QUIC Connection (handshake, crypto)

    Stream 1  (independent reliability: packet loss → only Stream 1 blocked)
    Stream 3  (independent reliability: packet loss → only Stream 3 blocked)
    Stream 5  (independent reliability: packet loss → only Stream 5 blocked)
```

When a packet is lost, only the stream that packet belonged to is blocked. Other streams continue normally.

### QUIC Packet Structure

QUIC packets (over UDP) look like:

```
UDP Header
  Source Port, Dest Port
  Length, Checksum

QUIC Header (long form, during handshake):
  Header Form (1) = 1
  Version (32)
  Dest Connection ID (0-160 bits)
  Src Connection ID (0-160 bits)
  Packet Number Length (2)
  Initial Packet Number (8/16/32/48)
  Initial Token (variable)
  Length (variable)
  Crypto Handshake (variable)

QUIC Header (short form, after handshake):
  Header Form (1) = 0
  Dest Connection ID
  Packet Number (8/16/32/48)
  Header Protection (removed)
  Encrypted Content (AEAD)
```

The `Packet Number` is always encrypted and shorter than the full sequence number (1-4 bytes vs. the full 48-bit number). This makes it impossible for eavesdroppers to infer sequence numbers and adds resistance to manipulated packet numbers.

### 0-RTT: The Holy Grail

TLS 1.3 introduced **0-RTT** (zero round-trip time) resumption. QUIC adopts this:

**Normal TLS 1.3 handshake (1-RTT):**
```
Client                          Server
  |--- ClientHello ------------->|
  |<-- ServerHello + certificate -|
  |<-- ( Finished ) -------------|
  |--- ( Finished ) ------------>|
  |=== encrypted channel =======|
```

**0-RTT resumption:**
```
Client                          Server
  |--- ClientHello + PSK票据 + early data ->|
  |<== encrypted channel (immediate) =======|
  |--- HTTP/3 request (immediate) --------->|
```

The client uses a **Pre-Shared Key (PSK)** from a previous handshake. It can encrypt and send data immediately, saving 1 full RTT.

Caveat: 0-RTT data is vulnerable to **replay attacks**. The data is tied to the specific session resumption ticket. Servers must handle this carefully and typically restrict 0-RTT to idempotent requests.

### Connection Migration

TCP connections are identified by the 4-tuple: `(src IP, src port, dst IP, dst port)`. If any of these change (e.g., mobile device switches from WiFi to LTE), the connection dies.

QUIC uses a **Connection ID** that's independent of the network path:

```
QUIC Connection
  Connection ID: 0xabc123
  (regardless of which IP/port we're using)
```

When the network changes, the client sends packets from the new path with the same Connection ID. The server recognizes it and migrates the connection state. This happens invisibly to the application.

For mobile clients, this means a phone call that interrupts WiFi doesn't kill your video stream.

### HTTP/3 Frames

HTTP/3 uses a different wire format than HTTP/2 (QPACK instead of HPACK, different frame framing), but the concepts map:

| Concept | HTTP/2 | HTTP/3 |
|---------|--------|--------|
| Framing | Length-prefixed frames | Length-prefixed frames (over QUIC streams) |
| Streams | Logical by stream ID | QUIC streams (first-class) |
| Header compression | HPACK | QPACK |
| Flow control | WINDOW_UPDATE | QUIC flow control |
| Priority | PRIORITY frame | PRIORITY_HEADERS frame |

QPACK is HPACK adapted for out-of-order delivery — since QUIC delivers stream data out of order, headers can't be compressed using the same indexed references without coordination. QPACK uses a two-phase header acknowledgment scheme to handle this.

## Linux sysctl Tuning

Both HTTP/2 and HTTP/3 benefit from kernel-level tuning.

### TCP Tuning (affects HTTP/2 over TCP)

```bash
# Enable TCP BBR for better throughput on high-latency links
sysctl -w net.ipv4.tcp_congestion_control=bbr
sysctl -w net.core.default_qdisc=fq

# Increase max concurrent streams (HTTP/2)
# Note: This is negotiated via SETTINGS frame, but kernel limits apply
sysctl -w net.ipv4.tcp_max_syn_reacks=64

# TCP keepalive for long-lived connections
sysctl -w net.ipv4.tcp_keepalive_time=30
sysctl -w net.ipv4.tcp_keepalive_intvl=10
```

### QUIC/HTTP/3 (requires a QUIC-capable server)

HTTP/3 support in the kernel is evolving. The main userspace QUIC implementations are:
- **lsquic** (LiteSpeed)
- **quiche** (Cloudflare)
- **ngtcp2** (used by curl, H2O)

```bash
# For servers running QUIC:
# Ensure firewall allows UDP on the HTTP/3 port (443)
# QUIC uses UDP, not TCP

# Monitor QUIC with ss (shows UDP sockets)
ss -uan sport = 443   # QUIC listeners

# tcpdump captures QUIC (UDP port 443)
tcpdump -i eth0 'udp port 443' -nn -X
```

### curl with HTTP/3

```bash
# Build curl with HTTP/3 support
curl --http3 https://example.com -I

# Check if a server supports HTTP/3
curl -I --http3 https://example.com
```

## Practical: Reading HTTP/2 Frames with tcpdump

Let's actually look at HTTP/2 on the wire:

```bash
# Capture HTTP/2 traffic (requires TLS inspection or a test server with h2c)
sudo tcpdump -i eth0 'tcp port 8443' -w h2.pcap

# Or for plaintext HTTP/2 (h2c):
# Start a test server
# ncat -l 8443 --sh-exec "ncat -l 8443 --exec 'cat', -k"

# Decode HTTP/2 with tshark (Wireshark CLI)
tshark -r h2.pcap -Y "http2" -T fields -e http2.streamid -e http2.header.name -e http2.header.value
```

A frame-level capture shows stream IDs and interleaving:

```
Stream 1: HEADERS (request: GET /)
Stream 1: DATA (response begins)
Stream 3: HEADERS (request: GET /style.css)   ← interleaved while Stream 1 still delivering
Stream 5: HEADERS (request: GET /app.js)
Stream 1: DATA (response continues)
Stream 3: DATA (response begins)
...
```

Wireshark (GUI) makes this visually obvious — you can see the frame interleaving in the "Frames" pane.

### Reading QUIC with tcpdump

```bash
# Capture QUIC traffic
sudo tcpdump -i eth0 'udp port 443' -w quic.pcap

# Wireshark can decode QUIC natively (QUIC dissector)
tshark -r quic.pcap -Y "quic" -T fields -e quic.packet_number -e quic.stream.stream_id
```

## When Does Each Protocol Win?

| Scenario | Best Choice | Reason |
|----------|-------------|--------|
| High-latency, many requests | HTTP/2 or HTTP/3 | Multiplexing eliminates connection setup overhead |
| Mobile client, network switches | HTTP/3 | Connection migration avoids reconnect |
| High packet loss environment | HTTP/3 | Stream-level loss recovery; no HOL blocking |
| Small number of large files | HTTP/1.1 or HTTP/2 | Overhead of multiplexing may not pay off |
| Latency-critical 1-RTT budget | HTTP/3 + 0-RTT | Saves full RTT on resumption |
| Middlebox-limited network | HTTP/2 over TCP | QUIC may be blocked by firewalls |

## The Bottom Line

HTTP/2's multiplexing is a fundamental advance — once you have it, you don't go back. But its TCP roots mean it never fully escapes head-of-line blocking.

HTTP/3 is the clean break: QUIC gives streams first-class treatment, 0-RTT eliminates handshake latency, and connection migration makes mobile finally work right.

For modern web performance, HTTP/3 is the target. Deploy it behind a CDN that handles the edge translation, and your users get the benefits without the QUIC deployment complexity.

The web got faster by fixing the transport layer's oldest assumptions. Now go instrument it.