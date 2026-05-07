---
title: "Paxos Consensus Algorithm: How Distributed Systems Reach Agreement"
description: "A deep dive into the Paxos consensus algorithm—prepare phases, accept phases, multi-Paxos, and why Google Spanner, CockroachDB, and Neo4j use it for distributed agreement."
date: 2026-05-04
tags: ["distributed-systems", "consensus", "paxos", "system-design", "fault-tolerance", "lamport", "availability", "multi-paxos"]
structuredData:
  type: "Article"
  author: "systeminternals.dev"
  datePublished: "2026-05-04"
  dateModified: "2026-05-04"
draft: false
---

In 1998, Leslie Lamport published a paper describing a consensus algorithm he called Paxos—named after a fictional parliament on a Greek island that reached decisions despite members constantly coming and going. The algorithm became legendary: conceptually elegant, notoriously difficult to implement, and deployed in some of the most critical distributed systems ever built.

If Raft is the algorithm you learn for interviews, Paxos is the algorithm you encounter in production. Google Spanner uses it. CockroachDB uses it. Neo4j uses it. Understanding Paxos means understanding why most distributed consensus ultimately traces back to this one paper.

## The Problem Paxos Solves

Like Raft, Paxos solves the problem of getting distributed servers to agree on a single value—even when servers crash, networks partition, and messages get lost.

Unlike Raft, Paxos doesn't distinguish between leader election, log replication, and safety as separate concerns. Paxos has one job: **agree on a single value**. Everything else is built on top.

### The Simple Scenario

Imagine three servers trying to agree on which server should be the primary:

```
Server A: "I propose value Primary=A"
Server B: "I propose value Primary=B"
Server C: "I propose value Primary=C"

How do they reach agreement?
```

Paxos answers this with a two-phase protocol that guarantees safety regardless of failures.

## Paxos Roles: Proposers, Acceptors, and Learners

Paxos has three roles:

| Role | Job |
|------|-----|
| **Proposer** | Sends proposal values to acceptors |
| **Acceptor** | Receives proposals and votes on them |
| **Learner** | Learns the chosen value once consensus is reached |

In practice, every server plays all three roles. The distinction matters only for understanding the protocol.

## The Two Phases of Basic Paxos

<PaxosConsensus client:load />

### Phase 1: Prepare (Proposer → Acceptors)

The proposer picks a **proposal number** (called `N`) and sends a `Prepare(N)` message to a majority of acceptors:

```
Proposer: "I'm thinking about proposing a value. Promise not to accept
           any proposals numbered lower than N."
```

Each acceptor responds if `N` is higher than any proposal number it's already seen:

```
Acceptor: "OK. I promise. I haven't seen a higher proposal number.
           Oh, and I may have already accepted value V with proposal
           number M—here's that info in case you want to use it."
```

If a majority of acceptors promise, Phase 1 succeeds.

### Phase 2: Accept (Proposer → Acceptors)

Now the proposer sends an `Accept(N, V)` message:

```
Proposer: "I propose value V with proposal number N."
```

Rules for choosing `V`:
- If any acceptor already accepted a value, use the one from the **highest-numbered proposal**
- Otherwise, use the proposer's own value

Each acceptor accepts the value if `N` matches the promise it made:

```
Acceptor: "I accept proposal N with value V."
```

If a majority of acceptors accept, the value is **chosen**.

## Why Paxos Guarantees Safety

The clever part: even with concurrent proposers and message delays, Paxos never allows two different values to be chosen.

Here's why. For two values to be chosen, a majority of acceptors must accept each:

```
Value V1 chosen → majority of acceptors accepted V1
Value V2 chosen → majority of acceptors accepted V2

These majorities must overlap!
At least one acceptor accepted BOTH V1 and V2.
```

But an acceptor can only accept a higher-numbered proposal after seeing it. And that higher-numbered proposal's proposer must have contacted that acceptor in Phase 1. Therefore, V2's proposer would have seen V1's proposal and been forced to propose V1 instead (because Paxos requires using the already-accepted value from the highest proposal number).

This creates a chain of obligations that makes divergence impossible.

## The Prepare/Promise Exchange in Detail

```
Proposer (value = "Primary=A", N = 1)
    │
    ├──Prepare(1)──→ Acceptor 1 ──→ Promise(1, none) ✓
    ├──Prepare(1)──→ Acceptor 2 ──→ Promise(1, none) ✓
    └──Prepare(1)──→ Acceptor 3 ──→ Promise(1, none) ✓
                          │
              Majority reached → proceed to Accept

Proposer → Accept(1, "Primary=A") → Acceptor 1,2,3
    │
    ├──Accept(1, A)──→ Acceptor 1 ──→ Accepted(1, A) ✓
    ├──Accept(1, A)──→ Acceptor 2 ──→ Accepted(1, A) ✓
    └──Accept(1, A)──→ Acceptor 3 ──→ Accepted(1, A) ✓
                          │
              Majority reached → "Primary=A" is CHOSEN
```

## Handling Failures and Retries

Paxos is designed to survive arbitrary failures:

**Proposer crashes mid-proposal:**
- A new proposer picks a higher `N` and restarts Phase 1
- Acceptors remember the highest `N` they've promised
- No value is chosen until a majority agrees

**Acceptor doesn't respond:**
- Proposer times out and retries with higher `N`
- The protocol is idempotent—retrying is safe

**Network partition:**
- No majority can be formed → no value chosen → system waits
- This is the CAP tradeoff: Paxos chooses consistency over availability during partitions

```
Network Partition:
┌─────────────────────┐     ✂      ┌─────────────────────┐
│  Proposer ──→ Majority │   PARTITION   │  Proposer ──→ Minority │
│  (Phase 2 succeeds)     │              │  (Phase 2 fails)       │
└─────────────────────┘              └─────────────────────┘
        ↓ chosen                              ↓ waiting
   Value V is chosen                    No value chosen
```

## Multi-Paxos: Consensus for a Sequence of Values

Basic Paxos agrees on ONE value. Multi-Paxos extends this to agree on a **sequence of values**—making it practical for replicated state machines.

The trick: use the same proposal number `N` for multiple values, but increment an **instance number** within each slot:

```
Instance 1: Basic Paxos → value V1 chosen
Instance 2: Basic Paxos → value V2 chosen
Instance 3: Basic Paxos → value V3 chosen
...
```

In practice, once a leader is established through the first round of Paxos, subsequent instances skip Phase 1 (because everyone knows the leader's proposals will be the highest). This is how Google Spanner achieves thousands of writes per second across globally distributed nodes.

### Spanner's Use of Paxos

Google Spanner uses Multi-Paxos to replicate data across datacenters:

```
Datacenter A ──Paxos Leader──→ replicates to ──→ Datacenter B
                                                     ↓
                                              Datacenter C

Writes: go through leader, committed via Paxos majority
Reads: can be served locally from any replica (with timestamp)
```

Spanner adds **TrueTime** (atomic clocks with bounded uncertainty) to assign globally consistent timestamps without synchronous clocks.

## Paxos vs Raft: What's the Difference?

| Property | Paxos | Raft |
|----------|-------|------|
| **Leader election** | Not specified (any proposer can run) | Explicit heartbeat mechanism |
| **Log replication** | Multi-Paxos builds a log | Single leader + AppendEntries |
| **Understandability** | Academic, harder to follow | Designed to be readable |
| **Production use** | Google Spanner, CockroachDB | etcd, TiKV, CockroachDB |
| **Membership changes** | Complex | Joint consensus + overlapping majorities |
| **Client interaction** | Any client → any server | Client → leader only |

The key practical difference: **Raft is leader-based, Paxos is not**. Raft forces a single leader to coordinate writes, which makes the protocol easier to reason about but introduces a leader as a bottleneck. Paxos allows any server to propose, which is more fair but more complex to implement.

### Why Two Algorithms for the Same Problem?

Raft was designed in 2014 by Diego Ongaro and John Ousterhout specifically to be **easier to understand** than Paxos. The paper is literally called "In Search of an Understandable Consensus Algorithm."

But Paxos has a 16-year head start in production systems, and the underlying insight—that you need a majority to guarantee safety—is the same in both algorithms.

## Chubby: Paxos in Production at Google

Before Spanner, Google built **Chubby**—a distributed lock service used internally by Bigtable, MapReduce, and other infrastructure. Chubby uses Paxos for lock consensus:

```
Chubby Cell:
┌──────────────────────────────────────────┐
│  5 replicas (Paxos acceptors)            │
│  1 master elected via Paxos               │
│  All writes go through master             │
│  Reads can be served by any replica       │
└──────────────────────────────────────────┘

Use cases:
- Locking Bigtable tablets during compaction
- Master election for MapReduce workers
- Namespace metadata for GFS
```

Chubby inspired etcd, which inspired Kubernetes. So when you deploy a pod in Kubernetes, Paxos is quietly running in the etcd cluster underneath.

## Implementing Paxos: A Minimal Python Example

```python
import asyncio
from collections import defaultdict

class Acceptor:
    def __init__(self):
        self.promised_n = 0
        self.accepted_n = 0
        self.accepted_v = None

    async def receive_prepare(self, n: int) -> dict:
        if n > self.promised_n:
            self.promised_n = n
            return {
                "ok": True,
                "accepted_n": self.accepted_n,
                "accepted_v": self.accepted_v
            }
        return {"ok": False}

    async def receive_accept(self, n: int, v) -> dict:
        if n >= self.promised_n:
            self.promised_n = n
            self.accepted_n = n
            self.accepted_v = v
            return {"ok": True}
        return {"ok": False}

# Proposer logic
async def propose(acceptors: list[Acceptor], v, n: int) -> tuple[bool, any]:
    # Phase 1: Prepare
    promises = []
    for a in acceptors:
        resp = await a.receive_prepare(n)
        if resp["ok"]:
            promises.append(resp)

    if len(promises) < len(acceptors) // 2 + 1:
        return False, None  # No majority

    # Choose highest-numbered value or our own
    highest = max(p["accepted_n"] for p in promises if p["accepted_v"] is not None)
    if highest:
        v = next(p["accepted_v"] for p in promises if p["accepted_n"] == highest)

    # Phase 2: Accept
    accepts = 0
    for a in acceptors:
        resp = await a.receive_accept(n, v)
        if resp["ok"]:
            accepts += 1

    return accepts >= len(acceptors) // 2 + 1, v
```

## Limitations of Paxos

Paxos is not perfect:

**1. Uniqueness via proposal numbers, not IDs**
Two proposers can collude with different proposal numbers. The lower one gets ignored. This is correct but means proposals can be starved.

**2. Multi-Paxos requires careful implementation**
The theoretical paper doesn't specify leader election or log management. Every production implementation (Chubby, Spanner, CockroachDB) has its own approach.

**3. Performance is leader-dependent in practice**
While any server can propose, real Multi-Paxos systems optimize by electing a stable leader. This reintroduces Raft-like behavior.

**4. Byzantine failure not handled**
Classic Paxos assumes crash failures only. For Byzantine (arbitrary/malicious) failures, you need PBFT (Practical Byzantine Fault Tolerance).

## When to Use Paxos

Use Paxos (or a Paxos-based system) when:
- You need strong consistency across geo-distributed nodes
- You're building a replicated log, distributed lock service, or metadata store
- You're ok using an established library rather than writing your own

Use a Paxos-based system (etcd, CockroachDB, Spanner) rather than implementing Paxos yourself. The protocol is subtle and the implementation is brutal.

---

## Related

Building a Paxos implementation? [DigitalOcean's networking features](https://www.digitalocean.com/affiliates) make multi-node cluster testing straightforward. <!-- AFFILIATE: digitalocean -->

Paxos and Raft solve the same problem differently. See also:
- [Raft Consensus Algorithm Deep Dive](/posts/raft-consensus-algorithm-deep-dive) — the leader-based alternative
- [Rate Limiter System Design](/posts/rate-limiter-system-design) — distributed consistency in practice
- [ClickHouse Architecture](/posts/clickhouse-architecture-deep-dive) — how analytical databases use distributed consensus

Building a distributed system that needs consensus? [DigitalOcean's networking features](https://www.digitalocean.com/affiliates) make it easy to spin up multi-node clusters for testing. <!-- AFFILIATE: digitalocean -->

## Tools & Services

- **[Vultr](https://www.vultr.com/?ref=8914132)** — Cloud VPS for building and testing distributed consensus implementations. $100 free credit for new accounts. <!-- AFFILIATE: vultr -->
- **[DigitalOcean](https://www.digitalocean.com/affiliates)** — Compute instances for multi-node cluster testing. $100 free credit. <!-- AFFILIATE: digitalocean -->
