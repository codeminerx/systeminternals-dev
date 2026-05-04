---
title: "TCP/IP Internals: How a Packet Travels Across the Network"
description: "A deep dive into the TCP/IP protocol stack, from application data to physical frames, and everything that happens in between."
date: 2024-03-08
tags: ["networking", "tcp", "ip", "protocols", "linux", "packet"]
---

Every time you load a webpage, send an email, or stream a video, your data is broken into packets, wrapped in headers, sent across the network, and reassembled on the other side. Understanding how this works is fundamental to diagnosing network issues, optimizing performance, and writing distributed systems.

## The TCP/IP Model: A Brief Overview

The internet uses a layered protocol stack. Each layer has a specific job and communicates with the corresponding layer on the other end:

| Layer | Protocol | Purpose |
|-------|----------|---------|
| Application | HTTP, DNS, SMTP | Application-specific protocols |
| Transport | TCP, UDP | Host-to-host communication |
| Internet | IP | Logical addressing and routing |
| Link | Ethernet, WiFi | Physical addressing on a local network |

Data flows down through the layers on the sending side, across the physical medium, and back up through the layers on the receiving side.

## The Journey: From Application to Wire

### Step 1: Application Layer (HTTP)

Let's say you're sending an HTTP GET request. Your browser creates the HTTP message:

```
GET /index.html HTTP/1.1\r\n
Host: example.com\r\n
\r\n
```

This is just bytes. The application layer doesn't know or care how it gets transmitted.

### Step 2: Transport Layer (TCP)

TCP takes the application data and adds its own header. This is where things get interesting.

#### TCP Header Structure

```
 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|          Source Port          |        Destination Port       |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                       Sequence Number                         |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                    Acknowledgment Number                      |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
| Offset| Flags     |              Window                       |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|           Checksum            |         Urgent Pointer        |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                    Options and Padding                       |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                        Data                                   |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
```

Key fields:
- **Source/Destination Port**: Which application on each end (e.g., port 80 for HTTP)
- **Sequence Number**: Byte position in the data stream (for ordering and reassembly)
- **Acknowledgment Number**: Next expected byte (for reliability)
- **Flags**: SYN, ACK, FIN, RST, PSH, URG (control the connection)
- **Window**: How much data the receiver can accept (flow control)

#### TCP Three-Way Handshake

Before any data flows, TCP establishes a connection:

```
Client                                    Server
  │                                         │
  │─── SYN, seq=1000 ────────────────────────▶│  Client wants to connect
  │◀── SYN-ACK, seq=2000, ack=1001 ──────────│  Server agrees, acknowledges
  │─── ACK, seq=1001, ack=2001 ──────────────▶│  Client acknowledges
  │                                         │
  │         Connection Established          │
  │                                         │
```

This exchange ensures:
1. The server is reachable
2. The server is willing to accept the connection
3. Both sides know each other's sequence numbers

#### TCP Termination

Connections close with a four-way handshake:

```
Client                                    Server
  │                                         │
  │─── FIN, seq=500 ────────────────────────▶│  Client wants to close
  │◀── ACK ──────────────────────────────────│  Server acknowledges
  │◀── FIN, seq=300 ─────────────────────────│  Server also wants to close
  │─── ACK ──────────────────────────────────▶│  Client acknowledges
  │                                         │
  │         Connection Terminated           │
  │                                         │
```

### Step 3: Internet Layer (IP)

Now we have a TCP segment. The IP layer wraps it in an IP header:

```
 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|Version|  IHL  |   TOS      |        Total Length              |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|         Identification        |Flags|      Fragment Offset    |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|   TTL        |   Protocol    |        Header Checksum         |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                      Source Address                           |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                    Destination Address                        |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                    Options (if IHL > 5)                       |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
```

Key fields:
- **Version**: 4 for IPv4, 6 for IPv6
- **TTL (Time to Live)**: Maximum hops before packet is discarded
- **Protocol**: What's in the payload (6 = TCP, 17 = UDP, 1 = ICMP)
- **Source Address**: 32-bit IPv4 address of sender
- **Destination Address**: 32-bit IPv4 address of recipient

The TTL field is crucial. Each router decrements it by 1. When it reaches 0, the router sends an ICMP "Time Exceeded" message back and discards the packet. This prevents routing loops from consuming bandwidth forever.

### Step 4: Link Layer (Ethernet)

Finally, the IP packet becomes an Ethernet frame:

```
+---------------------------------------+-------------------
| Destination MAC | Source MAC | Type  | Payload (IP packet)
+---------------------------------------+-------------------
       6 bytes          6 bytes    2           46-1500 bytes
```

- **Destination MAC**: Hardware address of the next hop (router)
- **Source MAC**: Your network interface's MAC address
- **Type**: 0x0800 for IPv4, 0x0806 for ARP, 0x86DD for IPv6

## The Physical Journey

### On a Local Network (Same Subnet)

If the destination is on your local network, the frame goes directly to the destination:

```
Your Computer → Switch → Destination Computer
```

The switch learns MAC addresses by watching traffic. It builds a table mapping MAC addresses to physical ports.

### Across Networks (Requires Router)

If the destination is on a different network, the frame goes to your default gateway (router):

```
Your Computer → Switch → Router → ... → Destination Network → Switch → Destination
```

The router:
1. Receives the frame and strips the Ethernet header
2. Looks at the destination IP address
3. Consults its routing table
4. Creates a new frame for the next hop
5. Decrements TTL and updates checksums

### Routing Table Deep Dive

A routing table determines where packets go. Here's an example:

```bash
$ ip route show
default via 192.168.1.1 dev eth0 proto dhcp
192.168.1.0/24 dev eth0 proto kernel scope link src 192.168.1.100
10.0.0.0/8 via 192.168.1.254 dev eth0
```

- **default**: Catch-all for unmatched destinations (go through 192.168.1.1)
- **192.168.1.0/24**: Local network (directly connected)
- **10.0.0.0/8**: Specific route through 192.168.1.254

The routing table is searched in order of specificity (longest prefix match). 10.0.0.0/8 is more specific than default, so those packets go through 192.168.1.254.

## Network Address Translation (NAT)

Most home and office networks use NAT. Your private IP address gets translated to a public IP address:

```
Private Network (192.168.1.0/24)     NAT Router         Internet
192.168.1.100:54321 ─────────────────▶ 203.0.113.5:54321 ──▶ example.com:80
```

When the response comes back, the router knows to send it to 192.168.1.100.

NAT has implications:
- Servers can't be easily reached from outside (you need port forwarding)
- It's a security feature (internal IPs aren't exposed)
- It consumes router resources (must track each connection)

## Packet Fragmentation

The link layer has a maximum frame size called MTU (Maximum Transmission Unit). For Ethernet, it's typically 1500 bytes.

If an IP packet exceeds the MTU, it gets fragmented:

```
Original packet (4000 bytes)
         │
         ▼
   ┌─────┼─────┐
   ▼     ▼     ▼
 Fragment 1  Fragment 2  Fragment 3
  (1500)    (1500)    (1048)
```

Each fragment has its own IP header with:
- MF flag (More Fragments) set except on last fragment
- Fragment offset telling where this piece belongs

The destination reassembles the fragments. If any piece is missing, the entire packet is discarded.

## Tools for Observing Packets

### tcpdump: Packet Sniffing

```bash
# Capture all HTTP traffic
sudo tcpdump -i eth0 -A 'tcp port 80 and tcp[((tcp[12:1] & 0xf0) >> 2):2] = 0x4745'

# Capture specific host
sudo tcpdump -i eth0 host 93.184.216.34

# Capture and save to file
sudo tcpdump -i eth0 -w capture.pcap 'tcp port 80'
```

### ip: Interface Configuration

```bash
# Show all interfaces
ip addr show

# Show routing table
ip route show

# Show neighbor table (ARP cache)
ip neigh show

# Trace path to destination
traceroute example.com

# Monitor network statistics
ss -tulnp
```

### wireshark/tshark: Deep Packet Analysis

```bash
# Capture and display interactively
wireshark &

# Capture from CLI and analyze later
tshark -i eth0 -w capture.pcap

# Read capture file
tshark -r capture.pcap -Y 'http.request.uri contains "login"'
```

## TCP Performance: Windows, Buffering, and Probing

### TCP Window Size

The window size in the TCP header tells the sender how much data can be sent before waiting for an acknowledgment. Larger windows = better throughput for high-latency links.

Modern systems support **TCP Window Scaling** (RFC 1323), which multiplies the window size. Without scaling, the maximum window is 65KB; with scaling, it can be much larger.

### Slow Start and Congestion Control

TCP doesn't just blast data at full speed. It starts slowly and speeds up:

```
Initial: send 1 segment
    │
    ▼ (ACK received)
Send 2 segments
    │
    ▼ (ACKs received)
Send 4 segments
    │
    ▼
Send 8 segments
    │
    ▼
... exponential increase until packet loss
```

When loss is detected, TCP:
1. Cuts the send rate in half
2. Then increases more slowly
3. Continues probing for available bandwidth

### bufferbloat

Modern networks can buffer too much data. This causes high latency even when throughput is fine:

```
Normal:     RTT = 20ms
With bufferbloat: RTT = 2000ms (packets wait in queue)
```

Tools like **sqm-scripts** on Linux and **Cake** scheduler fight bufferbloat.

## DNS: The Phonebook of the Internet

Before any of this happens, your computer needs to know the IP address of the destination. DNS translates names to addresses:

```bash
$ nslookup example.com
Server:    8.8.8.8
Address:   8.8.8.8#53

Non-authoritative answer:
Name:    example.com
Address: 93.184.216.34
```

DNS lookups happen recursively:
1. Your computer asks the configured resolver (often 8.8.8.8 or your router)
2. If the resolver doesn't know, it asks root nameservers
3. Root servers point to TLD servers (.com, .net, etc.)
4. TLD servers point to authoritative nameservers
5. Authoritative nameservers return the answer

Results are cached at each level. DNS entries have a TTL (Time To Live) controlling how long they're cached.

## Conclusion

Every packet on the internet travels a well-defined path through the TCP/IP stack:

1. Application creates data (HTTP request)
2. TCP adds port numbers, sequence numbers, and reliability
3. IP adds source and destination IP addresses
4. Ethernet adds MAC addresses for local delivery
5. Routers along the path read IP headers and forward packets
6. TTL prevents infinite loops
7. The destination reverses the process and sends back acknowledgments

Understanding this stack is essential for:
- Debugging connectivity issues
- Optimizing network performance  
- Writing distributed applications
- Configuring firewalls and routers

The next time you run `traceroute` or capture packets with `tcpdump`, you'll know exactly what's happening at each step.