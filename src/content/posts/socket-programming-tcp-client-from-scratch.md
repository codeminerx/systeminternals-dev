---
title: "Raw Socket Programming: Building a Simple TCP Client from Scratch"
slug: socket-programming-tcp-client-from-scratch
description: "A deep dive into POSIX socket programming — from file descriptors to the TCP 3-way handshake, with working C code, strace traces, and edge-triggered I/O."
date: 2026-05-04
tags: [c, sockets, networking, tcp, posix, systems-programming]
---

# Raw Socket Programming: Building a Simple TCP Client from Scratch

Every network connection on a Unix-like system starts with the same primitive: a socket. Before your HTTP client connects to a server, before your database client talks to Postgres, there is a socket — a file descriptor that happens to live on the network. Understanding sockets at this layer gives you a real model of what your high-level libraries are doing underneath.

This post is for backend developers who use the socket API daily but want to see what's actually happening when you `connect()` or `send()`. We'll build a working TCP client in C, trace it with `strace`, walk through the TCP 3-way handshake in detail, and cover the pitfalls that bite production systems.

---

## 1. What Is a Socket?

A socket is a **file descriptor** — an integer that the kernel uses to track an I/O endpoint. On Unix, almost everything is a file: regular files, terminals, pipes, and sockets all share the same descriptor table. When you call `socket()`, you get back a plain int that behaves like any other fd.

The modern socket API originates from **Berkeley sockets**, developed in the early 1980s for 4.2BSD Unix. It was designed to abstract network communication into a file-like interface. Today it lives in `<sys/socket.h>`, `<netinet/in.h>`, and `<arpa/inet.h>` — portable across Linux, macOS, BSD, and even Windows (via Winsock).

The key insight: **sockets are endpoints**. A connection has two ends — a local socket and a remote socket. The local side has an IP address and a port; the remote side has an IP address and a port. Together they form a 4-tuple that uniquely identifies every TCP connection on the wire.

---

## 2. Socket Types

When you call `socket()`, you specify a **domain**, **type**, and **protocol**:

```c
int sock = socket(AF_INET, SOCK_STREAM, 0);
```

| Domain | Meaning |
|--------|---------|
| `AF_INET` | IPv4 |
| `AF_INET6` | IPv6 |
| `AF_UNIX` | Local Unix domain |

| Type | Meaning |
|------|---------|
| `SOCK_STREAM` | Reliable, ordered, connection-oriented (TCP) |
| `SOCK_DGRAM` | Datagram, no connection (UDP) |
| `SOCK_RAW` | Raw IP — you build the packet yourself |

`SOCK_STREAM` over `AF_INET` gives you TCP. `SOCK_DGRAM` gives you UDP. `SOCK_RAW` lets you craft IP packets directly — used by tools like `ping` and `traceroute`, and by firewall tools like `nft`.

---

## 3. The Client Workflow

A TCP client's syscall sequence:

```
socket()  →  connect()  →  send() / recv()  →  close()
```

**`socket()`** — Creates the file descriptor, asks the kernel for a TCP socket.

**`connect()`** — Initiates the 3-way handshake with the server. Blocks until the connection is established or fails.

**`send()` / recv()`** — Copy data between user space and kernel socket buffers.

**`close()`** — Tears down the connection, sends a FIN.

That's the happy path. In reality you also need error handling: `connect()` returns `-1` on error and sets `errno`. A robust client checks every syscall.

---

## 4. The Server Workflow

A TCP server's syscall sequence:

```
socket()  →  bind()  →  listen()  →  accept()  →  send() / recv()  →  close()
```

**`bind()`** — Attaches the socket to a specific IP address and port. `INADDR_ANY` means "bind to all interfaces."

**`listen()`** — Marks the socket as **passive** — a listening socket that will receive incoming connections. The second argument is the **backlog**: how many pending (not yet accepted) connections the kernel queues.

**`accept()`** — Blocks until a client connects. Returns a **new file descriptor** for that specific connection. The listening socket stays open and keeps queuing new connections.

The key distinction: `bind()` + `listen()` on the **listening socket**; `accept()` creates a **connected socket** that you actually `send()`/`recv()` on.

---

## 5. Code: TCP Client in C

```c
#define _POSIX_C_SOURCE 200809L

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>

#define SERVER_PORT 8080
#define SERVER_ADDR "127.0.0.1"
#define MSG "Hello from client\0"

int main(void) {
    int fd;
    struct sockaddr_in addr;
    char buf[256];
    ssize_t n;

    /* --- Step 1: create the socket --- */
    fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) {
        perror("socket");
        exit(EXIT_FAILURE);
    }
    printf("[client] socket fd = %d\n", fd);

    /* --- Step 2: build the address struct --- */
    memset(&addr, 0, sizeof(addr));
    addr.sin_family      = AF_INET;          /* IPv4 */
    addr.sin_port        = htons(SERVER_PORT);
    /* inet_pton converts a string like "127.0.0.1" to binary form */
    if (inet_pton(AF_INET, SERVER_ADDR, &addr.sin_addr) <= 0) {
        perror("inet_pton");
        close(fd);
        exit(EXIT_FAILURE);
    }

    /* --- Step 3: connect --- */
    if (connect(fd, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
        perror("connect");
        close(fd);
        exit(EXIT_FAILURE);
    }
    printf("[client] connected to %s:%d\n", SERVER_ADDR, SERVER_PORT);

    /* --- Step 4: send data --- */
    if (send(fd, MSG, strlen(MSG), 0) < 0) {
        perror("send");
        close(fd);
        exit(EXIT_FAILURE);
    }
    printf("[client] sent: \"%s\"\n", MSG);

    /* --- Step 5: receive response --- */
    memset(buf, 0, sizeof(buf));
    n = recv(fd, buf, sizeof(buf) - 1, 0);
    if (n < 0) {
        perror("recv");
        close(fd);
        exit(EXIT_FAILURE);
    }
    printf("[client] received: \"%s\"\n", buf);

    /* --- Step 6: clean up --- */
    close(fd);
    printf("[client] connection closed\n");
    return 0;
}
```

Key points:
- `inet_pton()` — "presentation to network" — converts the dotted-decimal string to a 32-bit binary address in network byte order.
- `htons()` — "host to network short" — converts the port number to network byte order (big-endian). x86 is little-endian, so this matters.
- `send()` and `recv()` return the number of bytes transferred, or `-1` on error. **They can return fewer bytes than you asked for.** Always check the return value.
- Always `close()` the fd — socket leaks are real, especially in long-running processes.

---

## 6. Code: TCP Server in C

```c
#define _POSIX_C_SOURCE 200809L

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>

#define PORT 8080
#define BACKLOG 10

int main(void) {
    int listen_fd, conn_fd;
    struct sockaddr_in srv_addr, cli_addr;
    socklen_t cli_len;
    char buf[256];
    ssize_t n;

    /* --- Step 1: create the socket --- */
    listen_fd = socket(AF_INET, SOCK_STREAM, 0);
    if (listen_fd < 0) {
        perror("socket");
        exit(EXIT_FAILURE);
    }

    /* --- Socket options: allow address reuse immediately after kill --- */
    int opt = 1;
    if (setsockopt(listen_fd, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt)) < 0) {
        perror("setsockopt SO_REUSEADDR");
        close(listen_fd);
        exit(EXIT_FAILURE);
    }

    /* --- Step 2: bind to port --- */
    memset(&srv_addr, 0, sizeof(srv_addr));
    srv_addr.sin_family      = AF_INET;
    srv_addr.sin_addr.s_addr = htonl(INADDR_ANY);  /* all interfaces */
    srv_addr.sin_port        = htons(PORT);

    if (bind(listen_fd, (struct sockaddr *)&srv_addr, sizeof(srv_addr)) < 0) {
        perror("bind");
        close(listen_fd);
        exit(EXIT_FAILURE);
    }
    printf("[server] bound to port %d\n", PORT);

    /* --- Step 3: listen --- */
    if (listen(listen_fd, BACKLOG) < 0) {
        perror("listen");
        close(listen_fd);
        exit(EXIT_FAILURE);
    }
    printf("[server] listening (backlog=%d)\n", BACKLOG);

    /* --- Step 4: accept loop --- */
    while (1) {
        memset(&cli_addr, 0, sizeof(cli_addr));
        cli_len = sizeof(cli_addr);
        conn_fd = accept(listen_fd, (struct sockaddr *)&cli_addr, &cli_len);
        if (conn_fd < 0) {
            perror("accept");
            continue;  /* don't exit; keep listening */
        }
        printf("[server] client connected from %s:%d\n",
               inet_ntoa(cli_addr.sin_addr),
               ntohs(cli_addr.sin_port));

        /* --- Step 5: echo back whatever the client sends --- */
        memset(buf, 0, sizeof(buf));
        n = recv(conn_fd, buf, sizeof(buf) - 1, 0);
        if (n > 0) {
            printf("[server] received: \"%s\"\n", buf);
            if (send(conn_fd, buf, n, 0) < 0) {
                perror("send");
            }
        }
        close(conn_fd);
        printf("[server] client disconnected\n");
    }

    /* --- (never reached in this simple version) --- */
    close(listen_fd);
    return 0;
}
```

Notable decisions:
- **`SO_REUSEADDR`** — Without this, after killing the server you'll get "Address already in use" for about 60 seconds (the TIME_WAIT state). This option tells the kernel to allow binding to a socket in TIME_WAIT. Essential during development.
- **`INADDR_ANY`** — Binds to all available IPv4 addresses. Useful for servers that need to accept connections on any interface.
- `ntohs()` / `ntohl()` — "network to host" — reverse of `htons`/`htonl`. Convert from network byte order back to host byte order.

---

## 7. The TCP 3-Way Handshake

Here's what actually happens when you call `connect()`:

```
Client                        Server
  |                             |
  |  <-- SYN (seq=x)            |  Client:发送SYN, 进入SYN_SENT状态
  |                             |
  |  SYN-ACK (seq=y, ack=x+1) -->|  Server:收到SYN, 发送SYN-ACK, 进入SYN_RCVD状态
  |                             |
  |  ACK (seq=x+1, ack=y+1) -->  |  Client:收到SYN-ACK, 发送ACK, 进入ESTABLISHED状态
  |                             |
  |  (ESTABLISHED)              |  Server:收到ACK, 进入ESTABLISHED状态
```

```
         TCP 3-Way Handshake State Diagram

  CLOSED                                      LISTEN
    |                                           ^
    |  listen()                                |
    v                                           |
  LISTEN  <----- accept() -----                |
    ^       (new conn_fd)                      |
    |                                           |
 SYN_SENT                                      |
    |  SYN --------->                          |
    |  <---------- SYN-ACK                     |
    |  ACK --------->                          |
    v                                           |
 ESTABLISHED  <------ connections ----         |
                                  (incoming    |
                                   SYN)       |
                                  -----------  |
                                           v  |
                                       SYN_RCVD
                                          |  ^
                                          |  |
                                       (ACK)
                                          |  |
                                          v  |
                                       ESTABLISHED
```

**Sequence numbers** are initialized randomly (to prevent replay attacks). Each byte of data sent increments the sequence number by 1.

Why three messages?
- **SYN** — Client proves it can be reached at its IP (and initializes seq number).
- **SYN-ACK** — Server proves it can be reached at the port it's listening on.
- **ACK** — Client confirms the server's port is open.

The data transfer phase can't begin until both sides have confirmed the other's existence. Three messages, two round trips.

---

## 8. Socket Options

Every production socket system hits these eventually:

### `SO_REUSEADDR`

We've already seen it above. If the server crashes or is killed and restarted quickly, the kernel holds the port in `TIME_WAIT`. Setting `SO_REUSEADDR` lets the server restart and bind immediately.

### `SO_KEEPALIVE`

Enables periodic "are you alive?" messages on an idle connection. If the other end has crashed, the connection is killed after ~7200 seconds (2 hours on Linux, configurable). Useful for long-lived connections where neither side sends data for hours.

Not a substitute for application-level heartbeats — it only detects a dead machine, not a dead application.

### `TCP_NODELAY`

By default, Linux uses **Nagle's algorithm** — small sends are buffered for ~40ms to coalesce them into larger packets. This reduces overhead but adds latency.

For interactive applications (Redis clients, game servers, interactive SSH sessions), disable Nagle:

```c
int flag = 1;
setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &flag, sizeof(flag));
```

For bulk transfer (file transfers, HTTP), leave Nagle on — it improves throughput.

---

## 9. `select`/`poll` vs `epoll`

Early Unix solved the "wait for multiple file descriptors" problem with `select()`:

```c
fd_set read_fds;
FD_ZERO(&read_fds);
FD_SET(fd1, &read_fds);
FD_SET(fd2, &read_fds);

struct timeval timeout = { .tv_sec = 5, .tv_usec = 0 };
int nfds = select(max_fd + 1, &read_fds, NULL, NULL, &timeout);
```

`select()` works, but it has a fundamental problem: every call rebuilds the `fd_set` from scratch, and **the fd set is capped at `FD_SETSIZE` (often 1024)**. For high-connection servers, this is a bottleneck.

**`poll()`** replaced `select()` with a dynamically-sized array:

```c
struct pollfd fds[2];
fds[0].fd = fd1;
fds[0].events = POLLIN;
fds[1].fd = fd2;
fds[1].events = POLLIN;

int nfds = poll(fds, 2, 5000);  /* 5 second timeout */
```

`poll()` removes the FD_SETSIZE limit but still requires a linear scan of all fds on every call.

**`epoll()`** solves this by moving the "which fds are ready?" tracking into the kernel:

```c
int epfd = epoll_create1(0);
struct epoll_event ev = { .events = EPOLLIN, .data.fd = fd };
epoll_ctl(epfd, EPOLL_CTL_ADD, fd, &ev);

/* wait for events — only returns ready fds, no scan */
struct epoll_event events[10];
int n = epoll_wait(epfd, events, 10, -1);  /* -1 = infinite timeout */
```

`epoll` is **edge-triggered** — it only tells you about state *changes*, not current state. If a socket has data waiting, `epoll_wait` returns it once. You must drain the buffer completely before the next `epoll_wait` call. Miss a state change? You lose events. With level-triggered (like `poll`), you just keep polling and it keeps telling you.

The advantage: `epoll_wait` returns only the active fds, in O(1) time, not O(n). A server with 100,000 idle connections pays almost no cost — `poll` would scan all 100,000 every call.

On Linux: `epoll`. On macOS (no `epoll`): use `kqueue`. The idea is the same.

---

## 10. Common Pitfalls

### Partial sends

`send()` may send fewer bytes than you asked for. Always check the return value and loop until all bytes are sent:

```c
ssize_t send_all(int fd, const void *buf, size_t len) {
    size_t remaining = len;
    const char *p = buf;
    while (remaining > 0) {
        ssize_t n = send(fd, p, remaining, 0);
        if (n < 0) return -1;
        p += n;
        remaining -= n;
    }
    return len;
}
```

### SIGPIPE

If you `send()` on a connection where the other end has closed, your process receives `SIGPIPE` and dies by default. Fix:

```c
signal(SIGPIPE, SIG_IGN);
```

Or check `send()` return value (it returns `-1` and sets `errno` to `EPIPE`).

### Buffer management

Don't assume `recv()` returns a complete message. TCP is a stream protocol, not a datagram protocol. The application protocol must define message boundaries (length-prefix, newline-delimited, etc.):

```c
/* correct: recv in a loop until you have a complete message */
size_t total = 0;
while (total < expected_len) {
    n = recv(fd, buf + total, expected_len - total, 0);
    if (n <= 0) { /* handle close or error */ break; }
    total += n;
}
```

### TIME_WAIT

When a connection closes, the endpoint that initiates the close (usually the client) stays in `TIME_WAIT` for 60-120 seconds. This ensures any delayed packets are absorbed before the port is reused.

For servers that close many connections rapidly (load balancers, proxies), `SO_REUSEADDR` is mandatory. For clients that connect/disconnect frequently, the client-side port may get exhausted — consider **connection pooling** or using `SO_REUSEADDR` and binding to a specific source port range.

---

## 11. `strace` in Action

Here's what the client syscalls actually look like. Run the server in one terminal:

```bash
gcc -Wall -Wextra -o server server.c
./server
```

And the client in another:

```bash
gcc -Wall -Wextra -o client client.c
strace -e trace=read,write,connect,close,socket ./client
```

*Want to run these examples on a remote server? [Deploy a VPS on Vultr](https://www.vultr.com/?ref=8914132) and compile the code yourself — $100 free credit for new sign-ups.*

You'll see something like:

```
socket(AF_INET, SOCK_STREAM, 0)        = 3
connect(3, {sin_family=AF_INET, sin_port=htons(8080), sin_addr=inet_addr("127.0.0.1")}, 16) = 0
write(3, "Hello from client", 16)       = 16
read(3, "Hello from server", 17)        = 17
close(3)                                = 0
```

The fd `3` appears because fds 0, 1, 2 are already `stdin`, `stdout`, `stderr`. What you see in `strace` is exactly what the kernel does for you. Every `send()` is a `write()` to the socket fd. Every `recv()` is a `read()` from it.

For deeper tracing:

```bash
# Trace all syscalls, filter to just network-related
strace -e trace=network -f ./client

# Show time spent in each syscall
strace -T -e trace=read,write ./client

# Show all syscalls with full details
strace -tt -f ./client
```

The raw syscall view is the ground truth. Everything else (libuv, libevent, Go's net package, Node's `net` module) is a layer on top of these primitives.

---

## 12. Further Reading

- **"The Socket API"** — Stevens & Rago, *Advanced Programming in the UNIX Environment*, Ch. 16. The definitive Unix network programming reference.
- **"TCP/IP Illustrated"** — Stevens, Vol. 1. The detailed walkthrough of the TCP/IP stack. Not for the faint-hearted, but nothing else gives you this depth.
- **"Unix Network Programming"** — Stevens, Vol. 1. A complete guide to the client-server model with working code.
- Linux manual pages: `socket(2)`, `connect(2)`, `bind(2)`, `listen(2)`, `accept(2)`, `epoll(4)`, `tcp(7)`
- `/proc/sys/net/ipv4/tcp_*` — Linux TCP tuning knobs. Browse while you're debugging.
- Wireshark — Watch the actual packets for the handshake and data transfer. `tcpdump` for command-line capture.

---

Sockets are thirty-five years old and still at the bottom of every network program you write. The better you understand this layer, the better you understand everything above it.

## Related Posts

- [TCP/IP Internals](/posts/tcp-ip-internals-packet-journey) — Raw sockets implement the TCP/IP stack described in this post
- [eBPF Linux Observability](/posts/ebpf-linux-observability-framework) — eBPF programs can hook socket creation for network observability
- [Rate Limiter System Design](/posts/rate-limiter-system-design) — Connection tracking and socket state are fundamental to distributed rate limiting