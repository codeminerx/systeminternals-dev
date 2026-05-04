---
title: "Linux Memory Debugging: From vmstat to Memory Leaks"
description: "Learn how Linux reports memory usage through vmstat, free, /proc/meminfo, and /proc/vmstat. Cover transparent hugepages, OOM killer, memory cgroups, and how to diagnose memory leaks in production."
date: 2026-05-04
tags: ["linux", "memory", "performance", "debugging", "vmstat", "oom"]
---

Every running program on a Linux system needs memory. When things go wrong — a runaway process eating gigabytes, the OOM killer firing unexpectedly, or a service degrading over days — you need to know where to look. Linux provides a rich set of interfaces for observing memory, but understanding what the numbers actually mean takes some unpacking.

## Table of Contents

- [How Linux Reports Memory](#how-linux-reports-memory)
- [RSS vs VSZ: What ps Tells You](#rss-vs-vsz-what-ps-tells-you)
- [The Core Tools: vmstat, free, and /proc/meminfo](#the-core-tools-vmstat-free-and-procmeminfo)
- [Monitoring Swap](#monitoring-swap)
- [/proc/vmstat and Page Faults](#procvmstat-and-page-faults)
- [Transparent HugePages](#transparent-hugepages)
- [The OOM Killer](#the-oom-killer)
- [Detecting Memory Leaks](#detecting-memory-leaks)
- [Practical Tools: smem, pmap, and memleak](#practical-tools-smem-pmap-and-memleak)
- [Memory Cgroups](#memory-cgroups)
- [Conclusion](#conclusion)

## How Linux Reports Memory

Linux exposes detailed memory information through `/proc/meminfo`. This is the canonical source — tools like `free` and `top` ultimately read from here. Let's look at a typical output:

```bash
$ cat /proc/meminfo
MemTotal:       32768 MiB
MemFree:         8452 MiB
MemAvailable:   16384 MiB
Buffers:         2048 MiB
Cached:          8192 MiB
SReclaimable:    1024 MiB
Shmem:           512 MiB
SReclaimable:    1024 MiB
[...]
```

Here's what each field means:

| Field | Description |
|-------|-------------|
| `MemTotal` | Total physical memory installed |
| `MemFree` | Completely unused memory (not a useful metric) |
| `MemAvailable` | Memory available for processes without swapping — accounts for reclaimable pages |
| `Buffers` | Memory used by block device buffers (raw I/O metadata) |
| `Cached` | Memory used as page cache for files |
| `SReclaimable` | Slab reclaimable portion ( dents and inodes the kernel can free) |
| `Shmem` | Shared memory (tmpfs, POSIX shm) |

The crucial insight: `MemAvailable` is the number you care about. `MemFree` looks impressively large in `free` output, but it ignores page cache and reclaimable slab that can be freed quickly. `MemAvailable` is what the kernel actually considers available for new allocations.

### Buffers vs Cached

Linux uses spare memory for two things:

- **Buffers**: raw block device data (e.g., metadata for ext4 superblock reads)
- **Cached**: page cache — copies of file contents kept in RAM for fast access

Both reduce "available" memory, but both can be reclaimed instantly if a process needs them. Think of them as a performance accelerator, not consumption.

## RSS vs VSZ: What ps Tells You

When you run `ps aux`, you see two memory columns:

```bash
$ ps aux | head -5
USER         PID %CPU %MEM    VSZ   RSS TTY      STAT START   COMMAND
root           1  0.0  0.0  8976  7364 ?        Ss   2024    0:35 init [2]
```

- **VSZ** (Virtual Set Size): total virtual memory allocated, including mapped but uncommitted pages. A process with 1GB of VSZ might only be using 100MB of physical RAM.
- **RSS** (Resident Set Size): physical memory actually used. This is what matters for real system pressure. RSS includes shared library code that's loaded into memory once and counted for every process using it.

RSS is the number that matters for detecting leaks. If RSS grows unbounded over time, you have a leak. VSZ alone tells you almost nothing.

Note that VSZ includes memory mapped with `mmap()` that hasn't been touched yet, and it's counted per-process — so shared libraries inflate VSZ for every process that links them, even though the physical pages are shared.

## The Core Tools: vmstat, free, and /proc/meminfo

### free

The `free` command is the quickest way to see system memory:

```bash
$ free
               total        used        free      shared  buff/cache   available
Mem:        32768        12288        8192         512        12288       16384
Swap:        2048          256        1792
```

Key interpretation:
- `free` column = `MemFree` from `/proc/meminfo`
- `available` = `MemAvailable`
- `buff/cache` = `Buffers` + `Cached`
- Swap `used` > 0 means the system is under memory pressure and paging out anonymous memory

Use `free -h` for human-readable numbers:

```bash
$ free -h
               total        used        free      shared  buff/cache   available
Mem:            32Gi        12Gi         8Gi       512Mi        12Gi        16Gi
Swap:           2Gi       256Mi         1Gi
```

### vmstat

`vmstat` (virtual memory statistics) is great for watching memory trends and per-category breakdowns:

```bash
$ vmstat 1 5
procs -----------memory---------- ---swap-- -----io---- -system-- ------cpu-----
 r  b   swpd   free   buff  cache   si   so    bi    bo   in   cs us sy id wa st
 1  0      0 8388608 2097152 8388608    0    0     0     0    0  500  0  0 0 0  0
```

The key columns:

| Column | Meaning |
|--------|---------|
| `swpd` | Amount of swap used (KB) |
| `free` | Available memory (KB) |
| `buff` | Buffers (KB) |
| `cache` | Cache (KB) |
| `si` | Swap-in (KB/s) — pages read from swap back to RAM |
| `so` | Swap-out (KB/s) — pages written to swap |

When `si` or `so` are consistently non-zero, you're in trouble — the system is actively paging.

For per-process breakdowns, use `vmstat -p`:

```bash
$ vmstat -p /dev/sda1
procs ----memory----- ---IO--- --system-- ----cpu-----
 r  b   free  inact si so               us  id
 1  0 8388608 2097152  0  0              0   0
```

### /proc/meminfo

For detailed per-memory-type accounting, `/proc/meminfo` is the source of truth:

```bash
$ cat /proc/meminfo | grep -E '^(Mem|Total|Active|Inactive|SReclaimable|Shmem|Huge|'
MemTotal:       33554432 kB
MemFree:        16777216 kB
MemAvailable:   20971520 kB
Active:         10485760 kB
Inactive:       5242880 kB
SReclaimable:   1048576 kB
Shmem:          524288 kB
Hugepagesize:       2048 kB
```

Important additional fields:

- **Active/Inactive**: recently accessed (`Active`) vs. not recently (`Inactive`). Inactive memory is the first target for reclaim.
- **DirectMap2M**: amount mapped with 2MB pages (related to TLB efficiency)
- **Hugepagesize**: size of a huge page (typically 2MB on x86)

## Monitoring Swap

Swap exists for two reasons: (1) as a safety valve when physical memory is exhausted, and (2) as a place to evict cold anonymous pages (process heap/stack) that haven't been used recently.

A non-trivial amount of swap usage is not necessarily bad — it might just mean cold pages got pushed out. But **swap-in activity (`si` in vmstat)** is what kills performance.

```bash
# Watch swap usage in real-time
watch -n 1 'vmstat | grep -E "swpd|si|so"'

# Check which processes are using swap
for f in /proc/*/status; do
  awk '/VmSwap/{printf "%-30s %s\n", $1, $2}' "$f"
done 2>/dev/null | sort -k2 -n -r | head
```

Swap can also be per-filesystem via `swappiness`. More on that in the OOM killer section.

## /proc/vmstat and Page Faults

`/proc/vmstat` tracks low-level virtual memory events across the whole system:

```bash
$ cat /proc/vmstat | grep -E "pgpgin|pgpgout|pgfault|pgmajfault|pgrefill|pgsteal"
pgpgin 1254321
pgpgout 987654
pgfault 982347123
pgmajfault 12345
pgrefill 23456
pgsteal 78901
```

What these mean:

| Counter | Meaning |
|---------|---------|
| `pgfault` | Total page faults (minor — page in memory but not yet mapped) |
| `pgmajfault` | Major page faults (page had to be read from disk — much more expensive) |
| `pgpgin` | Pages read into memory (from disk/swap) |
| `pgpgout` | Pages written to disk/swap |
| `pgsteal` | Pages reclaimed by the kernel (from any category) |

A healthy system will have a high ratio of `pgfault` to `pgmajfault`. If `pgmajfault` is climbing rapidly, something is causing pages to be evicted and then accessed again — possibly too much memory pressure or poor access patterns.

## Transparent HugePages

Transparent HugePages (THP) are a Linux feature that allows the kernel to use 2MB pages automatically instead of the standard 4KB pages. The goal is reducing TLB pressure and improving performance for memory-heavy workloads.

### Checking THP Status

```bash
$ cat /sys/kernel/mm/transparent_hugepage/enabled
[always] madvise never
```

The bracketed value is the current setting. `always` means THP is enabled for all eligible allocations.

```bash
$ cat /sys/kernel/mm/transparent_hugepage/defrag
[defer] madvise never
```

- `always`: aggressively compact memory to satisfy THP requests
- `madvise`: only use THP when explicitly requested via `madvise(MADV_HUGEPAGE)`
- `defer`: try to defragment in the background but don't block
- `never`: disabled

### When THP Causes Problems

THP can cause problems in two main ways:

1. **Memory fragmentation**: as memory gets fragmented, the kernel works harder to find contiguous 2MB chunks, which can cause latency spikes in applications like databases or Java VMs.
2. **khugepaged CPU usage**: the kernel daemon `khugepaged` continuously scans for pages it can collapse into huge pages, consuming CPU.
3. **Unexpected RSS increases**: when a 4KB page is promoted to a 2MB huge page, it stays resident. For applications with sparse access patterns, this wastes memory.

For database workloads, it's often recommended to disable THP:

```bash
# Temporarily
echo never > /sys/kernel/mm/transparent_hugepage/enabled
echo never > /sys/kernel/mm/transparent_hugepage/defrag

# Persistently (RHEL/CentOS) — add to /etc/rc.local:
if test -f /sys/kernel/mm/transparent_hugepage/enabled; then
  echo never > /sys/kernel/mm/transparent_hugepage/enabled
fi
if test -f /sys/kernel/mm/transparent_hugepage/defrag; then
  echo never > /sys/kernel/mm/transparent_hugepage/defrag
fi
```

## The OOM Killer

When the kernel can't find any memory to allocate — including reclaiming pages and expanding swap — it calls the Out-of-Memory killer. This is a last-resort mechanism that selects and kills one or more processes to free memory for the system to survive.

### How It Selects a Victim

The OOM killer uses a score stored in `/proc/<pid>/oom_score_adj` (or the older `/proc/<pid>/oom_adj`):

```bash
$ cat /proc/$$/oom_score_adj
0
```

Values range from -1000 (never kill) to +1000 (most likely to be killed). The kernel computes this based on:
- Memory consumed by the process and its children
- How long the process has been running (longer = slightly lower score)
- Nice value (lower priority processes score higher)
- Root processes get a slight boost (score lower)

### Tuning vm.swappiness

`vm.swappiness` controls how aggressively the kernel swaps out anonymous (heap/stack) memory vs. dropping page cache:

```bash
$ sysctl vm.swappiness
60
```

Range is 0 to 100:
- **0**: don't swap unless absolutely necessary (only for critical allocations)
- **100**: aggressively swap cold pages

The default is 60. For most desktop/laptop workloads, lowering to 10-30 can improve performance by keeping more file-backed pages in memory. For memory-overcommitted servers, the default may be fine.

To change temporarily:

```bash
sysctl -w vm.swappiness=30
```

To persist, add to `/etc/sysctl.conf`:

```
vm.swappiness = 30
```

### Responding to OOM Events

After an OOM kill, check the system log:

```bash
dmesg | grep -i "out of memory"
# or on systemd systems:
journalctl -k | grep -i oom
```

The log will show which process was killed and the memory state at the time.

To make a process nearly immune to the OOM killer:

```bash
echo -1000 > /proc/<pid>/oom_score_adj
```

To make it more likely to be killed (useful for containers):

```bash
echo 800 > /proc/<pid>/oom_score_adj
```

## Detecting Memory Leaks

A memory leak is when a process allocates memory but fails to free it, causing RSS to grow unbounded over time. Linux is good at reclaiming clean page cache, but leaks in anonymous memory (heap, stack, mmap'd anonymous regions) persist until the process exits.

### The Basic Technique: Monitor RSS Over Time

```bash
# Sample RSS every 10 seconds, 100 samples
while true; do
  ps -o pid,rss,vsz,comm -p $(pgrep -d, myprocess)
  sleep 10
done
```

If RSS grows linearly or stepwise over hours, you have a leak.

### Using /proc/<pid>/smaps_rollup for Leak Hunting

`/proc/<pid>/smaps_rollup` gives a quick summary of a process's memory mappings:

```bash
$ cat /proc/1234/smaps_rollup
Rss:      82944 kB
Pss:      51200 kB
Shared_Clean:   15236 kB
Shared_Dirty:    2048 kB
Private_Clean:    512 kB
Private_Dirty:   8192 kB
Referenced:   82944 kB
Anonymous:   65536 kB
LazyFree:     16384 kB
AnonHugePages:  0 kB
ShmemHugePages: 0 kB
ShmemPmdMapped: 0 kB
```

Look at `Anonymous` (heap) and `Private_Dirty` (modified private pages) growth over time.

### Using valgrind

For deeper analysis, `valgrind` with its `memcheck` tool can identify leaked memory in C/C++ programs:

```bash
valgrind --leak-check=full --show-leak-kinds=all --track-origins=yes ./my_program
```

This runs the program under instrumentation and reports all unfreed memory at exit. It has significant overhead (5-20x slower) but catches even small leaks.

## Practical Tools: smem, pmap, and memleak

### smem

`smem` reports memory consumption with proportional set size (PSS), which accounts for shared pages divided among processes that share them:

```bash
$ smem
  PID User     Command                         Swap      RSS      PSS    Unique
12345 www-data nginx                          0 KiB    82 MiB    48 MiB    34 MiB
```

PSS is often more useful than RSS because it gives a realistic per-process cost when shared libraries are involved. Install with `apt install smem` or `yum install smem`.

### pmap

`pmap` shows the memory mappings of a process — every `mmap()` region with its permissions and size:

```bash
$ pmap -x 12345 | head -20
12345:   nginx: worker process
Address           Kbytes     RSS   Mode  Mapping
0000562300000000     512     256  r-xp  nginx
0000562300800000      64      32  rw-p  [ anon ]
0000562300810000     512     480  rw-p  [ anon ]
00007f8a40000000    8192    8192  rw-s  [ anon ]
00007f8a40800000     512       0  -----  [ anon ]
```

The `-x` flag shows extended information (RSS per mapping). The `-X` flag shows even more detail including per-page flags.

For a leak, you'd look for mappings that grow in size (`Kbytes`) or RSS without corresponding growth in actual program logic.

### memleak (bpfcc-tools)

On systems with BPF, `memleak` can attach to allocation calls and track unreleased memory in real-time:

```bash
# Find the memleak tool
ls /usr/share/bcc/tools/memleak

# Attach to a running process
/usr/share/bcc/tools/memleak -p 12345

# Or trace all allocations system-wide
/usr/share/bcc/tools/memleak -a
```

This instrumenting approach has lower overhead than valgrind and works in production without recompiling.

## Memory Cgroups

In containerized environments, memory cgroups (cgroup v2 in modern Linux) provide hard limits on how much memory a group of processes can use. The kernel exposes cgroup memory metrics in the cgroup filesystem.

### Key Files

| File | Meaning |
|------|---------|
| `memory.limit_in_bytes` | Hard limit — process group cannot exceed this |
| `memory.usage_in_bytes` | Current total memory usage |
| `memory.low_limit_in_bytes` | Low watermark — triggers reclaim below this |
| `memory.high_limit_in_bytes` | High watermark — triggers throttling above this |
| `memory.memsw.limit_in_bytes` | Hard limit for memory+swap combined (cgroup v1 only) |

### Checking a Container's Memory

```bash
# Show memory limits and usage for a container's cgroup
cat /sys/fs/cgroup/system.slice/docker-<id>.scope/memory.limit_in_bytes
cat /sys/fs/cgroup/system.slice/docker-<id>.scope/memory.usage_in_bytes
```

On cgroup v2 (modern systems), these are under `/sys/fs/cgroup/memory.max` and `/sys/fs/cgroup/memory.current`.

### Common Cgroup Memory Misconfigurations

A common problem: a container with `memory.limit_in_bytes` set to a value close to `memory.usage_in_bytes` has no headroom for bursts. When the container tries to allocate beyond the limit, the OOM killer fires inside the container.

Another issue: `memory.memsw.limit_in_bytes` (swap limit) set to the same as `memory.limit_in_bytes` effectively disables swap for the container. Combined with aggressive `vm.swappiness`, this can cause unexpected OOM kills.

## Conclusion

Linux memory debugging is layered. At the surface, `free` and `vmstat` tell you the system's overall state. Dig deeper with `/proc/meminfo` and `/proc/vmstat` for per-subsystem breakdowns. For per-process work, `ps`, `pmap`, and `smem` are your mainstays.

The mental model to internalize:

1. Physical memory is shared — RSS counts shared library pages for every process
2. PSS gives the fair share cost per process
3. Swap activity is the first sign of memory pressure problems
4. RSS growth over time is the signature of a memory leak
5. The OOM killer is your last resort, not your first signal

When you're debugging a memory issue, start with `vmstat 1` to see if you're swapping, then narrow down with `ps aux --sort=-rss` to find the hungry process, then drill into that process with `pmap` or `/proc/<pid>/smaps`. Only reach for `valgrind` or `bpfcc-tools/memleak` when you've confirmed there's a leak and need to find the allocation site.

Linux gives you all the tools — the skill is knowing which number to trust and which to ignore.
