---
title: "GDB Debugging: From Core Dumps to Live Processes"
description: "Master GDB for debugging C/C++ programs — set breakpoints, inspect memory, analyze core dumps, and attach to live processes for production debugging."
date: 2026-05-04
tags: ["debugging", "gdb", "linux", "c", "c++", "core-dump", "systems-programming", "breakpoints"]
structuredData:
  type: "Article"
  author: "systeminternals.dev"
  datePublished: "2026-05-04"
  dateModified: "2026-05-04"
---

Every C and C++ developer eventually needs GDB. Whether you're tracking down a segfault in a fresh build or tracing a production deadlock, GDB is the definitive tool for inspecting a running (or crashed) process at the machine level.

This post covers the essential GDB workflow: breakpoints, memory inspection, core dump analysis, and live process attachment.

## Getting Started

### Basic Commands

Start GDB with your binary:

```bash
gdb ./my_program
```

Inside GDB:

```
(gdb) run [args]           # Start program (optionally with args)
(gdb) run arg1 arg2
(gdb) kill                 # Stop the running program
(gdb) quit                 # Exit GDB
```

**Execution control:**

```
(gdb) break main           # Break at function 'main'
(gdb) break 42             # Break at line 42
(gdb) next                 # Step over (no entry into functions)
(gdb) step                 # Step into (descend into function calls)
(gdb) continue             # Resume until next breakpoint or signal
(gdb) finish              # Run until current function returns
```

**Inspecting state:**

```
(gdb) print x              # Print value of variable x
(gdb) print *ptr          # Dereference a pointer
(gdb) print arr[0]@10     # Print first 10 elements of array
(gdb) backtrace           # Show call stack (alias: 'bt')
(gdb) info locals         # Show local variables
(gdb) info args           # Show function arguments
(gdb) info registers      # Show CPU registers
```

### Compiling for Debugging

Always compile with `-g` to include debug symbols:

```bash
gcc -g -O0 -o my_program my_program.c
```

`-O0` disables optimizations, giving you accurate debugging. If you must debug an optimized build, `-g` still helps, but some variables may be optimized away and line numbers may be less reliable.

## Breakpoints

### Function and Line Breakpoints

```bash
(gdb) break main           # Break on function entry
(gdb) break my_function
(gdb) break my_program.c:42  # Break at specific file:line
```

### Conditional Breakpoints

```bash
(gdb) break my_function
(gdb) condition 1 count > 100   # Breakpoint 1 only fires when count > 100
```

### Watchpoints — Break on Memory Changes

```bash
(gdb) watch global_var     # Break when global_var is written
(gdb) watch *(int*)0x8049a0  # Break when this memory location changes
(gdb) rwatch global_var    # Break on read (hardware support required)
(gdb) awatch global_var     # Break on read or write
```

### Catchpoints — Break on Events

```bash
(gdb) catch exec           # Break when a child process is exec'd
(gdb) catch fork
(gdb) catch signal SIGSEGV # Break when this signal is raised
(gdb) catch throw          # C++ exception thrown
(gdb) catch catch          # C++ exception caught
```

### Managing Breakpoints

```bash
(gdb) info breakpoints     # List all breakpoints
(gdb) disable 2            # Temporarily disable breakpoint 2
(gdb) enable 2             # Re-enable it
(gdb) delete 2             # Remove breakpoint 2
(gdb) commands 1           # Define commands to run when BP 1 hits
> print x
> continue
> end
```

## Inspecting Memory

### The `x` Command

`x` examines memory. Syntax: `x/nfu addr`

- **n** — number of units to display
- **f** — format (`x`=hex, `d`=signed decimal, `u`=unsigned decimal, `s`=string, `c`=char)
- **u** — unit size (`b`=1 byte, `h`=2 bytes, `w`=4 bytes, `g`=8 bytes)

```bash
(gdb) x/16xb ptr          # 16 hex bytes
(gdb) x/4dw arr            # 4 decimal 32-bit words (int)
(gdb) x/s 0x8049000        # Read string from address
(gdb) x/4gx 0x7fff00000000 # 4 giant (8-byte) hex values
```

### Examining Structs

```c
struct connection {
    int fd;
    char state;        // 'C'=connecting, 'O'=open, 'C'=closed
    struct in_addr ip;
    unsigned short port;
};
```

```bash
(gdb) print *conn
$1 = {fd = 5, state = 'O', ip = {s_addr = 167772162}, port = 443}
(gdb) print conn->ip.s_addr
$2 = 167772162
(gdb) p *(struct connection*)0x7fff12340000
```

### Following Pointers

```bash
(gdb) print ptr
$1 = (int*) 0x8049a0
(gdb) x/4d ptr
0x8049a0:  42   17   -1   100
(gdb) print *ptr
$2 = 42
```

### Disassembling Functions

```bash
(gdb) disassemble main
Dump of assembler code for function main:
   0x0000000000401130 <+0>:    push   %r15
   0x0000000000401132 <+2>:    push   %rbp
   0x0000000000401133 <+3>:    mov    %rsp,%rbp
   0x0000000000401136 <+6>:    sub    $0x10,%rsp
   0x000000000040113a <+10>:   mov    %edi,-0x4(%rbp)
```

## Core Dump Analysis

A core dump is a snapshot of process memory at the moment of a crash. It's your forensic evidence.

### Enabling Core Dumps

```bash
# Check current limit
ulimit -c

# Enable unlimited core dumps for this session
ulimit -c unlimited

# Set a filename pattern (Linux)
echo /tmp/core.%e.%p > /proc/sys/kernel/core_pattern
```

### Generating a Core Dump Programmatically

```c
#include <sys/resource.h>
#include <signal.h>

// On error, dump core
struct rlimit rl;
rl.rlim_cur = RLIM_INFINITY;
rl.rlim_max = RLIM_INFINITY;
setrlimit(RLIMIT_CORE, &rl);
raise(SIGUSR1);  // or SIGSEGV, etc.
```

### Analyzing a Core Dump

```bash
# Load a core dump
gdb ./my_program /tmp/core.my_program.12345

# Or just:
gdb -c /tmp/core.my_program.12345 ./my_program
```

Once loaded:

```
(gdb) bt                   # Full backtrace
(gdb) bt -10               # Last 10 frames
(gdb) frame 3              # Switch to frame 3
(gdb) print variable_name  # Inspect variables
(gdb) info registers
(gdb) disassemble
```

### Examining Crashed Stack

```
Thread 1 "my_program" received signal SIGSEGV, Segmentation fault.
0x0000000000401192 in process_request (fd=5) at request.c:142
142             buf[bytes_read] = '\0';
(gdb) bt
#0  process_request (fd=5) at request.c:142
#1  0x000000000040129a in handle_connection (arg=0x7fff12340000) at conn.c:77
#2  in pthread_join() from libpthread.so
#3  in main () at main.c:45
```

The crash at line 142 reading `buf[bytes_read]` means `bytes_read` was out of bounds — your bug is either in how `bytes_read` was set or how `buf` was allocated.

### Post-Mortem with `coredumpctl`

On systemd systems:

```bash
coredumpctl list                  # Show recent core dumps
coredumpctl debug 12345           # Load the latest dump into GDB
coredumpctl -1 gdb ./my_program   # Debug latest crash
```

## Debugging Live Processes

### Attaching to a Running Process

```bash
# Find the PID
pgrep -f my_program
# or: ps aux | grep my_program

# Attach
gdb -p 12345
# or from inside GDB:
(gdb) attach 12345
```

You'll see something like:

```
Attaching to process 12345
Reading symbols from /path/to/my_program...done.
[New LWP 12346]
[New LWP 12347]
...
```

### Detaching

```bash
(gdb) detach
(gdb) quit
```

**Note:** On some systems you need `CAP_SYS_PTRACE` or `ptrace_scope` set to 0 to attach to another user's process.

### Debugging a Forked Child

By default, GDB follows the parent. To debug the child after fork:

```
(gdb) set follow-fork-mode child
(gdb) catch fork
(gdb) run
```

### Non-Stop Mode (Multi-Threaded)

```
(gdb) set non-stop on
(gdb) thread apply all bt   # Backtrace all threads
(gdb) thread 3              # Switch to thread 3
(gdb) continue -a           # All threads
```

## Common Patterns

### Segmentation Fault

```bash
# Compile with debug + no optimize
gcc -g -O0 -o prog prog.c

# Run inside GDB — it catches the signal automatically
gdb ./prog
(gdb) run
# SIGSEGV → GDB drops you at the crash point
(gdb) bt    # full backtrace
(gdb) p i   # inspect variables
(gdb) x/16xb 0x...  # inspect raw memory
```

### Memory Leaks

GDB itself isn't a leak detector, but combined with `valgrind` it can help. For direct debugging, check allocation counts:

```c
// Instrument malloc/free
(gdb) break malloc
(gdb) commands
> silent
> set $call_count = ($call_count + 1)
> printf "malloc call #%d, size=%d\n", $call_count, (unsigned long)$arg0
> cont
> end
```

### Race Conditions

Use GDB's `set scheduler-locking step` to freeze all threads except the current one while you step through, preventing the scheduler from interleaving threads:

```
(gdb) set scheduler-locking on
(gdb) next   # Thread stays pinned
(gdb) set scheduler-locking off  # Resume normal scheduling
```

## GDB TUI Mode

GDB has a built-in TUI (Text User Interface) mode with source and register windows:

```bash
gdb -tui ./prog          # Start in TUI mode
(gdb) layout src         # Show source window
(gdb) layout regs        # Show registers window
(gdb) layout split       # Both source + regs
(gdb) layout asm         # Show assembly
(gdb) focus src          # Keyboard focus to source
(gdb) ctrl-x a           # Toggle TUI mode
```

### TUI Commands

```
Ctrl+L          # Refresh screen
Ctrl+P / Ctrl+N # Previous / next command in history
```

## Useful GDB Scripts

### Python Extension for Heap Analysis

```python
# heap.py — find allocated objects near a pointer
import gdb

def find_ptr(ptr_val):
    # Walk the heap looking for chunks containing ptr_val
    # (simplified - real implementation needs libc internals)
    pass

class FindPtr(gdb.Command):
    def __init__(self):
        super(FindPtr, self).__init__("find_ptr", gdb.COMMAND_USER)

    def invoke(self, arg, from_tty):
        ptr = gdb.parse_and_eval(arg)
        find_ptr(int(ptr))

FindPtr()
```

Load it: `source heap.py` or `set Python script-directory ~/.gdb/`.

### Auto-Backtrace on Crash

```bash
# In .gdbinit:
set pagination off
set print inferior-events off
set follow-fork-mode child

# Define a command that logs full state
define crash-log
    set logging file crash.txt
    set logging overwrite on
    set logging on
    bt
    info registers
    x/16i $pc-16
    x/16x $sp
    set logging off
end
document crash-log
  Log full crash state to crash.txt
end
```

Need a machine to practice core dump analysis? [Vultr](https://www.vultr.com/?ref=8914132) gives you a fresh Linux server in 60 seconds. <!-- AFFILIATE: vultr -->

## Further Reading

- `info gdb` — Full GDB manual inside GDB
- `man gdb` — Command reference
- **GDB Manual**: https://sourceware.org/gdb/current/onlinedocs/gdb/
- `gef` — GDB Enhanced Features: https://github.com/hugsy/gef — a fantastic GDB extension with better visualization
- `pwndbg` — Another GDB extension tuned for reverse engineering and exploit development
- **AMD64 Manual** (Volume 2) — For register and instruction reference when reading disassembly

## Further Reading

- [strace: Debugging Linux System Calls Like a Pro](/posts/strace-debugging-linux-system-calls) — Both GDB and strace are debugging essentials; strace shows syscall-level behavior while GDB shows instruction-level behavior
- [Linux /proc Filesystem Deep Dive](/posts/linux-proc-filesystem-deep-dive) — GDB inspects running processes via /proc/[pid]/; understanding /proc makes GDB's view of process memory more interpretable
- [Linux Memory Debugging](/posts/linux-memory-debugging-profiling) — Memory leaks and corruption manifest in both GDB coredumps and /proc memory analysis; both approaches are needed for complete diagnosis

GDB's learning curve is steep but the payoff is enormous. Once you're comfortable navigating coredumps, setting conditional breakpoints, and inspecting memory at the byte level, you're equipped to debug anything.

Want to practice? [Spin up a Linux VPS on Vultr](https://www.vultr.com/?ref=8914132) — deploy a server with `ulimit` set high and generate some coredumps to practice on. <!-- AFFILIATE: vultr -->

## Tools & Services

- **[Vultr](https://www.vultr.com/?ref=8914132)** — Cloud VPS for practicing coredump analysis on a live Linux server. $100 free credit for new accounts. <!-- AFFILIATE: vultr -->
- **[DigitalOcean](https://www.digitalocean.com/affiliates)** — Simple cloud hosting for development and debugging environments. $100 free credit. <!-- AFFILIATE: digitalocean -->
