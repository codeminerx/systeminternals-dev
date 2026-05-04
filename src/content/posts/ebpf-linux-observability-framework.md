---
title: "eBPF: Linux's Most Powerful Observation Framework"
description: "What eBPF is, how it works, why it matters compared to kernel modules, and practical tools like bpftrace, tcpdump -B, and execsnoop."
date: 2026-05-03
tags: ["linux", "ebpf", "observability", "performance", "kernel", "debugging", "bpf"]
---

For decades, if you wanted to observe Linux kernel behavior in real time — every system call, every network packet, every function call inside the kernel — you had two options: kernel modules (dangerous, can crash your system) or adding printk statements and rebuilding the kernel (slow, impractical in production). Neither was good.

eBPF changed all of that. It provides a safe, programmable interface to the Linux kernel that lets you run custom logic in response to events — without modifying kernel code, without loading potentially unstable modules, and with minimal overhead.

If you're debugging production systems, writing observability tools, or building security instrumentation, eBPF is the most powerful tool in your arsenal.

## What Problem eBPF Solves

The Linux kernel is the arbiter of everything: every file open, every network packet, every process creation, every memory allocation. Observing it has always been a trade-off between depth and safety.

**Kernel modules** can do anything — but they run with full kernel privileges. A bug crashes the whole system. They're also tied to specific kernel versions and require source or ABI compatibility.

**User-space tools** like `strace` or `tcpdump` are safe, but they sample or filter after the fact. `strace` intercepts system calls but adds significant overhead. `tcpdump` copies network packets to userspace for analysis. You're always one step removed from the event.

eBPF sits in between: kernel-level execution speed with user-space safety, and the ability to observe almost any kernel event.

## How eBPF Works: Bytecode, Verifier, and JIT

When you write an eBPF program, you're writing code that will run inside the kernel. This sounds terrifying, but eBPF has multiple safety guards.

### The eBPF Program Lifecycle

```
User writes eBPF program (in C, Go, or eBPF assembly)
         │
         ▼
    Compiler (clang) compiles to eBPF bytecode
         │
         ▼
    Load program into kernel via bpf() syscall
         │
         ▼
    Kernel Verifier: validates the program is safe
    - No infinite loops (or loops that are proven to terminate)
    - No out-of-bounds memory access
    - No unsafe pointer operations
    - Must complete within a bounded number of instructions
         │
         ▼ (if verified)
    JIT compiler converts bytecode to native machine code
         │
         ▼
    Program attached to a kernel hook (probe, tracepoint, etc.)
         │
         ▼
    Kernel executes program when hook triggers
```

The verifier is key. It performs static analysis on your program before loading it, simulating all possible execution paths. If your program could ever access memory it shouldn't, loop forever, or cause a kernel panic, the verifier rejects it.

### Types of eBPF Programs

eBPF isn't one thing — there are many hook points:

| Type | Hook | Use Case |
|------|------|----------|
| **kprobe** | Dynamic kernel function entry/exit | Trace any kernel function |
| **uprobe** | Dynamic userspace function entry/exit | Trace library or application functions |
| **tracepoint** | Static, stable kernel tracepoints | Low-overhead kernel tracing |
| **sched** | Scheduler events | Trace process scheduling |
| **xdp** | Network packet at NIC driver | Fast packet filtering, DDoS mitigation |
| **tc** | Traffic control at qdisc | Network traffic shaping and filtering |
| **lsm** | Linux Security Module hooks | Security policy enforcement |
| **perf** | Hardware and software perf events | CPU profiling, sampling |

The distinction between kprobe and tracepoint matters: kprobes can attach to any kernel function (even internal, unstable ones), but those functions can change between kernel versions. Tracepoints are stable ABI — they're guaranteed to not break across kernel versions.

## Maps: eBPF's Data Store

eBPF programs need somewhere to store data. That's what **eBPF maps** are for:

```c
// A hash map from UID to counter
struct {
    __uint(type, BPF_MAP_TYPE_HASH);
    __uint(max_entries, 10240);
    __type(key, __u32);
    __type(value, __u64);
} counter_map SEC(".maps");
```

Maps are shared between the eBPF program (kernel-space) and user-space helpers. Common map types:

- **Hash** — Key-value store, O(1) lookup
- **Array** — Index-based, good for counters
- **Per-CPU Array** — Each CPU has its own copy, avoids locking
- **Ring Buffer** — Efficient event streaming to userspace
- **Stack Trace** — Capture kernel stack traces

From userspace, you can read and write maps via the `bpf()` syscall:

```python
import ctypes
# Access the map from Python using bcc
from bcc import BPF

program = """
BPF_HASH(counter, u32);
"""

b = BPF(text=program)
```

## bpftrace: One-Liners to Full Scripts

`bpftrace` is the quickest way to get started with eBPF. It provides a high-level DSL that compiles down to eBPF programs.

### Installation

```bash
# Ubuntu/Debian
sudo apt install bpftrace

# macOS (with DTrace alternative, limited)
brew install bpftrace
```

### One-liners

```bash
# Count system calls by process
bpftrace -e 'tracepoint:raw_syscalls:sys_enter { @[comm] = count(); }'

# Time spent in the write() system call
bpftrace -e 'tracepoint:raw_syscalls:sys_exit /pid == 1234/ { @[comm] = hist(arg1); }'

# Trace file opens with process name and filename
bpftrace -e 'tracepoint:syscalls:sys_enter_open { printf("%s: %s\n", comm, str(args->filename)); }'

# Count kernel function calls containing "alloc"
bpftrace -e 'kprobe:vfs_* { @[probe] = count(); }'

# Show network packets per process (requires root)
bpftrace -e 'tracepoint:net:netif_receive_skb { @[comm] = count(); }'
```

### bpftrace Scripts

For more complex behavior, write a full script:

```bpftrace
#!/usr/bin/env bpftrace

// Trace new processes and show arguments
tracepoint:sched:sched_process_fork
{
    $child_pid = args->child_pid;
    $child_comm = comm;

    join(args->child_comm);
}

// Trace all system calls and measure latency
tracepoint:raw_syscalls:sys_enter
{
    @syscall[syscall] = count();
}

tracepoint:raw_syscalls:sys_exit
/@syscall[syscall]/
{
    @latency[syscall] = hist(elapsed * 1000);
}

// Print every 5 seconds
interval:5
{
    print("=== Syscall counts ===");
    print(@syscall);
    print("=== Latency histogram (ms) ===");
    print(@latency);
    clear(@syscall);
}

END
{
    clear(@syscall);
    clear(@latency);
}
```

## execsnoop: Capturing Every Process Execution

`execsnoop` is a classic eBPF demonstration tool. It traces every `execve()` system call — every time a process runs another program — and prints the command line arguments.

Here's how it works:

```bash
# Use bpftrace directly
sudo bpftrace -e 'tracepoint:syscalls:sys_enter_execve { join(args->argv); }'

# Or use the bcc version (often pre-installed)
sudo execsnoop
```

The output looks like:

```
PCOMM            PID     PPID    ARGS
bash             12345   12300   ls -la /tmp
python           12346   12340   python3 -c "import socket; ..."
curl             12347   12346   curl -s https://api.example.com/health
```

This is incredibly useful for:
- **Security auditing** — Who ran what, when, with what arguments
- **Debugging** — Understanding what a complex program is actually spawning
- **Performance analysis** — Catching shell spawns in hot paths (looking at you, Java)

## tcpdump -B: eBPF-Powered Packet Capture

The `-B` flag in `tcpdump` uses eBPF to filter packets in the kernel, before they reach userspace. Traditional `tcpdump` copies packets to userspace and then filters them — with `-B`, the filter runs in-kernel, dramatically reducing overhead.

```bash
# Traditional tcpdump (copies to userspace, then filter)
sudo tcpdump -i eth0 port 80

# eBPF-powered (filter in kernel, less overhead)
sudo tcpdump -B 4096 -i eth0 port 80
```

The number after `-B` is the buffer size in KB. Larger buffers mean fewer dropped packets under load.

More importantly, modern `tcpdump` can use eBPF's expression optimizer:

```bash
# Complex filtering in kernel
sudo tcpdump -B 8192 -i eth0 'tcp[tcpflags] & (tcp-syn|tcp-fin) != 0 and dst port 80'
```

With eBPF, this expression gets compiled into eBPF bytecode and runs in-kernel, so only matching packets are copied to userspace.

## eBPF vs Kernel Modules: Why Safe Is Better

| Aspect | Kernel Module | eBPF |
|--------|---------------|------|
| Safety | Can crash kernel | Verified before loading, can't crash |
| Update | Must unload and reload | Hot-reload without disrupting |
| Portability | Kernel version dependent | Portable across kernel versions (with CO-RE) |
| Access | Full kernel access | Limited to what you attach to |
| Distribution | Requires signed module (in production) | Works out of the box on modern kernels |

**CO-RE (Compile Once – Run Everywhere)** solves the portability problem. eBPF programs compiled with BTF (BPF Type Format) information can be relocated across kernel versions without recompilation. The loader adjusts memory offsets based on the target kernel's actual structure layouts.

## Practical Production Use Cases

### 1. Network Performance Monitoring

XDP programs can inspect and count packets at line rate — before the kernel networking stack even processes them:

```c
// Count packets by destination port, in-kernel
SEC("xdp")
int xdp_prog(struct xdp_md *ctx)
{
    void *data_end = (void *)(long)ctx->data_end;
    void *data = (void *)(long)ctx->data;

    struct ethhdr *eth = data;
    if ((void *)(eth + 1) > data_end)
        return XDP_PASS;

    if (eth->h_proto == htons(ETH_P_IP)) {
        struct iphdr *ip = data + sizeof(*eth);
        if ((void *)(ip + 1) > data_end)
            return XDP_PASS;

        __u16 dst_port = 0;
        // Extract port from TCP header...
        @port_counts[dst_port]++;
    }

    return XDP_PASS;
}
```

### 2. Security Monitoring with LSM Hooks

The LSM (Linux Security Module) eBPF program type lets you enforce security policies:

```c
// Blockexec if process isn't in allowlist
SEC("lsm/socket_bind")
int socket_bind(struct sock *sk)
{
    __u32 uid = bpf_get_current_uid_gid();
    if (@blocked_uid[uid])
        return -EPERM;
    return 0;
}
```

### 3. Continuous Profiling

Tools like Pixie and Parca use eBPF to continuously profile CPU usage without the overhead of traditional profiling:

```bash
# Profile CPU usage by stack trace (bcc version)
sudo /usr/share/bcc/tools/profile -F 99 1
```

## The eBPF Ecosystem

| Tool | What It Does |
|------|-------------|
| **bcc** | BPF Compiler Collection — C/Python/Lua frontends for writing eBPF tools |
| **bpftrace** | High-level DSL for one-liners and scripts |
| **libbpf** | C library for loading eBPF programs, used by standalone programs |
| **cilium/ebpf** | Go library for eBPF programs |
| **Aya** | Rust eBPF framework |
| **Pixie** | Kubernetes observability using eBPF |
| **Cilium** | CNI plugin using eBPF for networking and security |
| **Falco** | Security auditing via eBPF |

## Requirements

eBPF requires:
- Linux kernel 4.4+ (for basic features)
- Linux kernel 5.8+ (for many newer features like BTF, ring buffers)
- `CONFIG_BPF=y` and related options enabled in kernel
- `CAP_BPF` or root for most operations

Check your system:

```bash
# Check kernel version
uname -r

# Check eBPF support
cat /proc/sys/kernel/bpf_stats_enabled
# or
bpftool prog list

# Check available hook points
ls /sys/kernel/debug/tracing/events/
```

## Conclusion

eBPF represents a fundamental shift in how we observe and interact with the Linux kernel. It gives us kernel-level insight with user-space safety, programmable hooks into almost any kernel subsystem, and the ability to write production-safe instrumentation without risking system stability.

The tools have matured significantly. `bpftrace` for exploration and one-off debugging. `bcc` for production-grade tools. `libbpf` and higher-level frameworks for building your own eBPF programs.

The learning curve is real — you're writing code that runs in the kernel, and the eBPF instruction set has its own quirks. But the safety guarantees mean you can iterate without fear of crashing production systems, and the power is unmatched: microsecond-resolution tracing of anything the kernel does, with overhead low enough for continuous production use.

If you're serious about Linux observability, eBPF isn't optional anymore — it's the foundation.

---

**External Resources**

- [BPF Performance Tools book](https://www.brendangregg.com/bpf-performance-tools-book.html) — Brendan Gregg's comprehensive guide
- [bpftrace reference guide](https://github.com/iovisor/bpftrace/blob/master/docs/reference_guide.md) — Syntax and builtins
- [bcc documentation](https://github.com/iovisor/bcc/blob/master/docs/reference_guide.md) — Tools and API reference
- [Cilium BPF and XDP reference](https://docs.cilium.io/en/latest/bpf/) — Deep dive into networking eBPF
- [eBPF verifier source](https://github.com/torvalds/linux/blob/master/kernel/bpf/verifier.c) — For the truly curious