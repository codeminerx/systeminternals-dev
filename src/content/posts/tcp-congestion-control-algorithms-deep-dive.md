---
title: "TCP Congestion Control: How TCP Slow Start, AIMD, and BBR Actually Work"
description: "A deep dive into TCP congestion control algorithms — Slow Start, AIMD, Reno, CUBIC, and BBR — with packet diagrams, ASCII charts, and Linux sysctl commands for practical tuning."
date: 2026-05-04
tags: ["networking", "tcp", "congestion-control", "performance", "linux", "kernel", "cubic", "bbr", "aimd"]
structuredData:
  type: "Article"
  author: "systeminternals.dev"
  datePublished: "2026-05-04"
  dateModified: "2026-05-04"
---

TCP congestion control is the reason the internet doesn't collapse under its own weight. Without it, every connection would greedily max out its bandwidth, causing packet losses that trigger even more retransmissions — a vicious cycle called **congestion collapse**. The 1986 internet collapse, where throughput dropped from 32 Kbps to 40 bps, was the wake-up call that led to the algorithms we rely on today.

This post dissects every major congestion control algorithm with the depth needed to actually tune, debug, and reason about TCP performance in production systems.

## The Congestion Collapse Problem

Before congestion control, TCP simply sent as fast as possible and relied on retransmission timeouts to recover from loss. In a shared network, this creates a **positive feedback loop**:

1. Router queues fill up → packets drop
2. Senders retransmit lost packets
3. More packets in the network → more drops
4. Repeat until throughput approaches zero

The fix required treating **packet loss not as a random event, but as a signal** — evidence that the network is overloaded and the sender needs to back off.

## The TCP Header: Where Congestion Lives

TCP's header includes fields that carry congestion state between sender and receiver:

```
 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|          Source Port          |        Destination Port       |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                       Sequence Number                         |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                   Acknowledgment Number                       |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
| Offset|  Flags     |               Window                      |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|           Checksum            |         Urgent Pointer        |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
```

**Congestion-relevant fields:**

- **Sequence Number** — Tracks the byte position of every segment; helps detect losses
- **ACK Number** — Cumulative acknowledgment; tells the sender what was received
- **Window** — The receive window (rwnd), advertised by the receiver to cap unacknowledged data
- **Flags**: `ACK` (acknowledgment), `ECE` (ECN-Echo, signals network congestion), `CWR` (Congestion Window Reduced, confirms throttle)

The congestion window (cwnd) is **not in the TCP header** — it's a sender-side state variable maintained by the kernel. This is a critical point: only the sender knows cwnd. The receiver has no idea how aggressively the sender is transmitting.

## Slow Start: Starting Fast, Carefully

TCP slow start is the **initial ramp-up phase**. Despite the name, it's anything but slow — it starts conservatively but accelerates exponentially.

### How It Works

The sender begins with a small **congestion window** (cwnd) and **slow start threshold** (ssthresh):

- **Initial cwnd**: Historically 1-3 segments (~4.5 KB). Modern Linux uses 10 segments (RFC 6928), ~14.6 KB
- **ssthresh**: Starts at a very large value (65535 bytes by default in older kernels, effectively "infinity")

Each ACK received while in slow start **increments cwnd by one segment** (SMSS — Sender Maximum Segment Size). With delayed ACKs (receiver acknowledging every other segment), cwnd effectively **doubles every RTT**:

```
RTT 1: cwnd =  1 segment (  ~1.5 KB)
RTT 2: cwnd =  2 segments (  ~3 KB)
RTT 3: cwnd =  4 segments (  ~6 KB)
RTT 4: cwnd =  8 segments (  ~12 KB)
RTT 5: cwnd = 16 segments (  ~24 KB)
...
```

### Slow Start Exit Conditions

Slow start exits (and congestion avoidance begins) when:

1. **cwnd >= ssthresh** — The pipe is getting full; ease off
2. **Loss detected** — cwnd is reset to 1 segment, ssthresh set to cwnd/2

### Wireshark Sequence Diagram: Slow Start

```
Sender                                          Receiver
   |                                                |
   |---[SYN]------------------------------>
   |    cwnd=1, seq=0
   |                                                |
   |<---[SYN-ACK, ack=1]---------------------------
   |    win=65535
   |                                                |
   |---[ACK, seq=1, data=1-1460]----------------->
   |    cwnd=2 (1 segment sent, 1 ACK pending)
   |                                                |
   |<---[ACK, ack=1461]---------------------------
   |    Delayed ACK: acknowledged every 2 segments
   |                                                |
   |---[ACK, seq=1461, data=1461-2920]--------->
   |---[ACK, seq=2921, data=2921-4380]--------->
   |    cwnd=4 (doubled on two ACKs)
   |                                                |
   |<---[ACK, ack=4381]---------------------------
   |    One ACK covers both segments (delayed ACK)
   |                                                |
   |---[ACK, seq=4381, data=4381-5840]--------->
   |---[ACK, seq=5841, data=5841-7300]--------->
   |---[ACK, seq=7301, data=7301-8760]--------->
   |---[ACK, seq=8761, data=8761-10220]------->
   |    cwnd=8 (doubled on four ACKs)
   |                                                |
```

Slow start is aggressive early — doubling every RTT means it reaches gigabit-speed pipes in roughly 10-14 RTTs. But this growth is blind; it doesn't know the network's capacity until it causes a loss.

## AIMD: The Fairness Algorithm

**Additive Increase Multiplicative Decrease (AIMD)** is the core control law underlying most congestion avoidance algorithms. It implements a **distributed fair bandwidth allocation** across competing flows.

### The Algorithm

```
On each RTT (congestion avoidance):
    cwnd = cwnd + MSS * (MSS / cwnd)    // Additive increase: +1 MSS per RTT

On loss (detected by triple duplicate ACK):
    ssthresh = cwnd / 2
    cwnd = ssthresh                      // Multiplicative decrease: cut to half
```

Or expressed as a sawtooth waveform:

```
cwnd
  ^
  |              /‾‾‾‾‾‾‾‾‾‾‾\___________/‾‾‾‾‾‾‾\_____
  |            /                 \           /
  |           /                   \         /
  |          /                     \       /
  |         /                       \     /
  |        /                         \   /
  |-------/---------------------------\-/---------> time
  |       ^loss        ^loss        ^loss
  |
  +------[cwnd segments]------------->
          1    4    8   16   32   16   20   24   28   32 ...
```

The **additive increase** probes for more bandwidth slowly. The **multiplicative decrease** backs off sharply when loss signals congestion. This combination converges to a **fair share** — two flows competing for the same link will eventually stabilize at equal bandwidth, regardless of their starting points.

### Why AIMD Is Stable

AIMD is provably stable. In a network with capacity C and N flows, AIMD converges to each flow getting C/N — even if all flows start with wildly different cwnd values. No central coordinator needed. This property is called **convergence to fairness** and is why TCP dominates the internet.

## Congestion Avoidance: Reno, NewReno, Tahoe

The original TCP (Tahoe) treated **any loss** as a signal to restart slow start. This was wasteful for **single packet losses** in a stream — recovering with a full slow start means sending at 1 segment and ramping back up, which can take hundreds of RTTs on high-bandwidth links.

### TCP Reno (1989)

Reno introduced the **fast recovery** phase:

1. **Fast retransmit**: On 3 duplicate ACKs, retransmit the lost segment without waiting for timeout
2. **Fast recovery**: After fast retransmit, cut cwnd to ssthresh = cwnd/2, then increase by 1 MSS per duplicate ACK (partial ACK handling)
3. Resume normal congestion avoidance on successful ACK of the retransmitted segment

```
Normal transmission:
  Segments sent: 1, 2, 3, 4, 5, 6, 7, 8 ...
  Segment 4 lost
  Receiver ACKs: ack=3, ack=3, ack=3 (3 duplicate ACKs for seq 3)

Fast retransmit triggered at 3rd duplicate ACK:
  Retransmit segment 4
  cwnd = ssthresh = cwnd/2  (e.g., 16 → 8 segments)
  ssthresh = cwnd/2        (e.g., 8)

Fast recovery — partial ACKs:
  Receiver ACKs: ack=5 (segments 4 and 5 received)
  cwnd = cwnd - 1 + 1 = cwnd (stay at ssthresh)
  Continue sending segment 9, 10 ...

Final ACK of retransmitted range:
  cwnd = ssthresh
  Resume congestion avoidance
```

### TCP NewReno (1996)

Reno's fast recovery had a problem: **multiple packet losses in one window**. If segments 4 and 7 were both lost, Reno would:
1. Detect loss of segment 4, enter fast recovery
2. Retransmit segment 4
3. Receive partial ACK for segment 5, exit fast recovery prematurely
4. Never retransmit segment 7 → stalled connection, waits for timeout

NewReno fixes this by **not exiting fast recovery until the cumulative ACK passes all outstanding segments**. It tracks how many packets were lost and only exits when the ACK covers past the last lost segment.

### TCP Tahoe (1988)

Tahoe predates Reno and doesn't have fast recovery. Every loss (timeout or duplicate ACK) triggers **full slow start** from cwnd=1. It's simpler but significantly underperforms Reno on lossy links with multiple streams.

## CUBIC: The Modern Default

CUBIC (used by Linux as the default since kernel 2.6.19) replaced Reno's linear cwnd growth with a **cubic function** that scales better on high-bandwidth, high-RTT links — the "bufferbloat" era solution.

### The CUBIC Function

CUBIC grows cwnd according to:

```
W(t) = C * (t - K)³ + W_max

Where:
  t    = time elapsed since last congestion event
  K    = time to reach W_max again = (W_max * β / C)^(1/3)
  W_max = cwnd at last congestion event (before decrease)
  β    = 0.7 (multiplicative decrease factor)
  C    = 0.4 (scaling constant)
```

The cubic shape produces **faster initial growth** than Reno (aggressive probe), but **plateaus near W_max** (avoids overshooting), then **accelerates again** as it moves past the inflection point:

```
cwnd
  ^
  |                    ****  <-- cubic curve plateaus near W_max
  |               ****     ****
  |           ****             ****
  |        ***                     ***
  |      **                           **
  |     *                               *
  |    *                                 *
  |---*-----------------------------------*-------> time
  |   ^                                   ^
  |   W_max                               W_max again
```

### CUBIC Properties

- **High RTT fairness**: CUBIC is designed so that flows with different RTTs get roughly equal bandwidth (unlike Reno, where higher-RTT flows get less)
- **Epoch boundary**: Each RTT is an "epoch"; after an epoch boundary, cwnd growth is reset to match the cubic curve, preventing runaway growth
- **TCP-friendly mode**: CUBIC includes a TCP-friendly region where its growth approximates Reno, ensuring compatibility

### CUBIC vs Reno on High-Bandwidth Links

On a 10 Gbps link with 100ms RTT:
- **Reno**: ~66,000 segments per RTT increase → takes ~1,500 RTTs to fill the pipe
- **CUBIC**: Same throughput in ~15-20 RTTs due to cubic acceleration

## BBR: Google's Model-Based Approach

BBR (Bottleneck Bandwidth and RTT), released by Google in 2016, takes a fundamentally different approach from all the loss-based algorithms above.

### The Problem with Loss-Based Control

Reno, CUBIC, and their variants all **use packet loss as the signal of congestion**. But loss is a *symptom*, not the cause. Networks start queueing packets long before they drop them. In the **bufferbloat** era (oversized router buffers), links can sustain full throughput while buffering gigabytes of data — causing latency spikes of seconds.

BBR asks: **What if we measured the actual bottleneck capacity and RTT directly, instead of inferring them from loss?**

### The BBR State Machine

BBR maintains two estimates:

- **BtlBw** (Bottleneck Bandwidth): Estimated maximum throughput the path can sustain
- **RTprop** (Round-Trip Propagation Time): Estimated minimum RTT observed over a window

From these, BBR computes the **optimal operating point**:

```
BDP = BtlBw * RTprop   (bytes in flight to fully utilize the pipe)
```

BBR cycles through states:

```
         |
    Probe     Probe
    Down      Up
    |    \    /    |
    |     \  /     |
    v      \/      v
  +------+------+
  |  DRAIN      |
  | (drain ex-  |
  |  cess queue)|
  +------+------+
         |
    Startup
    (double
     BtlBw)
         |
         | BtlBw confirmed
         v
  +------+------+
  | PROBE_BW    |  <-- Steady state: cycle through 8 phases
  +------+------+     pacing at BtlBw, periodically prob-
         |           ing for higher BtlBw or lower RTprop
```

**Startup**: Like slow start, doubles BtlBw estimate until 3 RTTs show no throughput increase — confirming the pipe is full.

**Drain**: Immediately afterStartup, BBR drains the excess queue built during the doubling phase by pacing at very low rate.

**Probe BW**: Steady state. BBR cycles through 8 pacing cycles:
- 70% of time: pacing at `pacing_gain = 1.0` (sustaining)
- 8% of time: `pacing_gain = 1.25` (probing for more bandwidth)
- 8% of time: `pacing_gain = 0.75` (draining queue from bandwidth probe)
- Repeated with different phase offsets

**Probe RTT**: Every ~10 seconds (if no lower RTprop seen), BBR enters Probe RTT — reduces cwnd to 4 segments for one RTT to measure the true base RTT without queueing.

### BBR vs CUBIC: Key Differences

| Property | CUBIC | BBR |
|---|---|---|
| Signal | Packet loss | Measured BtlBw + RTprop |
| Queue behavior | Fills buffers (probing) | Actively drains queues |
| RTT fairness | Good (by design) | Excellent |
| Loss tolerance | Good | Degrades gracefully |
| Throughput on lossy links | Good (cwnd stays high) | May underperform |
| Deployment maturity | Mature (kernel default since 2006) | Maturing (since kernel 4.9) |

### BBR's Controversy

BBR's aggressive draining and pacing behavior caused concern in ISP networks — it doesn't fill buffers, which some network devices rely on for traffic shaping. BBR v2 improved this with ECN cooperation and better fairness with cubic flows.

## Practical Tools: Viewing and Changing Congestion Control on Linux

### Checking Current Settings

```bash
# View current congestion control algorithm
sysctl net.ipv4.tcp_congestion_control

# List all available algorithms (compiled into kernel)
sysctl net.ipv4.tcp_available_congestion_control

# Show per-socket congestion control (for existing connections)
ss -i
```

Output example:
```
net.ipv4.tcp_congestion_control = cubic
net.ipv4.tcp_available_congestion_control = reno cubic bbr
```

### Per-Connection Control

```bash
# Set algorithm for a specific socket (via ss)
ss -i 'src 192.168.1.100:443'

# Use iproute2 to set congestion control for a specific destination
ip route change default via 192.168.1.1 initcwnd 10 initrwnd 10
```

### Setting System-Wide Default

```bash
# Temporary (resets on reboot)
sysctl -w net.ipv4.tcp_congestion_control=bbr

# Permanent: add to /etc/sysctl.conf or /etc/sysctl.d/99-network.conf
echo "net.ipv4.tcp_congestion_control = bbr" >> /etc/sysctl.conf
echo "net.ipv4.tcp_congestion_control = cubic" >> /etc/sysctl.conf
```

### Key Sysctl Parameters

```bash
# Initial congestion window (RFC 6928 recommends 10)
sysctl -w net.ipv4.tcp_initcwnd_scaling=1

# Slow start after idle (disable for persistent connections)
# 1 = restart slow start after idle (default), 0 = skip slow start
sysctl -w net.ipv4.tcp_slow_start_after_idle=0

# TCP timestamps (helps with RTT measurement accuracy)
sysctl -w net.ipv4.tcp_timestamps=1

# Enable ECN for BBR (requires network support)
sysctl -w net.ipv4.tcp_ecn=1
```

### Viewing Connection State with `ss`

```bash
# Show all TCP connections with congestion info
ss -ti

# Filter by state
ss -ti state established

# Show bbr-related info for connections using BBR
ss -ti '( transparent )'
```

Example `ss -ti` output:
```
ts sack ecn bbr wscale:7,7 rtt:0.5/1ms pacing_rate 10.6Mbps
```

### Using `ip route` for Path Tuning

```bash
# View default route's current settings
ip route show

# Example output:
# default via 192.168.1.1 dev eth0 initcwnd 10 initrwnd 10

# Change initial congestion window and initial receive window for a route
ip route change default via 192.168.1.1 dev eth0 initcwnd 14 initrwnd 14

# Query specific destination path properties
ip route get to 8.8.8.8
```

## Tuning for Specific Use Cases

### High-Throughput Short-Lived Connections (Web Servers)

```bash
# High initial cwnd for fast transfer of small objects
sysctl -w net.ipv4.tcp_initcwnd_scaling=1

# Use cubic (already default) or try bbr
sysctl -w net.ipv4.tcp_congestion_control=cubic

# Disable slow start after idle for keepalive connections
sysctl -w net.ipv4.tcp_slow_start_after_idle=0
```

### Long-Running Bulk Transfers (File Transfers, Backups)

```bash
# BBR works well for high-RTT high-bandwidth links
sysctl -w net.ipv4.tcp_congestion_control=bbr

# Ensure timestamps are on for accurate RTT measurement
sysctl -w net.ipv4.tcp_timestamps=1

# Enable window scaling for high-BDP paths
sysctl -w net.ipv4.tcp_window_scaling=1
```

### Satellite/High-Latency Links (RTT > 500ms)

```bash
# Use BBR for its better high-RTT performance
sysctl -w net.ipv4.tcp_congestion_control=bbr

# Increase max buffer sizes
sysctl -w net.core.rmem_max=16777216
sysctl -w net.core.wmem_max=16777216
sysctl -w net.ipv4.tcp_rmem="4096 87380 16777216"
sysctl -w net.ipv4.tcp_wmem="4096 65536 16777216"

# Disable slow start after idle — essential for high-RTT paths
sysctl -w net.ipv4.tcp_slow_start_after_idle=0
```

## Measuring and Benchmarking

### Which Algorithm Is Active?

```bash
# Check current system default
cat /proc/sys/net/ipv4/tcp_congestion_control

# For a running process, strace the setsockopt call
strace -e trace=setsockopt -f nginx 2>&1 | grep congestion
```

### Throughput Benchmarking

```bash
# Using iperf3 (server on one machine, client on another)
# Server:
iperf3 -s

# Client (TCP):
iperf3 -c <server-ip> -t 30 -R  # -R for reverse mode (server sends)

# Test with specific congestion control:
iperf3 -c <server-ip> -t 30 -C cubic   # test with cubic
iperf3 -c <server-ip> -t 30 -C bbr      # test with bbr
```

### Observing cwnd Changes in Real Time

```bash
# Use ss to observe connection stats
watch -n 0.5 'ss -ti dst <target-ip>'

# Sample output (cwnd growth visible):
# ts sack ecn bbr wscale:7,7 rtt:5/10ms cwnd:45
```

### Packet Capture Analysis

```bash
# Capture with tcpdump, then analyze in Wireshark
# tcpdump -i eth0 -w capture.pcap 'tcp port 80'

# In Wireshark, use TCP stream stats:
# Statistics > TCP StreamGraph > Sequence Diagram
# This visualizes retransmissions, duplicate ACKs, and cwnd growth
```

Testing TCP congestion algorithms? [Vultr](https://www.vultr.com/?ref=8914132) offers 10Gbps networking for realistic experiments. <!-- AFFILIATE: vultr -->

## Further Reading

- **RFC 5681** — TCP Congestion Control (the authoritative spec)
- **RFC 9002** — TCP Selective Acknowledgment (SACK)
- **RFC 8323** — TCP Usage of BBR for Bulk Transfer
- **Cardwell et al., "BBR: Congestion-Based Congestion Control"** — ACM Queue, 2017
- **Ha et al., "CUBIC: A New TCP-Friendly High-Speed TCP Variant"** — ACM SIGOS, 2008
- **Linux kernel documentation** — `Documentation/networking/ip-sysctl.rst` (covers all `sysctl` parameters)
- **netdevconf talks** — BBR development updates (YouTube, various years)

---

*Understanding congestion control gives you a foundation for reasoning about network performance, tuning distributed systems, and debugging mysterious throughput issues. The algorithms are decades old but still actively evolved — BBR is only the latest chapter in an ongoing story.*

## Related Posts

- [TCP/IP Internals](/posts/tcp-ip-internals-packet-journey) — Congestion control operates within the TCP layer of the IP stack
- [eBPF Linux Observability](/posts/ebpf-linux-observability-framework) — eBPF programs can instrument TCP stack events for observability without kernel modules
- [Linux Memory Debugging](/posts/linux-memory-debugging-profiling) — Bufferbloat and memory pressure interact in production network queues
Want to experiment with TCP congestion control in the cloud? [Vultr's high-performance instances](https://www.vultr.com/?ref=8914132) offer 10Gbps networking ideal for network tuning experiments. <!-- AFFILIATE: vultr -->

## Tools & Services

- **[Vultr](https://www.vultr.com/?ref=8914132)** — High-performance cloud VPS with 10Gbps networking for TCP tuning experiments. $100 free credit for new accounts. <!-- AFFILIATE: vultr -->
- **[DigitalOcean](https://www.digitalocean.com/affiliates)** — Simple cloud hosting for network protocol experiments. $100 free credit. <!-- AFFILIATE: digitalocean -->
