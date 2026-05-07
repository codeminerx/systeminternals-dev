---
title: "Raft Consensus Algorithm: How Distributed Systems Agree on Reality"
description: "A deep dive into Raft's leader election, log replication, and safety guarantees—and why etcd, CockroachDB, and TiKV all rely on it for distributed consensus."
date: 2026-05-03
tags: ["distributed-systems", "consensus", "raft", "system-design", "availability", "fault-tolerance", "etcd", "replicated-log"]
structuredData:
  type: "Article"
  author: "systeminternals.dev"
  datePublished: "2026-05-03"
  dateModified: "2026-05-03"
draft: false
---

Every database that spans multiple machines faces the same fundamental problem: how do you get independent computers to agree on what's true? Not eventually, not probably—**agree**. This is the consensus problem, and Raft is one of the most widely deployed solutions to it.

If you've used Kubernetes, Docker Swarm, CockroachDB, TiKV, or etcd, you've benefited from Raft. Understanding it is essential for system design interviews and for building any distributed system that claims correctness.

## The Problem: Why Consensus Is Hard

Imagine two database servers, both believing they're the primary:

```
Server A: "I'm the primary, writes go to me"
Server B: "I'm the primary, writes go to me"
Client:   "Um... which one is actually right?"
```

This is **split-brain**—the most dangerous failure mode in distributed systems. Both servers accept writes independently, diverge, and by the time you realize the problem, you have two incompatible copies of data with no way to merge them.

The CAP theorem says you can't have consistency and availability during a network partition. But Raft doesn't try to defeat CAP—it tries to minimize partitions and recover fast when they happen. The goal: **safety** (never return wrong data) before **availability**.

### The FLP Impossibility Result

Before Raft, researchers proved that no consensus algorithm can guarantee both safety and liveness if nodes can fail and networks can partition. Every consensus algorithm makes a tradeoff:

- Raft chooses **safety over liveness** during partitions (reject writes rather than risk divergence)
- Paxos makes similar guarantees but is notoriously harder to implement correctly

## Raft's Core Abstraction: Replicated Log

Raft consensus works by maintaining a **replicated log**—a sequence of commands that all servers apply in the same order. If the log is identical across a majority of servers, the system is consistent.

```
Log entries: [cmd1, cmd2, cmd3, cmd4, ...]
             ↑ committed entries (majority agreement)
```

Each command in the log represents a state machine transition. Committed entries are durable—even if a minority of servers crash, the system continues.

## The Three Roles

Raft servers operate in one of three states:

| Role | Responsibility |
|------|----------------|
| **Leader** | Handles all client requests, replicates log entries to followers |
| **Follower** | Passive, responds to requests from leader and candidates |
| **Candidate** | Temporary state during leader election |

<DistributedConsensus client:load />

## Leader Election: Choosing Who Decides

Time in Raft is divided into **terms**—numbered epochs of some leader's reign:

```
Term 1          Term 2           Term 3
┌─────────────┐ ┌─────────────┐ ┌─────────────┐
│ Leader: A   │ │ Leader: B   │ │   No leader │
│ Followers:  │ │ Followers:  │ │  (election) │
│ B, C        │ │ A, C        │ │              │
└─────────────┘ └─────────────┘ └─────────────┘
```

Terms end when a leader crashes or network partition isolates the leader. A new election begins.

### How Elections Work

1. **Heartbeat timeout**: Followers expect periodic heartbeats from the leader. If no heartbeat arrives within the **election timeout** (typically 150–300ms, randomized), a follower assumes the leader is dead and becomes a candidate.

2. **Vote request**: The candidate increments the term number, votes for itself, and sends `RequestVote` RPCs to all other servers.

3. **Vote winning**: If a candidate receives votes from a **majority** of servers, it becomes the new leader.

4. **Vote losing**: If another leader's heartbeat arrives before the candidate wins, the candidate reverts to follower.

### Election Timeout Randomization

The randomization of election timeouts is critical to avoid **vote splitting** (multiple candidates splitting votes repeatedly):

```python
# Each server picks a random timeout in this range
ELECTION_TIMEOUT_MIN = 150  # ms
ELECTION_TIMEOUT_MAX = 300  # ms

timeout = random.randint(ELECTION_TIMEOUT_MIN, ELECTION_TIMEOUT_MAX)
# Server waits this long before starting election
```

This randomization means usually one server times out first, wins the election, and sends heartbeats before others start competing.

### Leader Availability

A Raft cluster remains available as long as a **majority** (quorum) is reachable:

| Cluster Size | Quorum | Failure Tolerance |
|---|---|---|
| 1 | 1 | 0 nodes |
| 3 | 2 | 1 node |
| 5 | 3 | 2 nodes |
| 7 | 4 | 3 nodes |

With 5 nodes, you can lose 2 and still serve writes. This is why production etcd clusters typically run 3 or 5 nodes.

## Log Replication: Making Writes Durable

When a client sends a command to a Raft leader:

```
Client → Leader: "SET x = 3"
         │
         ├─ Appends entry to local log
         │
         ├─ Sends AppendEntries RPC to followers
         │   (in parallel, for speed)
         │
         ├─ Waits for majority to acknowledge
         │
         ├─ Applies entry to state machine
         │
         └─ Responds to client: "Done"
```

### The AppendEntries RPC

The leader sends `AppendEntries` RPCs to followers to replicate log entries:

```json
{
  "term": 3,
  "leaderId": "A",
  "prevLogIndex": 4,
  "prevLogTerm": 2,
  "entries": [
    { "index": 5, "term": 3, "command": "SET x = 3" }
  ],
  "leaderCommit": 6
}
```

- `prevLogIndex/prevLogTerm`: The entry just before the new ones. Follower verifies it has this entry.
- `entries`: New commands to append
- `leaderCommit`: How many entries the leader has committed

If a follower crashes or is slow, the leader retries. Entries are always sent in order.

### Commit Index

The **commit index** is how Raft tracks which entries are safely replicated:

```
Log entries: [1, 2, 3, 4, 5, 6, 7]
                      ↑ commit index = 4
```

Only entries up to `commitIndex` can be applied to the state machine. The leader advances `commitIndex` when a majority acknowledges an entry.

### Why Committed Entries Are Safe

An entry is only committed when a **majority** of servers have written it. This means at least one server in any future quorum must have seen it. Even if the current leader crashes:

```
Leader A has log: [1, 2, 3, 4, 5]
Followers B, C have: [1, 2, 3]

Entry 3 is committed (majority: A, B, C all have it)
If A crashes, B or C can be elected.
The new leader must have entry 3 (because voters require it).
```

**Key property**: If entry E is committed and a server becomes leader, that server must have entry E in its log.

## Safety: Why Raft Never Returns Wrong Data

Raft's safety guarantee: **if an entry is committed, no future leader can have a different entry at that index.**

This is enforced through two rules:

### Rule 1: Leader Completeness

A candidate can only win an election if its log is **at least as up-to-date** as any other voter:

```rust
fn can_vote_for(candidate, voter_log, candidate_log):
    // Candidate's last entry must have higher term
    // OR same term but equal or longer log
    candidate_last = candidate_log.last()
    voter_last = voter_log.last()

    if candidate_last.term > voter_last.term:
        return true
    if candidate_last.term == voter_last.term:
        return candidate_last.index >= voter_last.index
    return false
```

This ensures the new leader has all committed entries.

### Rule 2: Log Matching

If two logs have an entry at the same index with the same term, all preceding entries must match. This is guaranteed by the `prevLogIndex/prevLogTerm` check in `AppendEntries`:

- If a follower's log doesn't match at `prevLogIndex`, the leader decrements `prevLogIndex` and retries
- Eventually, the logs converge

## Membership Changes: Adding Servers Without Downtime

Raft must handle adding/removing servers without stopping the cluster. The naive approach (config change in one step) risks split-brain if two quorums coexist.

Raft uses **joint consensus**: old and new configurations overlap during a transition.

```
Configuration transition:
[Old] → [Old+New joint] → [New]

Step 1: C_old (servers: A, B, C)
         │
         ▼ (joint config)
Step 2: C_old+new (servers: A, B, C, D, E)
         Any majority of either config can commit
         │
         ▼ (commit joint, then commit new)
Step 3: C_new (servers: D, E)
         Only majority of new config can commit
```

During the joint configuration, a partition can exist where neither side has a majority of **both** configs, preventing split-brain.

## Why etcd Uses Raft

etcd is the consistency backend for Kubernetes—all API server state lives in etcd. When you deploy a pod, the API server writes to etcd; Raft ensures all control plane nodes see the same state.

```bash
# Check etcd cluster health
kubectl exec -n kube-system etcd-<pod> -- etcdctl endpoint health

# View etcd Raft status
kubectl exec -n kube-system etcd-<pod> -- etcdctl raft status
```

Kubernetes requires **linearizability**—every read reflects all completed writes. Raft's consensus guarantees this across the etcd cluster.

## Performance Characteristics

Raft isn't theoretically optimal (Paxos can be more efficient in some scenarios), but it's practical:

| Metric | Typical Value |
|--------|--------------|
| Write latency (local) | < 1ms |
| Write latency (3-node cluster, leader on same DC) | 2–5ms |
| Read latency (direct from leader) | < 1ms |
| Recovery time after leader failure | 100–500ms (election + catch-up) |
| Log replication throughput | Limited by slowest follower (typically 50–100 MB/s on SSDs) |

Leader becomes the bottleneck for writes—all client traffic routes through it. For write-heavy workloads, consider sharding across multiple Raft groups (like CockroachDB does).

## Limitations

- **Leader is a bottleneck**: All writes go through the leader. For very high write throughput, use multiple Raft groups (sharding).
- **Latency on cross-DC writes**: Writes require a quorum, typically spanning a datacenter. Cross-DC latency is high (30–100ms RTT).
- **Jitter on elections**: Randomized timeouts work well but introduce variable recovery times.
- **Log compaction needed**: Without it, the log grows indefinitely. Raft uses snapshots (periodic state snapshots + log truncation) to bound storage.

## Comparison: Raft vs Paxos

| Aspect | Raft | Paxos |
|--------|------|-------|
| Understandability | Designed for clarity | Mathematically proven, harder to implement |
| Structure | Leader-based, more restrictive | Leaderless, more flexible |
| Implementations | etcd, CockroachDB, TiKV, Consul | Chubby (Google), Spanner |
| Election | Term-based | Ballot-based |
| Reconfiguration | Joint consensus | Single-step with careful handling |

Raft's restrictions (leader-based,AppendEntries) make it easier to implement correctly. The original Raft paper ("In Search of an Understandable Consensus Algorithm") explicitly aimed to be easier for practitioners to reason about.

## Practical Implementation: etcd's Raft Library

etcd's [raft package](https://github.com/etcd-io/etcd/tree/main/raft) is the reference implementation:

```go
// Simplified Raft usage in etcd
r := raft.StartNode(peers, nil)

// Propose a command (client write)
r.Propose(ctx, data)

// Read from state machine
sm.State()
// Read directly from leader (linearizable reads require quorum check)
r.ReadIndex(ctx)
```

Production considerations:
- **WAL (Write-Ahead Log)**: Every Raft write is persisted to disk before acknowledgment
- **Snapshots**: Periodic state snapshots + log truncation prevent unbounded disk usage
- **Flow control**: Limiting in-flight AppendEntries prevents overwhelming slow followers
- **Check quorum on reads**: Stale reads are cheap; linearizable reads require quorum confirmation

## Conclusion

Raft solves the consensus problem by combining three mechanisms:

1. **Leader election** via randomized timeouts and majority voting
2. **Log replication** via AppendEntries with consistency checks
3. **Safety** via vote restrictions that ensure the leader has all committed entries

The result is a system that remains consistent even through network partitions, node failures, and leader changes. Understanding these mechanisms matters whether you're designing a distributed database, preparing for system design interviews, or debugging a flaky Kubernetes cluster.

The key insight: consensus isn't about avoiding failure—it's about defining behavior **when** failure happens. Raft gives you formal guarantees about what happens next, which is the foundation everything else rests on.

---

**External Resources**

- [Raft Paper (Ongaro & Ousterhout)](https://raft.github.io/raft.pdf) — The original paper, surprisingly readable
- [The Secret Lives of Data](http://thesecretlivesofdata.com/raft/) — Beautiful interactive visualization of Raft
- [etcd Raft implementation](https://github.com/etcd-io/etcd/tree/main/raft) — Production-grade reference
- [RaftScope](https://github.com/elasticsky/raft-scope) — Visual Raft state machine explorer
- [CONSENSUS: Bridging Theory and Practice](https://web.stanford.edu/~ouster/cgi-bin/papers/OngaroO14.pdf) — Extended treatment by Ongaro

Implementing Raft consensus? [DigitalOcean](https://www.digitalocean.com/affiliates)'s VPC networking makes cluster testing reliable. <!-- AFFILIATE: digitalocean -->

## Further Reading

- [Paxos Consensus Algorithm Deep Dive](/posts/paxos-consensus-algorithm-deep-dive) — Paxos and Raft solve the same problem with different approaches; comparing them deepens understanding of both
- [Kubernetes Architecture Deep Dive](/posts/kubernetes-architecture-deep-dive) — Kubernetes uses etcd, which uses Raft; the control plane is the production deployment of the theory in this post
- [URL Shortener System Design](/posts/url-shortener-system-design) — Distributed systems that need consistency (even without consensus) share design patterns with Raft-based systems

Building a Raft-based system? [DigitalOcean's compute instances](https://www.digitalocean.com/affiliates) are ideal for spinning up test clusters — $100 free credit for new accounts. <!-- AFFILIATE: digitalocean -->

## Tools & Services

- **[Vultr](https://www.vultr.com/?ref=8914132)** — Cloud VPS for building Raft-based distributed systems. $100 free credit for new accounts. <!-- AFFILIATE: vultr -->
- **[DigitalOcean](https://www.digitalocean.com/affiliates)** — Compute instances for multi-node Raft cluster testing. $100 free credit. <!-- AFFILIATE: digitalocean -->
