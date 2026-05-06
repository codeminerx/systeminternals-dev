---
title: "Linux I/O Debugging: From iostat to iotop to pidstat"
description: "A practical guide to diagnosing I/O bottlenecks in Linux using iostat, iotop, pidstat, and blktrace — with real output, interpretation, and tuning."
date: 2026-05-06
tags: ["linux", "performance", "io", "debugging", "storage", "sysadmin"]
---

Your server is slow. CPU is mostly idle. Memory is fine. But disk I/O is spiking to 100% utilization and every request is queuing up behind the disk. Sound familiar?

I/O bottlenecks are among the most insidious performance problems because the disk is orders of magnitude slower than everything else, and by the time you see the symptoms (high latency, request timeouts), the damage is already done.

This post is about seeing the disk clearly: which process is doing it, which device is saturated, whether it's read or write, and what you can actually do about it.

> **Prerequisites:** Familiarity with the Linux process model and `/proc` filesystem. If you need a refresher, see [Linux Process Management: ps, top, and htop Explained](/posts/linux-process-management-ps-top-htop/) and [Linux /proc Filesystem Deep Dive](/posts/linux-proc-filesystem-deep-dive/).

## The I/O Stack: Where Things Can Go Wrong

Before diving into tools, let's map the path data takes from your application to the physical disk:

```
Application (write(fd, buf, len))
    ↓
VFS (virtual filesystem switch)
    ↓
Filesystem (ext4, xfs, btrfs...)
    ↓
Block Layer (I/O scheduler, request merging)
    ↓
SCSI/SATA/NVMe driver
    ↓
Storage Device (SSD, HDD)
```

A slowdown can occur at any layer:

- **Application:** Writing too much at once, synchronous I/O
- **Filesystem:** Journal commits, fragmentation, metadata storms
- **Block layer:** I/O scheduler queue full, request merging
- **Driver:** Queue depth limits, firmware issues
- **Hardware:** Device saturation, latency spikes

Each tool in this post covers a different layer of this stack.

## iostat: Device-Level Overview

`iostat` (from the `sysstat` package) is your first stop for device-level I/O visibility. It shows throughput,ops per second, and utilization per device.

```bash
# Basic iostat output
$ iostat -x 2 5
Linux 5.15.0-generic (hostname)   05/06/2026   _x86_64_   (8 CPU)

avg-cpu:  %user   %nice %system %iowait %steal   %idle
           2.3     0.0     1.2     4.1     0.0    92.4

Device:   r/s     w/s     rkB/s   wkB/s   rrqm/s  wrqm/s  %util
sda       12.00   45.00   600.0   2400.0  0.00    5.00    78.50
nvme0n1    0.00   120.00  0.0     9600.0  0.00    0.00    15.20
```

### Reading the Columns

| Column | Meaning |
|--------|---------|
| `r/s`, `w/s` | Read/write operations per second (IOPS) |
| `rkB/s`, `wkB/s` | Read/write kilobytes per second (throughput) |
| `rrqm/s`, `wrqm/s` | Merged read/write operations per second (request merging by the block layer) |
| `%util` | Device utilization — the percentage of time the device had at least one request in flight |

**That `%util` column is your first red flag.** Above 70% sustained means the device is busy. Above 90% means you're almost certainly queuing.

The `iowait` in the CPU section (`%iowait`) tells you how much CPU time is spent waiting for I/O to complete — but it's an aggregate across all CPUs and doesn't tell you *which* process or device.

### Deep Dive with -x and -z

```bash
# Extended stats, 2-second interval, 3 iterations, skip CPU report
$ iostat -xzh 2 3
...

Device:  r/s    w/s     rkB/s   wkB/s  await  %util
sda     12.00  45.00    600.0  2400.0  12.4   78.50
nvme0n1  0.00 120.00      0.0  9600.0   0.8   15.20
```

New columns:

| Column | Meaning |
|--------|---------|
| `await` | Average time (ms) for I/O requests to complete — from issue to finish. Includes time in the queue + time being serviced |
| `%util` | Same as above — device saturation |

Compare `await` between devices. A spinning HDD with `await: 15ms` is healthy. An SSD with `await: 15ms` is a problem — something is wrong at a higher layer.

### Which Partitions are Hot?

```bash
# iostat with partition-level detail
$ iostat -p ALL 2 1
Linux 5.15.0-generic (hostname)   05/06/2026   _x86_64_   (8 CPU)

Device:         tps    kB_read/s   kB_wrtn/s   kB_read   kB_wrtn
sda            57.00       600.0      2400.0      1200       4800
sda1           10.00       200.0       100.0       400        200
sda2            0.00         0.0         0.0         0          0
sda5           47.00       400.0      2300.0       800       4600
```

This tells you which partition is generating the load. `sda5` is your data partition — that's where the I/O pressure is.

## iotop: Per-Process I/O at a Glance

`iostat` tells you *which device* is busy. `iotop` tells you *which process* is doing it, in real time, like `top` for I/O.

```bash
$ sudo iotop --only
Total DISK READ:        0.00 B/s | Total DISK WRITE:     820.23 M/s
TID  PRIO  USER     DISK READ  DISK WRITE  SWAPIN   IO    COMMAND
1218 be/4 root        0.00 B/s  820.23 M/s   0.00 % 95.54 % dd if=/dev/zero of=/mnt/testfile bs=1M count=1000
  932 be/4 root        0.00 B/s    5.23 M/s   0.00 %  1.23 % [jbd2/sda5-8]
  1 be/3 root          0.00 B/s    0.00 B/s   0.00 %  0.00 % init
```

Key columns:

| Column | Meaning |
|--------|---------|
| `DISK READ/WRITE` | Per-process throughput |
| `IO` | Percentage of time the process spent doing I/O (summed over the interval) |
| `SWAPIN` | Percentage of time the process spent waiting for swap-in (if applicable) |

The `--only` flag shows only processes doing actual I/O, filtering out the idle system.

### Interactive Mode

Run `iotop` without flags for a live TUI that updates every second:

```bash
$ sudo iotop
```

Use arrow keys to sort by different columns. Press `r` to reverse sort. Press `q` to quit.

### Batch Mode for Scripting

```bash
# Capture 10 samples at 1-second intervals, no TUI
$ sudo iotop -b -n 10 -d 1 > iotop.log
```

Useful for capturing I/O patterns over time before you root-cause an issue.

## pidstat: Per-Process I/O with More Detail

`pidstat` (also from `sysstat`) provides per-process I/O statistics with more granularity than `iotop`:

```bash
# 2-second intervals, 5 iterations, show I/O stats
$ pidstat -d 2 5
Linux 5.15.0-generic (hostname)   05/06/2026   _x86_64_   (8 CPU)

Average:      UID       PID       kB_rd/s       kB_wr/s       kB_ccwr/s   iodelay        Command
----------  -----  ---------  -----------  -----------  ------------  ---------  ---------------
Average:      0     1218      0.00          820230.00     0.00          0          dd
Average:      0      932      0.00          5320.00       0.00          0          jbd2/sda5-8
```

New columns:

| Column | Meaning |
|--------|---------|
| `kB_rd/s`, `kB_wr/s` | KB read/written per second |
| `kB_ccwr/s` | KB cancelled per second (writes that were issued but then cancelled — e.g., a file was truncated after being written) |
| `iodelay` | I/O delay in clock ticks — time the process spent blocked waiting for I/O scheduler and block device |

The `iodelay` metric is particularly valuable. If `dd` has `iodelay: 0` but your database has `iodelay: 1500`, you know the database is sitting in the I/O queue.

### pidstat -p for a Specific Process

```bash
# Watch a specific process's I/O
$ pidstat -p $(pgrep -f mysqld) -d 1 10
```

### pidstat -t for Threads

```bash
# Break down I/O by thread within a process
$ pidstat -t -p $(pgrep -f mysqld) -d 1 3
Average:      UID       TGID       TID       kB_rd/s    kB_wr/s   iodelay  Command
----------  -----  ---------  ---------  ----------  ---------  ---------  -------
Average:      999    2345       -         120.00      0.00       0          mysqld
Average:      999    -         2345       0.00        0.00       0          |- mysqld
Average:      999    -         2346       120.00      0.00       0          |- mysqld (innodb: write thread0)
Average:      999    -         2347       0.00        0.00       0          |- mysqld (innodb: write thread1)
```

This is critical for MySQL/PostgreSQL where you have multiple I/O threads and need to understand which ones are active.

## blktrace: The Block Layer Under a Microscope

`iostat` and `pidstat` tell you *that* I/O is happening. `blktrace` tells you *exactly what the block layer is doing* — every I/O operation, categorized by the stage it passed through.

`blktrace` traces events at the block I/O layer, before the scheduler merges and queues them. This is the deepest possible look at I/O behavior.

### How blktrace Works

`blktrace` attaches to a block device and captures events as I/O requests flow through the block layer:

```
Application: write(2)
    ↓
Generic Block Layer: make_request()
    ↓
I/O Scheduler: insert request, merge requests, dispatch
    ↓
Device Driver: issue to hardware
    ↓
Device: completes
```

Each stage emits an event. `blktrace` captures these via the `relay` filesystem.

### Running blktrace

```bash
# Trace sda, 30-second capture
$ sudo blktrace -d /dev/sda -o sda_trace

# This creates sda_trace.blktrace.* files (one per CPU)

# Stop with Ctrl-C after capturing
```

### Reading blktrace with blkparse

```bash
# Merge and display the trace files
$ blkparse -i sda_trace
  8,0   3        1     0.000000000  1218  A  W 73275264 + 8 <- (8,5) 73274624
  8,0   3        2     0.000001234  1218  Q  W 73275264 + 8 [dd]
  8,0   3        3     0.000002456  1218  G  W 73275264 + 8 [dd]
  8,0   3        4     0.000003678  1218  I  W 73275264 + 8 [dd]
  8,0   3        5     0.000005890  1218  D  W 73275264 + 8 [dd]
  8,0   3        6     0.012345678  1218  C  W 73275264 + 8 [dd]
```

The action letters are the key:

| Action | Meaning |
|--------|---------|
| `A` | I/O is queued (remapped by device mapper) |
| `Q` | I/O queued to the I/O scheduler |
| `G` | I/O get request (scheduler created a request struct) |
| `I` | I/O inserted into the scheduler queue |
| `D` | I/O dispatched to the device driver |
| `C` | I/O completed |

The time delta between `Q` and `D` tells you how long the request sat in the scheduler queue. If that's large, your scheduler is the bottleneck, not the device.

### btt: Analyzing blktrace Reports

The `btt` tool (part of the `blktrace` suite) produces latency analysis:

```bash
$ blkparse -i sda_trace -d sda_trace.bin
$ btt -i sda_trace.bin
```

Output includes per-device and per-CPU summaries: average queue depth, I/O latencies by block, and time breakdowns between stages.

## The Diagnostic Flow

When you notice I/O wait in `top` or `%util` near 100%, here's the sequence:

```
1. iostat -x 2        → which device is saturated?
       ↓
2. iostat -p ALL 2    → which partition on that device?
       ↓
3. iotop --only       → which process is doing it?
       ↓
4. pidstat -p <pid> -d 1  → what's that process's I/O rate and iodelay?
       ↓
5. blktrace (if needed) → what's the block layer doing? Queue depth? Latency per stage?
```

By step 4, you usually know enough to fix the problem. `blktrace` is for when you suspect the block layer itself is the culprit (scheduler tuning, queue depth issues).

## Common Patterns and Fixes

### Pattern: High write I/O, low read I/O, jbd2 process

```
Device:  w/s: 400, wkB/s: 8000, %util: 90
Process: jbd2/sda5-8  IO: 80%
```

This is filesystem journal activity. Your options:
- Reduce `commit=` interval in `/etc/fstab` (default: 5s)
- Use `data=writeback` mode for ext4 (vs default `data=ordered`)
- Switch to a filesystem with a smaller journal (xfs) or SSD with capacitor-backed write cache

### Pattern: Many small reads, high iodelay on a specific process

```
Process: postgres  kB_rd/s: 500, iodelay: 1200
Device:  r/s: 200, await: 45ms
```

Random read I/O from a database. The `await` is high because the disk is seeking (HDD) or the I/O queue is deep. Options:
- Increase `random_read_ahead` in PostgreSQL
- Add RAM for more buffer cache
- Move to an SSD
- Partition the database across multiple volumes

### Pattern: Synchronous I/O from application

```
Device:  w/s: 100, wkB/s: 500, await: 8ms
Process: myapp  iodelay: 750
```

The process is synchronous — it's waiting on every write before continuing. The `iodelay` >> `await` means it's spending most of its time blocked in the I/O layer. Options:
- Switch to `O_DIRECT` with async I/O
- Use `libaio` or `io_uring` for async I/O
- Batch writes in the application

## Linux sysctl for I/O Tuning

```bash
# Increase the I/O scheduler queue depth (for high-end NVMe)
sysctl -w dev.$(lsblk -d -o NAME | tail -n1 | tr -d '[:space:]').queue_depth=1024

# Set the I/O scheduler (per-device)
#noop for fast NVMe, bfq for spinning disk, mq-deadline for general use
echo "none" > /sys/block/nvme0n1/queue/scheduler

# Reduce I/O scheduler latency for reads
echo 16 > /sys/block/sda/queue/iosched/read_lat_nsec

# Enable discard/TRIM for SSDs (mount option)
# Add discard to /etc/fstab: /dev/sda1 / ext4 defaults,discard 0 1
```

## Putting It Together

I/O debugging is a three-layer problem:

1. **Device layer** — Is the disk itself saturated? (`iostat %util`)
2. **Process layer** — Which process is driving the load? (`iotop`, `pidstat`)
3. **Block layer** — What's happening inside the kernel? (`blktrace`)

Most of the time, `iostat` + `iotop` gets you 90% of the answer in 2 minutes. The remaining 10% requires `blktrace`, but it's invaluable when the block layer itself is the constraint — scheduler latency, request queue overflow, or driver bugs.

Now you have the tools. Go find your bottleneck.