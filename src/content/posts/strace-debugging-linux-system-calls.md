---
title: "strace: Debugging Linux System Calls Like a Pro"
description: "Learn how strace works under the hood, how to read its output, and how to debug real-world Linux problems with it."
date: 2026-05-03
tags: ["linux", "debugging", "strace", "system-calls", "troubleshooting", "observability"]
---

When something goes wrong on a Linux system — a program hangs, a file doesn't open, a connection fails — you need to know what's actually happening underneath. That's where `strace` becomes indispensable. It intercepts and records every system call a program makes, giving you X-ray vision into the kernel's interaction with userspace.

This isn't a beginner tutorial. This is how `strace` actually works, how to read its output efficiently, and how to apply it to real debugging scenarios.

## How strace Works: ptrace Under the Hood

`strace` relies on `ptrace`, a Linux system call that provides the fundamental mechanism for process tracing. Understanding this relationship explains both the power and the overhead of `strace`.

```c
// The ptrace call signature
long ptrace(enum __ptrace_request request, pid_t pid, void *addr, void *data);
```

When you run `strace -p PID`, the tracer (strace) attaches to the target process via `PTRACE_ATTACH`. The kernel then stops the target process whenever a system call is entered or exited, and strace gets to inspect and optionally modify the call parameters and return values.

The trace flow looks like this:

```
Process calls write(fd, "hello", 5)
         │
         ▼ (enters kernel)
    ──sys_enter_write──▶  strace catches it: write(1, "hello", 5)
         │
         ▼ (kernel does the work)
    ──sys_exit_write───▶  strace catches return: 5
         │
         ▼ (returns to userspace)
write returns 5
```

This enter/exit pair is what makes `strace` so verbose — you're seeing both sides of every system call.

## Reading strace Output

Raw strace output looks overwhelming at first, but it's quite structured:

```
write(1, "Hello, world!\n", 14)         = 14
^CALL        ^args                 ^return value
```

The format is: `syscall(arg1, arg2, ...) = result`. Simple enough, but there are nuances.

### Decoding Pointers and Strings

When a system call takes a pointer to memory (like a buffer), strace has to dereference it carefully. For strings, it shows the actual content:

```
open("/etc/passwd", O_RDONLY) = 3
```

For binary buffers or complex structures, you'll see hex dumps:

```
read(3, "root\0x00x00x00..." , 1024) = 1024
```

### Signal Delivery

System calls can be interrupted by signals. When this happens, strace shows it explicitly:

```
read(3, "data..."..., 4096) = -1 EINTR (Interrupted system call)
```

This tells you the `read` didn't fail — it was just interrupted. This is normal behavior for signal handlers.

## Essential strace Flags

### Filtering by System Call: `-e trace=`

You rarely want to see every system call. The `-e trace=` option filters to specific calls:

```bash
# Trace only file opens
strace -e trace=open,openat,creat myprogram

# Trace all network-related calls
strace -e trace=network myprogram

# Trace memory mapping
strace -e trace=mmap,mprotect,munmap myprogram

# Trace process creation (very useful)
strace -e trace=fork,vfork,clone,execve myprogram
```

### Counting Calls: `-c`

For profiling which system calls a program uses most:

```bash
$ strace -c find /usr -name "*.conf" 2>&1 | head -30

% time     seconds  usecs/call     calls    errors syscall
------ ----------- ----------- --------- --------- ------------------
 40.12    0.000312           2       198           getdents64
 22.05    0.000171           0      1218           newfstatat
 15.23    0.000118           0       204           close
 12.87    0.000100           0       198      195 openat
  4.97    0.000038           0       396           read
  2.87    0.000022           0        66           write
  1.89    0.000014           2         8           mprotect
------ ----------- ----------- ----------- --------- ------------------
100.00    0.000777                   2288      195 total
```

This immediately shows you that `getdents64` and `newfstatat` dominate — useful for understanding program behavior or spotting unnecessary filesystem churn.

### Tracing Running Processes: `-p PID`

You can attach to any running process:

```bash
# Attach to a hanging process
strace -p 12345

# Attach and see only network calls
strace -p 12345 -e trace=network

# Attach with timing information
strace -p 12345 -e trace=network -r
```

The `-r` flag shows relative timestamps between calls, which is excellent for finding latency hotspots.

### Following Forks and Threads: `-f` and `-ff`

By default, strace only traces the main thread. For daemons and multi-threaded programs:

```bash
# Follow child processes (fork/clone)
strace -f mydaemon

# Write separate files per process (-ff)
strace -ff -o /tmp/trace mydaemon
# Creates: trace.12345, trace.12346, etc.
```

When you use `-ff`, each process gets its own trace file named `output.<PID>`, which is essential for debugging forking servers.

## Real Debugging Scenarios

### Scenario 1: A Program That Hangs on Startup

Your application just sits there, not logging anything. What do you do?

```bash
# Find the PID (or start it under strace directly)
strace -f -e trace=network,file ./myapp

# Or attach to a hanging process
PID=$(pgrep -f myapp)
strace -p $PID -e trace=network,file
```

What to look for:
- A long gap between calls might indicate a network timeout
- Repeated DNS queries without responses = DNS failure
- `connect()` calls hanging = firewall block or unreachable host
- `open()` failing repeatedly = missing file or permission issue

### Scenario 2: Debugging a "Permission Denied" Error

```bash
$ strace -e trace=open,openat,access,stat ./myapp 2>&1 | grep -i denied
openat(AT_FDCWD, "/etc/shadow", O_RDONLY) = -1 EACCES (Permission denied)
```

You can immediately see which file triggered the error and with what flags.

### Scenario 3: Finding a File Descriptor Leak

File descriptor leaks happen when a program opens files but doesn't close them. Eventually, it hits the ulimit:

```bash
$ strace -c -e trace=open,openat,close ./myapp 2>&1
% time     seconds  usecs/call     calls    errors syscall
------ ----------- ----------- --------- --------- ------------------
 99.01    0.000412           0       500       300 openat
  0.99    0.000004           0       200           close
------ ----------- ----------- ----------- --------- ------------------
total             0.000416                 700       300 total
```

500 opens but only 200 closes? You have a leak. Combine this with `-f` to catch it in child processes too.

### Scenario 4: Reverse-Engineering a Program's Behavior

When you don't have source and need to understand what a binary is doing:

```bash
# Full trace with timestamps, output to file
strace -f -t -o /tmp/strace.log ./unknown_binary

# Look for suspicious activity
grep -E "socket|connect|execve" /tmp/strace.log

# Check if it's talking to known bad IPs
strace -f -e trace=network ./unknown_binary 2>&1 | grep -E "connect\(2[3-9]"
```

### Scenario 5: Debugging Shared Library Issues

Sometimes a program picks up the wrong library:

```bash
$ LD_DEBUG=libs ./myapp 2>&1 | head -50
      2:     calling init: /lib/x86_64-linux-gnu/libc.so.6
      2:     binding file /lib/x86_64-linux-gnu/libc.so.6 [0] to '/lib/x86_64-linux-gnu/libc.so.6' [0]
      2:     dt_got: 0x7f8a4d4a2000 offset: 0x268000 thunk: 0x7f8a4d4a2a40
```

`strace` with `LD_DEBUG` isn't strace itself, but it's often used alongside it for library debugging.

## Performance Considerations

`strace` is not free. Every system call becomes two context switches (enter + exit), and each context switch involves kernel-userspace transitions. For a program making millions of calls, this can slow it by 10x or more.

Use `-c` to summarize before doing detailed tracing. If something takes 10ms in production but 5 seconds under strace, you've found your bottleneck (it's probably not the system calls themselves — it's something strace forces you to wait for, like a network timeout that only manifests under instrumentation).

For low-overhead tracing in production, consider eBPF-based tools instead (see the related post on eBPF). `strace` is for deep debugging sessions, not continuous monitoring.

## Useful One-Liners

```bash
# Show only failed system calls
strace -f -e trace=desc myapp 2>&1 | grep -v "= -1" | grep -E "= -[0-9]+"

# Get a syscall timeline with relative timestamps
strace -r -f -p PID

# Print instruction pointer during calls (for crash debugging)
strace -i myapp

# Follow only new processes after a certain point
strace -b execve -f -p PID
```

## Conclusion

`strace` is one of those tools that separates engineers who can debug from those who can't. It won't tell you your code is wrong, but it will show you exactly what your code asked the kernel to do — and what the kernel said back.

Master the filter flags (`-e trace=`, `-c`), get comfortable with `-f` for multi-process work, and learn to read the output format. With practice, you'll trace a problem in minutes that would otherwise take hours of code archaeology.

The next time a program hangs, fails to open a file, or can't connect to a service, reach for `strace`. The kernel is telling you exactly what's wrong — you just have to listen.

---

**External Resources**

- [strace man page](https://man7.org/linux/man-pages/man1/strace.1.html) — Complete flag reference
- [Linux man pages section 2](https://man7.org/linux/man-pages/man2/) — System call documentation
- [Julia Evans' strace zine](https://jvns.ca/strace-zine.pdf) — Visual explanation of strace internals
- [The ptrace(2) man page](https://man7.org/linux/man-pages/man2/ptrace.2.html) — For understanding strace's foundation