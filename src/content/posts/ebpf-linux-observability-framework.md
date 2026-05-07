---
title: "eBPF: Linux Observability That Will Change How You Debug"
description: "A deep dive into extended Berkeley Packet Filter — how eBPF works, why its safety guarantees matter, and how to use it for production-safe kernel tracing without kernel modules."
date: 2026-05-04
tags: ["linux", "ebpf", "observability", "performance", "kernel", "debugging", "bpf", "tracing", "xdp"]
structuredData:
  type: "Article"
  author: "systeminternals.dev"
  datePublished: "2026-05-04"
  dateModified: "2026-05-04"
---

If you've ever used `strace` to watch a process make system calls, or `perf` to sample CPU hotspots, you've already benefited from Linux's observability infrastructure. But there's a technology underneath both of those tools — and much more — that changes the entire calculus of kernel-level debugging: **eBPF** (extended Berkeley Packet Filter).

eBPF lets you run custom programs inside the kernel, attached to almost any interesting event — a function call, a network packet, a scheduler decision — with guarantees that your code cannot crash the system. That's not a small thing. Kernel modules can crash your machine. eBPF programs go through a static verifier that proves safety before they load.

This post is about how eBPF actually works, how to write your first programs, and which tools to reach for depending on the problem.

## The History: BPF → eBPF

The original Berkeley Packet Filter was designed in 1992 for packet filtering in the kernel. It was a small bytecode interpreter for network filters — efficient enough for the time, limited in scope.

eBPF arrived in Linux 3.18 (2014), but the version that changed everything was Linux 4.4 (2016), which added many program types and map support. Linux 5.8 (2020) brought BTF (BPF Type Format), CO-RE (Compile Once – Run Everywhere), and ring buffers. The ecosystem has matured rapidly since then.

The key difference: original BPF was just for network filtering. eBPF became a general-purpose kernel execution environment with:
- Many more registers (10 virtual registers vs 2)
- A richer instruction set
- Maps for stateful storage
- Helper functions (kernel-provided syscalls for the programs)
- A verifier that proofs-of-correctness before loading

## How eBPF Works: Verifier, Bytecode, JIT

When you write an eBPF program, it goes through a strict pipeline before it ever runs:

```
You write eBPF code (C, Go, Rust, or bpftrace DSL)
         │
         ▼
    Compiler (clang) → eBPF bytecode
         │
         ▼
    bpf() syscall loads program into kernel
         │
         ▼
    Kernel Verifier static analysis
    ├── Rejects programs that could OOB access memory
    ├── Rejects programs with unbounded loops
    │   (unless loop is provably bounded and exits)
    ├── Rejects unsafe pointer operations
    ├── Simulates every possible execution path
    └── Must complete in bounded instructions
         │
         ▼ (if verified)
    JIT compiler → native machine code
         │
         ▼
    Program attached to hook point
         │
         ▼
    Kernel executes on every trigger event
```

The verifier is the critical piece. It runs your program through static analysis, exploring every possible execution path. If any path could dereference an invalid pointer, read out of bounds, or loop forever, the verifier rejects it.

This is why eBPF is safe: the verifier proves properties about your code before it runs. Unlike kernel modules, which can panic the system with a null pointer dereference, an eBPF program that fails verification never loads.

### BTF and CO-RE

Writing eBPF programs that work across kernel versions used to be painful. Kernel structures change layout between versions — a field at offset 8 in one kernel might be at offset 16 in another.

**BTF** (BPF Type Format) embeds type information into the kernel. **CO-RE** (Compile Once – Run Everywhere) uses BTF to let the eBPF loader patch your program's memory accesses for the target kernel at load time. You compile once, and it works across kernels. This is what makes modern eBPF practical for distribution.

## Your First eBPF Program

Let's start simple. The canonical first eBPF program attaches to a kernel function and reads some data.

### Using bpftrace (One-Liner)

The fastest path is `bpftrace`, which provides a high-level DSL that compiles down to eBPF. You can get real insight with a single command:

```bash
# Count system calls by process name
sudo bpftrace -e 'tracepoint:raw_syscalls:sys_enter { @[comm] = count(); }'

# Time spent in the write() syscall, per PID
sudo bpftrace -e 'tracepoint:syscalls:sys_exit_write /pid == 1234/ { @latency = hist(elapsed); }'

# Watch all file opens with the filename
sudo bpftrace -e 'tracepoint:syscalls:sys_enter_openat { printf("%s: %s\n", comm, str(args->filename)); }'

# Count kernel function calls matching a pattern
sudo bpftrace -e 'kprobe:vfs_* { @[probe] = count(); }'
```

These run instantly, no compilation needed. The output is aggregated in a map (`@`) and printed on Ctrl+C or on an interval.

### Using bcc (C + Python)

For more control, the BPF Compiler Collection (bcc) lets you write eBPF programs in C, attach them from Python, and have full access to maps and complex logic:

```c
// ebpf_first.c — trace all write() syscalls and print the string
#include <uapi/linux/ptrace.h>
#include <bcc/proto.h>

// A map to count writes per process name
BPF_HASH(counter, char *, u64);

int trace_write(struct pt_regs *ctx, int fd, const char *buf) {
    // Get current process name
    char comm[16];
    bpf_get_current_comm(&comm, sizeof(comm));

    // Look up or create entry for this process
    u64 *p = counter.lookup(&comm);
    if (p) {
        (*p)++;
    } else {
        u64 one = 1;
        counter.update(&comm, &one);
    }

    // Print the string being written (up to 32 bytes)
    bpf_trace_printk("write from %s: %s\n", comm, buf);
    return 0;
}
```

```python
# attach_ebpf.py
from bcc import BPF

program = open("ebpf_first.c").read()
b = BPF(text=program)

# Attach to the write syscall entry
b.attach_kprobe(event="__x64_sys_write", fn_name="trace_write")

# Print output
b.trace_print()
```

### Using bpftrace Script File

For reusable tools, write a `.bt` script:

```bpftrace
#!/usr/bin/env bpftrace

// Trace all process executions (execve syscalls)
tracepoint:syscalls:sys_enter_execve
{
    printf("%s %s\n", comm, str(args->argv[0]));
}

// Print stats every 5 seconds
interval:5s
{
    print("=== Exec counts ===");
    print(@);
    clear(@);
}

END
{
    print("=== Final counts ===");
    print(@);
}
```

Run it with `sudo bpftrace ./trace_exec.bt`.

## eBPF Programs and Maps

### Types of Program Hooks

eBPF programs attach to different kernel hooks depending on what you want to observe:

| Program Type | Hook Point | Stability | Use Case |
|---|---|---|---|
| **kprobe** | Kernel function entry/exit | Unstable | Trace any kernel function dynamically |
| **uprobe** | Userspace function entry/exit | Unstable | Trace library calls or app functions |
| **tracepoint** | Static kernel tracepoints | Stable ABI | Low-overhead kernel tracing |
| **raw_tracepoint** | Same as tracepoint, raw args | Stable ABI | Slightly lower overhead |
| **sched** | Scheduler events | Stable | Process/thread scheduling analysis |
| **xdp** | Packet at NIC driver | Stable | Fast packet processing, DDoS mitigation |
| **tc** | Traffic control (qdisc) | Stable | Network traffic shaping |
| **lsm** | Linux Security Module hooks | Stable | Security policy enforcement |
| **perf_event** | Hardware/software perf events | Stable | CPU profiling, sampling |

**Tracepoints are better than kprobes when available.** They're part of the kernel's stable ABI — they won't change between kernel versions. kprobes attach to any function, but internal functions move around between kernel versions, breaking your program.

### Maps: Stateful Storage

eBPF programs are side-effect-free by nature — they can't call arbitrary functions or access memory outside of what's provided. To store state between invocations or stream data to userspace, you use **maps**.

```c
// Define a hash map: key = PID (u32), value = count (u64)
struct {
    __uint(type, BPF_MAP_TYPE_HASH);
    __uint(max_entries, 10240);
    __type(key, __u32);
    __type(value, __u64);
} pid_counts SEC(".maps");
```

Common map types:

- **BPF_MAP_TYPE_HASH** — Key-value store, O(1) lookup. Good for counting, tracking state.
- **BPF_MAP_TYPE_ARRAY** — Index-based array. Fast, fixed size. Good for histogramming.
- **BPF_MAP_TYPE_PERCPU_HASH / ARRAY** — Each CPU has its own copy. Avoids lock contention in high-frequency tracing.
- **BPF_MAP_TYPE_RINGBUF** — Single-producer, multi-consumer circular buffer. Efficient event streaming to userspace (replaces perf buffer in newer kernels).
- **BPF_MAP_TYPE_STACK_TRACE** — Stores kernel stack traces. Great for flame graph generation.

From userspace, you access maps via the `bpf()` syscall:

```python
from bcc import BPF

b = BPF(text=program)
counter = b["pid_counts"]

# Read all entries
for k, v in counter.items():
    print(f"PID {k.value}: {v.value} writes")
```

## Practical Tools Built on eBPF

### bpftrace

The swiss army knife. One-liners for quick investigation:

```bash
# Count context switches (scheduler activity)
sudo bpftrace -e 'tracepoint:sched:sched_switch { @[comm] = count(); }'

# Watch memory allocations by process
sudo bpftrace -e 'kmalloc { @[comm] = hist(siz); }'

# TCP connect attempt origins
sudo bpftrace -e 'tracepoint:syscalls:sys_enter_connect { printf("%s -> %s\n", comm, ntop(AF_INET, args->uservaddr)); }'

# Disk I/O by process (using block devices)
sudo bpftrace -e 'tracepoint:block:block_bio_queue { @[comm] = hist(args->nr_sector * 512); }'
```

### BCC Tools

BCC ships with dozens of production-grade tools:

```bash
# execsnoop — every execve() call
sudo execsnoop

# opensnoop — every open/openat call
sudo opensnoop

# tcpconnect — every outbound TCP connection
sudo tcpconnect

# tcpaccept — every inbound TCP connection
sudo tcpaccept

# biolatency — block I/O latency histogram
sudo biolatency

# runqlat — scheduler latency histogram (how long processes wait to run)
sudo runqlat

# funccount — count calls to kernel functions matching a pattern
sudo funccount 'vfs_*'

# profile — CPU sampling (like perf top, but in BPF)
sudo profile 49 -F 99
```

These tools are installed at `/usr/share/bcc/tools/` on most distros. They're real programs, not scripts — written in C for the eBPF part, Python for the user-space control.

### Cilium

Cilium is a Kubernetes CNI (Container Network Interface) plugin that uses eBPF for all networking and security policy enforcement. Instead of iptables rules, Cilium compiles network policies into eBPF programs that run at the XDP or tc hook point.

The advantage: eBPF-based networking scales to thousands of nodes without the iptables rule explosion problem. It also provides deep observability — per-connection metrics, latency histograms, dropped packet tracking — all without sidecars or application-level agents.

### Falco

Falco is a security auditing tool that uses eBPF to monitor syscall activity and detect anomalous behavior. You write rules that trigger on specific syscall patterns:

```yaml
- rule: Unexpected outbound connection
  desc: A process outside the expected set makes an outbound connection
  condition: outbound and not proc.name in (expected_procs)
  output: Unexpected connection by unexpected process
```

Falco's eBPF driver runs at the syscall level, capturing everything without needing kernel modules.

### Pixie

Pixie does automatic distributed tracing in Kubernetes using eBPF. No instrumenting your application code — it automatically captures protocol-level data (HTTP, gRPC, Kafka, etc.) from the kernel, and can even auto-instrument Go, Python, and Node applications by tracing their runtime functions.

## eBPF vs strace vs perf

These tools overlap, but each has a specific niche:

| Tool | Mechanism | Overhead | Best For |
|---|---|---|---|
| **strace** | ptrace() syscall interception | Very high (every syscall has enter+exit context switches) | Debugging a specific process, short traces |
| **perf** | Hardware PMU + kernel采样 | Low to medium | CPU profiling, understanding where cycles go |
| **eBPF** | Kernel programs attached to hooks | Minimal, in-kernel aggregation | Production debugging, high-frequency events, continuous monitoring |

**Use strace when:** You need to see exact syscall arguments and return values for a specific process for a short time. Not for production — the overhead is 10x+.

**Use perf when:** You need to understand where CPU time is spent. `perf record -F 99 -a -g` for flame graphs. `perf stat` for counting hardware events.

**Use eBPF when:** You need high-frequency events, per-process aggregation, or want to debug production systems without adding 10x overhead.

## Security Considerations

eBPF requires significant privileges. The basic requirement is:

```bash
# Check kernel support
uname -r  # needs 4.4+ for basic features, 5.8+ for modern features

# Check if eBPF is enabled
ls /sys/kernel/debug/tracing/events/

# Check available programs
sudo bpftool prog list

# List maps
sudo bpftool map list
```

To load eBPF programs, you need:

- **Root** — or `CAP_BPF` capability (Linux 5.6+), or `CAP_SYS_ADMIN`
- **Kernel compiled with `CONFIG_BPF=y`** and `CONFIG_BPF_SYSCALL=y`
- For some program types (XDP, tc), you also need CAP_NET_ADMIN

The security model: eBPF is safer than kernel modules, but it's still running in kernel space. The verifier constrains what you can do, but a loaded eBPF program with write access to maps can consume resources (fill up a map, spin CPU in allowed operations). For production, use `bpftool` to inspect loaded programs and `ulimit -l` to limit memory locked for eBPF maps.

### Unprivileged eBPF

Since Linux 5.13, unprivileged eBPF is more restricted. You can load some program types (flow dissectors, sched_ext) without CAP_SYS_ADMIN, but most production use cases still need elevated privileges.

## Example: Building a Network Connection Counter

Here's a practical example: counting TCP connections by remote address, using a per-CPU array to avoid lock contention:

```c
#include <uapi/linux/bpf.h>
#include <bcc/bpf_helpers.h>
#include <linux/if_ether.h>
#include <linux/ip.h>
#include <linux/tcp.h>

// Per-CPU array: avoids cross-CPU locking overhead
struct {
    __uint(type, BPF_MAP_TYPE_PERCPU_ARRAY);
    __uint(max_entries, 65536);
    __type(key, __u32);   // remote IP as u32
    __type(value, __u64);  // connection count
} conn_counts SEC(".maps");

static __always_inline int parse_tcp(struct xdp_md *ctx, __u32 *remote_ip) {
    void *data_end = (void *)(long)ctx->data_end;
    void *data = (void *)(long)ctx->data;

    struct ethhdr *eth = data;
    if ((void *)(eth + 1) > data_end)
        return 0;

    if (eth->h_proto != htons(ETH_P_IP))
        return 0;

    struct iphdr *ip = data + sizeof(*eth);
    if ((void *)(ip + 1) > data_end)
        return 0;

    if (ip->protocol != IPPROTO_TCP)
        return 0;

    struct tcphdr *tcp = (void *)ip + sizeof(*ip);
    if ((void *)(tcp + 1) > data_end)
        return 0;

    *remote_ip = ip->saddr;
    return 1;
}

SEC("xdp")
int count_tcp_connections(struct xdp_md *ctx)
{
    __u32 remote_ip = 0;
    if (!parse_tcp(ctx, &remote_ip))
        return XDP_PASS;

    __u32 key = remote_ip;
    __u64 *val = bpf_map_lookup_elem(&conn_counts, &key);
    if (val) {
        __sync_fetch_and_add(val, 1);
    } else {
        __u64 init = 1;
        bpf_map_update_elem(&conn_counts, &key, &init, BPF_ANY);
    }

    return XDP_PASS;
}

char _license[] SEC("license") = "GPL";
```

Compile with `clang -target=bpf -O2 -c prog.c`, load with `ip link set dev eth0 xdp obj prog.o sec xdp`, and read counts with a Python script.

Learning eBPF? [Vultr](https://www.vultr.com/?ref=8914132) lets you deploy a kernel 5.8+ server in under a minute. <!-- AFFILIATE: vultr -->

## Further Reading

- [BPF Performance Tools](https://www.brendangregg.com/bpf-performance-tools-book.html) — Brendan Gregg's definitive book on eBPF tracing
- [bpftrace reference guide](https://github.com/iovisor/bpftrace/blob/master/docs/reference_guide.md) — Full syntax and builtin reference
- [BCC reference guide](https://github.com/iovisor/bcc/blob/master/docs/reference_guide.md) — Tools and Python API
- [Cilium BPF and XDP documentation](https://docs.cilium.io/en/latest/bpf/) — Deep dive on networking eBPF
- [eBPF verifier source](https://github.com/torvalds/linux/blob/master/kernel/bpf/verifier.c) — The code that makes eBPF safe (for the truly curious)

## Related Posts

- [strace Debugging](/posts/strace-debugging-linux-system-calls) — strace uses `ptrace`, the same underlying mechanism eBPF's predecessor traced
- [Linux /proc Filesystem](/posts/linux-proc-filesystem-deep-dive) — /proc is the data source for many eBPF programs that instrument running systems
- [GDB Debugging](/posts/gdb-debugging-core-dumps-live-processes) — For user-space debugging contrast; GDB inspects coredumps while eBPF inspects the live kernel

Want to experiment with eBPF on a live system? [Spin up a Linux VPS on Vultr](https://www.vultr.com/?ref=8914132) — deploy a recent kernel (5.8+) in under a minute. <!-- AFFILIATE: vultr -->

## Tools & Services

- **[Vultr](https://www.vultr.com/?ref=8914132)** — Cloud VPS with recent kernels (5.8+) for eBPF experimentation. $100 free credit for new accounts. <!-- AFFILIATE: vultr -->
- **[DigitalOcean](https://www.digitalocean.com/affiliates)** — Simple cloud hosting for eBPF development and testing. $100 free credit. <!-- AFFILIATE: digitalocean -->
