---
title: "Linux Process Management: Understanding ps, top, and htop"
description: "Linux process model, /proc filesystem, ps, top, htop, process states, signals, zombie and orphan processes, CPU and memory metrics, and how the kernel tracks running programs."
date: 2024-03-01
tags: ["linux", "processes", "performance", "system-administration", "ps", "top", "htop"]
---

Every running program on a Linux system is a process. Understanding how to inspect, monitor, and manage these processes is fundamental to being an effective system administrator or developer. The `/proc` filesystem, `ps`, `top`, and `htop` are your primary tools for this work.

## The /proc Filesystem: Where Process Data Lives

Before we talk about commands, let's understand where the data comes from. Linux presents processes as a virtual filesystem at `/proc`. Each running process has a numeric directory:

```
/proc/1/     # The init/systemd process
/proc/1234/  # Some other process with PID 1234
/proc/self/  # Symlink to the current process
```

Inside each directory you'll find:
- `cmdline` — the full command line (null-separated)
- `environ` — environment variables
- `fd/` — file descriptors (symlinks to open files)
- `status` — human-readable process status
- `stat` — machine-readable process info (used by `ps`)

When you run `ps`, it's essentially reading and parsing these `/proc/<pid>/` directories. That's why `ps` can be so fast—even on systems with thousands of processes.

## ps: The Classic Process Viewer

`ps` is the oldest and most portable. The output format depends on which flags you use.

### BSD Syntax (no leading dash)

```bash
ps aux
```

This is probably the most common usage:
- `a` — all processes with a terminal (tty)
- `u` — user-oriented format (shows CPU%, MEM%, VSZ, RSS)
- `x` — processes without a terminal

```bash
$ ps aux
USER         PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND
root           1  0.0  0.1  8976  7364 ?        Ss   2024    0:35 init [2]
root         234  0.0  0.0  1234   456 ?        S    2024    0:01 some-daemon
```

### Linux/System V Syntax (leading dash)

```bash
ps -ef
```

- `-e` — all processes
- `-f` — full format

```bash
$ ps -ef
UID          PID    PPID    C STIME TTY          TIME CMD
root           1      0      0 2024 ?        00:00:35 /sbin/init
root         234      1      0 2024 ?        00:00:01 /usr/sbin/sshd
```

### Custom Output with ps

You can customize columns with `-o`:

```bash
ps -eo pid,user,comm,%cpu,%mem,etime
```

Common columns:
- `pid` — process ID
- `ppid` — parent PID
- `user` — effective user
- `comm` — command name (no path)
- `args` — full command with arguments
- `%cpu` — CPU utilization
- `%mem` — memory utilization
- `etime` — elapsed time since process started
- `stat` — process state (R/S/D/Z/T/X)

### Filtering Processes

```bash
# Show only processes for a specific user
ps -u username

# Show a specific process by PID
ps -p 1234

# Show processes matching a command name
ps -C nginx

# Combine filters
ps -u username -o pid,comm,%cpu
```

### The STAT Column Explained

The `STAT` column shows process state codes:

| Code | Meaning |
|------|---------|
| `R` | Running or runnable |
| `S` | Sleeping (interruptible) |
| `D` | Uninterruptible sleep (usually I/O) |
| `Z` | Zombie |
| `T` | Stopped (suspended) |
| `X` | Dead (shouldn't be visible) |

Multi-character codes add info:
- `<` — high priority (nice < -20)
- `N` — low priority (nice > 0)
- `L` — locked pages in memory
- `s` — session leader
- `l` — multi-threaded
- `+` — in foreground process group

## top: Real-Time Process Monitoring

While `ps` gives you a snapshot, `top` gives you a continuous view. By default it refreshes every 3 seconds.

```bash
top
```

### top's Display

```
top - 14:32:01 up 45 days,  3:22,  2 users,  load average: 0.52, 0.48, 0.41
Tasks: 287 total,   1 running, 286 sleeping,   0 stopped,   0 zombie
%Cpu(s):  4.2 us,  1.3 sy,  0.0 ni, 94.5 id,  0.0 wa,  0.0 hi,  0.0 si,  0.0 st
MiB Mem :  32678.4 total,   8423.2 free,  18453.2 used,   5802.0 buff/cache
MiB Swap:   2048.0 total,   1536.0 free,    512.0 used.  18765.3 avail Mem

  PID USER      PR  NI   VIRT    RES    SHR S  %CPU %MEM     TIME+ COMMAND
12345 www-data  20   0  512344  82944  15236 S   2.1  0.3   0:12.34 nginx
```

The header shows:
- **Load average**: 1, 5, and 15-minute averages (number of processes waiting for CPU)
- **Cpu(s)**: user (`us`), system (`sy`), nice (`ni`), idle (`id`), iowait (`wa`)
- **Mem**: total, free, used, buffers/cache

### Interactive top Commands

Inside `top`, press:
- `q` — quit
- `1` — toggle per-CPU view
- `h` — help
- `k` — kill a process
- `r` — renice a process
- `P` — sort by CPU (default)
- `M` — sort by memory
- `N` — sort by PID
- `T` — sort by time+
- `u` — filter by user
- `f` — configure fields/columns

### Field Selection

Press `f` to enter the field management screen. You can:
- Move fields with arrow keys
- Toggle fields with `space`
- Sort with `s`

Press `o` (lowercase) to change sort field directly.

### Batch Mode

`top` is also useful for scripting:

```bash
# Run 5 iterations, show processes sorted by CPU
top -b -n 5 -d 1 -o %CPU
```

## htop: A Better top

`htop` is a more user-friendly alternative to `top`. It requires installation (`apt install htop` or `yum install htop`).

### Why htop?

1. **Color-coded** —一眼就看出 CPU, MEM usage
2. **Scrollable process list** — navigate with arrow keys
3. **Progress bars** — easier to read than numbers
4. **Kill/renice without entering PID** — just select and press key
5. **Tree view** — see parent-child relationships

### htop Interface

```
  CPU[||             12.3%]    Tasks: 87, 143 thr; 1 running
  Mem[|||||||||||  48.3%]    Load average: 0.52
  Swp[||             5.1%]    Uptime: 45 days, 3:22

  PID   USER   PRI  NI  VIRT   RES   SHR S  %CPU %MEM    TIME+
 12345 www     20   0   512M  82M   15M S   2.1  0.3    0:12.34 nginx
```

Press `F2` to see the setup menu where you can customize columns and display options.

### htop Keybindings

- `h` — help
- `Up/Down` — select process
- `Left/Right` — scroll columns
- `Space` — tag/select process
- `u` — show processes for a specific user
- `t` — toggle tree view
- `F5` — refresh display
- `F6` — sort by column (select with arrow keys)
- `F9` — kill selected process
- `F7/F8` — decrease/increase nice value

### htop Color Schemes

Press `F2` → Display options → Colour → choose scheme. Options include:
- `Default` — basic monochrome
- `Midnight` — dark theme
- `Sweet` — pastel colors
- `Monochromatic`

### htop Customization

```bash
# Start with specific options
htop -d 5          # 5 second refresh instead of default
htop -u www-data   # show only www-data processes
htop -p 1234,5678  # monitor specific PIDs
htop -t            # start in tree view
```

## Understanding Process States Under the Hood

Let's look at what the kernel actually tracks. Each process has a `task_struct` in the kernel:

```c
struct task_struct {
    pid_t                pid;           // Process ID
    pid_t                tgid;          // Thread group ID
    struct task_struct   *parent;       // Parent process
    struct list_head     children;      // Child processes
    struct files_struct  *files;        // Open files
    struct mm_struct     *mm;           // Memory layout
    int                  prio;          // Scheduling priority
    int                  static_prio;   // Static priority
    int                  normal_prio;   // Normal priority
    unsigned int         rt_priority;   // Real-time priority
    unsigned             policy;        // Scheduling policy
    // ... many more fields
};
```

The kernel maintains a red-black tree of all processes, indexed by PID. This allows O(log n) lookup by PID.

### Process Creation Flow

When you run a command:

```
fork() → copy process descriptor → execve() → replace memory space → schedule()
```

1. **fork()** creates a child process that's a copy of the parent
2. **execve()** replaces the child's memory with the new program
3. **schedule()** decides when the process gets CPU time

## Signal Handling

Processes communicate via signals. Common signals:

| Signal | Number | Meaning | Default Action |
|--------|--------|---------|----------------|
| `SIGTERM` | 15 | Polite termination request | Terminate |
| `SIGKILL` | 9 | Force kill (cannot be caught) | Terminate |
| `SIGINT` | 2 | Interrupt (Ctrl+C) | Terminate |
| `SIGSTOP` | 19 | Stop process (Ctrl+Z) | Stop |
| `SIGCONT` | 18 | Continue stopped process | Continue |
| `SIGHUP` | 1 | Hangup (often means "reload config") | Terminate |

```bash
# Send SIGTERM to process
kill 12345

# Send SIGKILL
kill -9 12345

# Send SIGHUP (reload)
kill -HUP 12345

# Send to process by name
pkill nginx

# Send to all processes by name
killall nginx
```

## Process Priority: Nice Values

The kernel schedules processes based on priority. `nice` values range from -20 (highest priority) to +19 (lowest priority):

```bash
# Run a process with lower priority
nice -n 10 ./my-script.sh

# Change priority of running process
renice 10 -p 12345

# Make process run first (requires root)
renice -20 -p 12345
```

For real-time processes, you need `chrt`:

```bash
# Run with FIFO scheduling at priority 50
chrt -f 50 ./my-realtime-app
```

## Practical Examples

### Find processes using most CPU

```bash
ps aux --sort=-%cpu | head -11
```

### Find memory hogs

```bash
ps aux --sort=-%mem | head -11
```

### Find zombie processes

```bash
ps aux | grep Z
# Or more reliably
ps aux | awk '$8 ~ /^Z/'
```

### Watch a specific process in real-time

```bash
watch -n 1 'ps -p 1234 -o %cpu,%mem,cmd'
```

### Find process by port

```bash
lsof -i :8080
# Or
ss -tlnp | grep :8080
```

### Debug a runaway process

```bash
# See what files it has open
lsof -p 12345

# See its network connections
lsof -i -a -p 12345

# See what system calls it's making
strace -p 12345 -f

# See which library calls (lighter weight)
ltrace -p 12345
```

*Want to practice these commands on a live system? [Spin up a Linux VPS with Vultr](https://www.vultr.com/?ref=8914132) — deploy in 60 seconds, $100 free credit for new accounts.*

## Conclusion

Linux process management is built on the `/proc` filesystem and a set of tools that let you inspect what's running. `ps` gives you snapshots, `top` gives you live updates, and `htop` makes the whole experience more pleasant.

The key concepts:
- Every process has a PID and a parent
- The kernel maintains process state (running, sleeping, zombie, etc.)
- Signals are the primary inter-process communication mechanism
- Nice values control CPU scheduling priority
- `/proc/<pid>/` contains all the per-process data

Master these tools and you'll be able to debug almost any performance issue on a Linux system.