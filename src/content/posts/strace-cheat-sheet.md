---
title: "strace Cheat Sheet: Every Syscall, Flag, and Trick You Need"
description: "Complete strace reference with examples for every common syscall, must-know flags like -e, -c, -f, and advanced techniques like following forks and tracing attached processes."
date: 2026-05-05
tags: ["linux", "strace", "debugging", "system-calls", "cheat-sheet", "troubleshooting"]
---

`strace` is the first tool to reach for when a Linux program misbehaves. It intercepts every system call, letting you see exactly what a program asks of the kernel and what the kernel sends back. This is a dense, complete reference — everything you need in one place.

<!-- more -->

## Installation

```bash
# Debian/Ubuntu
sudo apt install strace

# RHEL/CentOS/Fedora
sudo dnf install strace

# Alpine
apk add strace

# macOS (limited — uses DTrace instead)
sudo dtrace -p PID   # native macOS alternative
```

## Basic Syntax

```bash
strace [options] <command>           # Trace a new process
strace -p <PID> [options]           # Attach to running process
strace -p <PID> -p <PID2>           # Trace multiple processes
```

Output format: `syscall(arg1, arg2, ...) = result` or `syscall(...) = -1 ERRNO (message)`.

---

## Process Attachment

```bash
# Attach to a running process by PID
strace -p 12345

# Attach to multiple PIDs
strace -p 12345 -p 12346 -p 12347

# Trace a new process with args
strace -f ./my_program --config /etc/app.conf

# Kill the traced process on strace exit (default: process continues)
strace -b kill -p 12345

# Detach without killing (default behavior)
strace -p 12345
```

---

## Syscall Filtering with `-e`

This is the most important flag. Don't trace everything — filter to what matters.

```bash
# Trace specific syscalls (comma-separated)
strace -e trace=open,openat,read,write,close ./myapp

# Trace by category
strace -e trace=file          # File I/O: open, read, write, close, stat, etc.
strace -e trace=network       # Network: socket, connect, accept, send, recv, etc.
strace -e trace=signal        # Signals: kill, sigaction, signal, etc.
strace -e trace=process       # Process: fork, clone, execve, wait, exit, etc.
strace -e trace=ipc           # IPC: msgget, msgsnd, msgrcv, semget, etc.
strace -e trace=desc          # All file descriptor ops (read, write, open, close, etc.)
strace -e trace=memory        # mmap, mprotect, munmap, brk, etc.

# Trace everything EXCEPT certain syscalls
strace -e trace=\!inotify_init,inotify_add_watch ./myapp

# Trace by syscall name (alternative syntax)
strace -e trace=write ./myapp

# Use a regex pattern (newer strace versions)
strace -e trace=/poll,select,epoll_* ./myapp
```

### Real example — find which config file a program reads:

```bash
$ strace -e trace=open,openat ./myapp 2>&1 | grep '\.conf'
openat(AT_FDCWD, "/etc/myapp/config.conf", O_RDONLY) = 3
openat(AT_FDCWD, "/home/user/.myapprc", O_RDONLY) = -1 ENOENT (No such file or directory)
```

---

## Counting and Profiling with `-c`

Summary of syscalls made, sorted by time or call count.

```bash
# Count syscalls, show time spent
strace -c ./myapp

# Count only, suppress per-call output
strace -c -q ./myapp

# Show syscalls + summary (print both trace and counts)
strace -c -f ./myapp 2>&1 | tail -20
```

**Example output:**

```
$ strace -c find /usr -name "*.conf" 2>&1

% time     seconds  usecs/call     calls    errors syscall
------ ----------- ----------- --------- --------- ------------------
 38.21    0.000298           1       412           getdents64
 21.55    0.000169           0      2410           newfstatat
 15.80    0.000124           0       410      195 openat
 12.37    0.000097           0       412           close
  6.87    0.000054           0       778           read
  2.94    0.000023           0       128           write
  1.26    0.000010           0        14            mprotect
  1.00    0.000008           2         4            getdents
------ ----------- ----------- ----------- --------- ------------------
total             0.000780                 4568      195 total
```

**Interpretation:** `getdents64` dominates — this `find` is doing heavy directory traversal. 195 `openat` calls returned errors (likely permission denied on `/proc` or similar). This is your optimization target.

---

## Following Child Processes with `-f` and `-ff`

By default, strace only traces the main thread. Multi-process programs need `-f`.

```bash
# Follow forks/clones
strace -f ./mydaemon

# Follow and write separate files per PID
strace -ff -o /tmp/trace ./mydaemon
# Creates: trace.12345, trace.12346, ...

# Combine -f and -c for a count across all children
strace -fc ./mydaemon

# Follow with verbose fork info
strace -v -f ./mydaemon
```

### Real example — trace a forking server:

```bash
$ strace -f -e trace=clone,execve -p $(pgrep -f myserver) 2>&1
[pid 23789] clone(child_stack=0x7f9a4d4a2000, flags=CLONE_VM|CLONE_FS|CLONE_SIG...)
             = 23790
[pid 23790] execve("/usr/sbin/myserver-worker", ["myserver-worker", "--pool=2"], ...)
             = 0
```

---

## Output Format Flags

### Timestamps

```bash
# Relative time since previous call (microsecond precision)
strace -r ./myapp

# Absolute timestamp per line
strace -t ./myapp

# Timestamp with microseconds
strace -tt ./myapp

# Timestamp with seconds since epoch
strace -T ./myapp
```

**Example output with `-tt`:**

```
10:23:45.123456 write(1, "Starting up\n", 13)   = 13
10:23:45.124102 open("/etc/app.conf", O_RDONLY) = 3
10:23:45.124891 read(3, "[config]\ntimeout=30\n"..., 512) = 47
```

### Color and Readable Strings

```bash
# Colorize output (auto-detects TTY)
strace -y ./myapp

# Print pathnames for file descriptors
strace -y ./myapp

# Suppress the "Syscall entered/exited" prefix noise
strace -i ./myapp          # Show instruction pointer
strace -n ./myapp          # Indent continuation lines
```

### String Printing

```bash
# Decode errno names to human-readable strings
strace -e trace=none -r ./myapp   # Show only timing

# Force string decoding for unknown fd types
strace -s 1024 ./myapp   # Truncate strings at 1024 chars (default: 32)
```

### Qualified Output Qualification

```bash
# Print the calling instruction pointer
strace -i ./myapp

# Show verbose output for ambiguous structures
strace -v ./myapp

# Show raw syscall numbers (useful for debugging strace itself)
strace -P /path/to/file ./myapp   # Only trace calls accessing this path
```

---

## Following Specific File Descriptors

```bash
# Trace only interactions with a specific file descriptor
strace -e trace=read,write -P 3 ./myapp

# Trace only calls touching a specific file or directory
strace -P /etc/passwd ./myapp

# Trace multiple paths
strace -P /etc/passwd -P /var/log/app.log -e trace=openat ./myapp
```

Real example — see what a process reads from stdin (fd 0):

```bash
$ strace -e trace=read -P 0 -p 12345 2>&1
read(0, "SELECT * FROM users\n", 1024) = 23
```

---

## Timing Analysis

```bash
# Relative timestamps (time since last call) — best for finding latency
strace -r ./myapp

# Wall-clock timestamps
strace -t ./myapp

# Syscall duration (shown in angle brackets after each line)
strace -T ./myapp

# Combined: timestamps + duration
strace -ttT ./myapp
```

**Example with `-T` (duration):**

```
openat(AT_FDCWD, "/etc/app.conf", O_RDONLY) = 3 <0.000041>
read(3, "[config]\nhost=localhost\n", 512) = 47 <0.000012>
write(1, "Config loaded OK\n", 16) = 16 <0.000008>
```

That `0.000041` on the `openat` is how long the call took. Find the outliers and you've found your latency.

---

## Filtering by Result (Error Detection)

```bash
# Show only failed calls (any non-zero or negative result)
strace -z ./myapp          # Only calls with return = 0
strace -Z ./myapp          # Only calls with return != 0 (errors)

# Equivalent manual filter
strace ./myapp 2>&1 | grep "= -1"

# Show failed calls of specific types
strace -Z -e trace=open,openat ./myapp

# Count only failed calls
strace -c -Z -e trace=open,openat ./myapp
```

**Real example — find all "permission denied" errors:**

```bash
$ strace -e trace=open,openat,access ./myapp 2>&1 | grep -E "EACCES|Permission denied"
openat(AT_FDCWD, "/root/.myapp.conf", O_RDONLY) = -1 EACCES (Permission denied)
access("/etc/shadow", R_OK)                       = -1 EACCES (Permission denied)
```

---

## Interpreting Common Syscalls

### File Operations

```c
openat(fd, "/path", flags, mode) → fd        // fd: file descriptor or AT_FDCWD
read(fd, buf, count)          → bytes_read  // returns 0 on EOF
write(fd, buf, count)         → bytes_written
close(fd)                      → 0
newfstatat(fd, path, stats)   → 0            // stat() replacement; fd=AT_FDCWD for absolute
getdents64(fd, dirp, count)   → bytes_read  // read directory entries
lseek(fd, offset, whence)     → new_offset
```

### Process Creation

```c
clone(flags, child_stack, ...)        → pid      // fork replacement; check flags for threads
fork()                               → pid
vfork()                              → pid
execve(path, argv, envp)             → -1        // never returns on success
wait4(pid, status, options, rusage)   → pid       // wait for child
exit_group(status)                   → -1        // terminate all threads
```

### Memory Operations

```c
mmap(addr, length, prot, flags, fd, offset)  → addr
mprotect(addr, length, prot)                → 0
munmap(addr, length)                        → 0
brk(addr)                                  → 0
madvise(addr, length, advice)              → 0
```

### Network Operations

```c
socket(domain, type, protocol)       → fd     // domain: AF_INET, AF_UNIX; type: SOCK_STREAM, SOCK_DGRAM
bind(fd, addr, addrlen)              → 0
listen(fd, backlog)                  → 0
accept(fd, addr, addrlen)           → client_fd
connect(fd, addr, addrlen)          → 0 or -1 (non-blocking may return EINPROGRESS)
sendto(fd, buf, len, flags, dest, addrlen)   → bytes_sent
recvfrom(fd, buf, len, flags, src, addrlen) → bytes_received
shutdown(fd, how)                   → 0
```

### Signal Operations

```c
rt_sigaction(signum, act, oldact, sigsetsize) → 0
kill(pid, sig)                     → 0
sigaltstack(ss, old_ss)           → 0
```

---

## Debugging Scenarios

### A Program Hangs

```bash
# Find what's blocking — attach and filter to network + file
strace -p PID -e trace=network,file,desc -r

# Or trace all and look for the last call before silence
strace -p PID -f
# Press Ctrl-C after a few seconds — the last line is your hang point
```

### Permission Denied Errors

```bash
strace -e trace=open,openat,access,stat,statx ./myapp 2>&1 | grep -E "EACCES|Permission denied"
```

### File Descriptor Leaks

```bash
strace -c -e trace=open,openat,close -f ./myapp 2>&1
# If opens >> closes, you have a leak
```

### "Too Many Open Files" Errors

```bash
strace -e trace=open,openat,socket,accept,pipe -f -c -p PID
# Check if FDs are accumulating without being closed
```

### Reverse-Engineering an Unknown Binary

```bash
# Full trace with timestamps → file
strace -f -t -o /tmp/strace.log ./unknown_binary

# Look for interesting patterns
grep -E "execve| socket\(2," /tmp/strace.log       # what's it running / who is it talking to?
grep -E "connect\(2[3-9]" /tmp/strace.log          # connect to IPs 23-29 (hint: IRC bots)
grep -E "^  open.*\/etc\/" /tmp/strace.log          # what config files does it read?
```

### Debugging Shared Library Loads

```bash
# Not strace, but often used alongside it
LD_DEBUG=libs ./myapp 2>&1 | head -30
LD_DEBUG=bindings ./myapp 2>&1 | grep "symbol not found"
```

### Slow System Calls in Production

```bash
# Attach with timing, filter to slow calls (>1ms shown as flagged)
strace -T -f -p PID 2>&1 | grep -v " <0.0001>"

# Or pipe to a file and analyze
strace -T -f -p PID -o /tmp/slow_calls.log
```

---

## Performance Impact and Best Practices

`strace` adds significant overhead — every syscall becomes two context switches (enter + exit). A program making 10 million calls might run 5–10x slower under strace.

**Rules of thumb:**
- Use `-c` first to summarize before detailed tracing
- Filter with `-e trace=` to the minimum needed syscalls
- Attach to running processes with `-p` for production debugging
- For continuous low-overhead tracing in production, use eBPF tools instead

---

## Quick Reference Card

| Flag | What it does |
|------|-------------|
| `-e trace=syscall,..` | Filter to specific syscalls |
| `-e trace=file\|network\|signal\|process` | Filter by category |
| `-e trace=\!syscall` | Exclude syscall |
| `-c` | Count syscalls and time |
| `-f` | Follow child processes |
| `-ff` | Follow, write separate files |
| `-p PID` | Attach to running process |
| `-r` | Relative timestamps |
| `-t` | Absolute timestamps |
| `-T` | Show call duration |
| `-i` | Print instruction pointer |
| `-s N` | String print length (default 32) |
| `-o file` | Write output to file |
| `-P path` | Only trace calls touching path |
| `-y` | Show fd pathnames |
| `-z` | Only zero-return calls |
| `-Z` | Only non-zero return calls |
| `-v` | Verbose (full structures) |
| `-q` | Quiet (suppress attach messages) |
| `-b kill` | Kill process on detach |

---

`strace` won't tell you your logic is wrong, but it shows you exactly what your code asked the kernel to do. Master the filters (`-e`), learn `-f` for multi-process work, and always check `-c` before diving deep.