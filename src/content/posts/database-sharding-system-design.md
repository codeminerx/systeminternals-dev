---
title: "Database Sharding System Design: How to Scale Beyond a Single Database"
description: "A deep dive into database sharding—shard keys, consistent hashing, cross-shard queries, resharding, and the production patterns used by Instagram, YouTube, and Shopify to handle billions of rows."
date: 2026-05-07
tags: ["system-design", "distributed-systems", "databases", "sharding", "scalability", "mysql", "postgresql", "mongodb", "clickhouse", "consistent-hashing", "interviews"]
structuredData:
  type: "Article"
  author: "systeminternals.dev"
  datePublished: "2026-05-07"
  dateModified: "2026-05-07"
draft: false
---

Every large-scale system eventually hits the same wall: one database can't handle the load. Your users table grows from millions to billions of rows. Your read latency creeps up. Backups take hours. Replication lag spreads. At some point, vertical scaling (bigger server) stops helping—and the only path forward is horizontal scaling: **sharding**.

This post covers everything about database sharding: when to shard, how to pick a shard key, how consistent hashing solves the redistribution problem, cross-shard query patterns, hot spots, and the nightmare that is resharding in production.

<DatabaseShardingVisualizer client:load />

## The Problem: Why Single Databases Hit Limits

A single PostgreSQL or MySQL instance handles roughly:

| Metric | Single DB Limit |
|--------|-----------------|
| Storage | 2-4 TB (practical) |
| Writes/sec | 10,000-50,000 |
| Reads/sec | 50,000-100,000 |
| Connections | 1,000-5,000 |
| Replication lag | 1ms - 100ms |

Once you exceed these, you have three options:

1. **Vertical scaling** — bigger machine (expensive, finite)
2. **Read replicas** — scale reads only, writes still bottleneck
3. **Sharding** — distribute data across multiple database instances

Sharding is the only path that scales *writes* horizontally. It also scales storage linearly: 10 shards × 2TB each = 20TB total.

## Sharding vs Partitioning: Not the Same Thing

**Partitioning** splits a table's data *within a single database instance*:
- PostgreSQL: `PARTITION BY RANGE (created_at)`
- MySQL: `PARTITION BY LIST`
- Oracle: `PARTITION BY HASH`

Partitions live on the same server. Sharding splits data across *different servers* (nodes). The key distinction: sharding requires the application layer to know which shard to query.

## Shard Key Selection: The Most Important Decision

The **shard key** is the column (or expression) that determines which shard owns a row. Pick wrong, and you create hot spots. Pick right, and queries are fast and balanced.

### Hash-Based Sharding

```python
def shard_id(user_id: int, num_shards: int) -> int:
    return user_id % num_shards

# 4 shards: user_id=100 → shard 0 (100 % 4 = 0)
# 4 shards: user_id=101 → shard 1 (101 % 4 = 1)
```

**Pros**: Evenly distributes data, simple to implement
**Cons**: Range queries scatter across shards (no locality), adding shards requires full data migration

```sql
-- Application routes to shard based on hash
SELECT * FROM orders WHERE user_id = 10085;
-- App computes: 10085 % 4 = 1 → queries shard_1 only
```

### Range-Based Sharding

```python
def shard_id(user_id: int) -> str:
    if user_id < 1_000_000: return "shard_0"
    if user_id < 2_000_000: return "shard_1"
    return "shard_2"
```

**Pros**: Range queries are local (users 1-1M are on the same shard), easy to understand
**Cons**: Hot spots if new users cluster in one range (e.g., always growing at the "latest" shard)

```sql
-- All recent orders for shard_0 users → local JOIN
SELECT * FROM orders WHERE user_id BETWEEN 1 AND 1000000;
```

### Geographic Sharding

```python
def shard_id(region: str) -> str:
    return f"shard_{region}"  # us-east, eu-west, asia-pacific
```

Used when data sovereignty matters (GDPR) or you want low-latency reads for regional users.

## Consistent Hashing: Solving the Resharding Problem

The problem with `hash(key) % N`: when you add a shard, every key remaps. That means migrating terabytes of data.

**Consistent hashing** minimizes remapping on scale events:

```
                         ┌─────────┐
                    ┌───►│ Shard 0│ (responsible for 0-90°)
                    │    └─────────┘
                    │
Hash Ring ──────────┼───►│ Shard 1│ (responsible for 90-210°)
(0-360°)            │    └─────────┘
                    │
                    └───►│ Shard 2│ (responsible for 210-360°)

Adding Shard 3 only remaps 1/4 of keys (90° arc) instead of all keys
```

### Virtual Nodes: Solving Uneven Distribution

With 3 physical shards, each covers 120°. But data isn't perfectly uniform. **Virtual nodes** assign each physical shard multiple positions on the ring:

```python
# 3 physical shards × 150 virtual nodes each = 450 positions
def virtual_node(key: str, shard_id: int, vnode_id: int) -> float:
    hash_val = hash(f"{key}:shard_{shard_id}:vnode_{vnode_id}")
    return hash_val / (2**64)  # 0.0 to 1.0
```

This smooths load distribution to within 5-10% even with small shard counts.

## Query Routing: How the App Finds the Right Shard

The application layer must route queries. There are three approaches:

### 1. Application-Layer Routing

Your app code knows the shard map and routes directly:

```python
class ShardRouter:
    def __init__(self, shards: list[str]):
        self.shards = shards
        self.ring = ConsistentHashRing(shards, vnodes=150)

    def get_shard(self, key: int) -> str:
        return self.ring.get_node(key)

    def query_user(self, user_id: int) -> User:
        shard = self.get_shard(user_id)
        return self.shard_connections[shard].query(
            "SELECT * FROM users WHERE id = %s", user_id
        )

# Usage: router.query_user(10085)
# Routes to: shard_1 (hash ring lookup)
```

**Pros**: No proxy overhead, full control
**Cons**: Shard topology is baked into app code, complex migrations

### 2. Proxy Layer (MySQL Proxy, ProxySQL, Vitess)

A proxy sits between app and shards, routing SQL:

```
App → ProxySQL → Shard_0 (range: users 1-2M)
App → ProxySQL → Shard_1 (range: users 2M-4M)
App → ProxySQL → Shard_2 (range: users 4M-6M)
```

The app sends vanilla SQL to the proxy. The proxy parses it, extracts the shard key, and routes accordingly.

**Pros**: App stays database-agnostic, centralized routing logic
**Cons**: Extra hop (proxy can be single point of contention), latency overhead

### 3. Co-Located Data (Denormalization)

Instead of JOINs across shards, **denormalize** and keep related data on the same shard:

```sql
-- Instead of separate users and orders tables (cross-shard JOIN):
-- Denormalize: embed order_summary in users shard

CREATE TABLE user_orders (
    user_id INT,           -- shard key (co-located with users)
    order_id INT,
    total_cents BIGINT,
    created_at TIMESTAMP,
    PRIMARY KEY (user_id, order_id)  -- composite key, both on same shard
);

-- Now reads are local: no cross-shard JOIN needed
SELECT * FROM user_orders WHERE user_id = 10085;
```

This is the approach Instagram used for their early sharding. It trades write complexity for read efficiency.

## Cross-Shard Operations: The Hard Parts

### Cross-Shard JOINs

The classic JOIN problem: `SELECT * FROM orders JOIN users ON orders.user_id = users.id WHERE users.region = 'EU'`

If orders and users are sharded differently (orders by `user_id`, users by `region`), this query touches every shard:

```python
# Scatter-gather: query all shards, merge results
def cross_shard_query(region: str) -> list[Order]:
    futures = []
    for shard in all_shards:
        futures.append(
            asyncio.to_thread(shard.query,
                "SELECT o.* FROM orders o JOIN users u ON o.user_id = u.id "
                "WHERE u.region = %s AND u.shard_id = %s", region, shard.id
            )
        )
    results = await asyncio.gather(*futures)
    return sorted(
        merge_results(*results),
        key=lambda r: r.created_at, reverse=True
    )
```

**Rule of thumb**: Keep tables that JOIN frequently on the same shard key.

### Distributed Transactions

Sharding breaks ACID transactions that span shards. Solutions:

**1. Two-Phase Commit (2PC)**:
```python
async def transfer_funds(from_id: int, to_id: int, amount: int):
    # Phase 1: Prepare (get locks on both shards)
    shard_from = router.get_shard(from_id)
    shard_to = router.get_shard(to_id)

    coordinator.begin()
    coordinator.prepare(shard_from, "UPDATE accounts SET balance -= %s", amount)
    coordinator.prepare(shard_to, "UPDATE accounts SET balance += %s", amount)

    # Phase 2: Commit (if all prepared)
    try:
        coordinator.commit()
    except:
        coordinator.rollback()  # All-or-nothing
        raise
```

**2. Saga Pattern** (eventual consistency):
```python
async def transfer_funds_saga(from_id: int, to_id: int, amount: int):
    # Compensating transactions instead of ACID
    try:
        await debit_account(from_id, amount)          # Step 1
        await credit_account(to_id, amount)            # Step 2
        await record_transfer(from_id, to_id, amount)  # Step 3
    except CreditFailed:
        await credit_back_account(from_id, amount)    # Compensate step 1
        raise
```

**3. Outbox Pattern** (for write-heavy workloads):
```sql
-- Write to local outbox table first (transactional)
INSERT INTO transfers_outbox (from_id, to_id, amount, status)
VALUES (1, 2, 100, 'pending');

-- Background relay reads outbox and applies to other shard
-- Relay is idempotent: can run multiple times safely
```

## Hot Spots: When One Shard Gets Clobbered

Hot spots happen when your shard key creates uneven distribution:

| Hot Spot Cause | Example | Solution |
|----------------|---------|----------|
| Time-based keys | All writes hit current shard | Add random suffix, use hash key |
| Celebrity accounts | Influencer with 10M followers | Reverse denormalization, read replicas |
| Viral content | Trending post gets 1M reads/sec | Read replicas, edge caching |
| Monotonic keys | Always-growing ID ranges | Hash-based sharding instead of range |

### Reverse Index Table: Fixing the Celebrity Problem

For the "user with 10M followers" problem:

```python
# Instead of sharding followers by user_id (celebrity on one shard):
# Create a reverse index: shard by follower_id

CREATE TABLE follower_reverse (
    follower_id BIGINT,      -- shard key: the person following
    following_id BIGINT,     -- who they're following
    created_at TIMESTAMP,
    PRIMARY KEY (follower_id, following_id)
);

-- Reading "who follows user 12345?" → scatter-gather across all shards
-- Reading "who does user 999 follow?" → single shard (follower_id = 999)
```

## Resharding: The Nightmare

The hardest part of sharding isn't getting there—it's *changing* the shard count later.

### Why It's Hard

```
Old: hash(user_id) % 4 shards = 0, 1, 2, 3
New: hash(user_id) % 8 shards = 0-7

hash(user_id=5) % 4 = 1 → currently on shard_1
hash(user_id=5) % 8 = 5 → should be on shard_5

Every. Single. Key. Remaps.
```

### Strategy: Online Resharding with Dual-Write

```python
# Phase 1: Backfill new shard from source of truth
async def backfill_shard(shard_from: int, shard_to: int, batch_size=1000):
    cursor = None
    while True:
        rows = db.query(
            "SELECT * FROM users WHERE id > %s ORDER BY id LIMIT %s",
            cursor, batch_size
        )
        if not rows:
            break

        # Write to new shard
        for row in rows:
            new_shard.insert(row)

        cursor = rows[-1].id
        await asyncio.sleep(0.1)  # Rate limit to avoid impacting production

# Phase 2: Dual-write during migration window
async def dual_write(user):
    await old_shard.insert(user)   # Keep old shard writable
    await new_shard.insert(user)   # Write to new shard too

# Phase 3: Cutover when backfill is complete
# Switch reads to new shard, keep old shard as backup
# Phase 4: Decommission old shard
```

Tools like **Vitess** (YouTube's MySQL sharding layer) and **Citus** (PostgreSQL extension) automate this with built-in resharding.

## Sharding in ClickHouse: Distributed Tables

ClickHouse is unique—it *is* a distributed database by default. Sharding is built in:

```sql
-- Create a distributed table that spans 3 shards
CREATE TABLE events_distributed
ENGINE = Distributed('cluster_name', 'default', 'events_local', rand())
AS SELECT * FROM events_local;

-- Shard key on the local table
CREATE TABLE events_local (
    event_id UUID,
    user_id  UInt64,
    event_type String,
    created_at DateTime
)
ENGINE = MergeTree()
ORDER BY (user_id, event_type);  -- Sort key: co-locates related events
```

ClickHouse's **local tables** are the shards. The **Distributed** engine acts as both router and aggregator—scattering queries and gathering results.

```sql
-- ClickHouse scatter-gather aggregation (parallel on all shards)
SELECT user_id, count() as event_count
FROM events_distributed
WHERE event_type = 'purchase'
GROUP BY user_id
ORDER BY event_count DESC
LIMIT 10;

-- Each shard computes its top-10 locally
-- Coordinator merges and returns global top-10
```

## Implementation Strategies by Database

| Database | Sharding Approach |
|----------|-----------------|
| **MySQL** | Vitess (YouTube), ProxySQL, or app-layer hash |
| **PostgreSQL** | Citus extension, or app-layer sharding |
| **MongoDB** | Native sharding via `shardCollection()` |
| **ClickHouse** | Native distributed tables + MergeTree |
| **CockroachDB** | Automatic range-based sharding (like Spanner) |
| **TiDB** | TiKV based, automatic sharding |

### MongoDB Sharding Setup

```javascript
// Add shards to cluster
sh.addShard("shard_0/localhost:27017");
sh.addShard("shard_1/localhost:27018");
sh.addShard("shard_2/localhost:27019");

// Enable sharding on database
sh.enableSharding("myapp");

// Shard collection by user_id (hashed for even distribution)
sh.shardCollection("myapp.orders", { "user_id": "hashed" });

// Or by range (for time-series)
sh.shardCollection("myapp.events", { "created_at": 1 });
```

## Production Patterns from Instagram, YouTube, Shopify

**Instagram** (sharded by `user_id`):
- All data for a user lives on the same shard (denormalization)
- `user_id` = `shard_id << 32 | photo_id` (co-locates related content)
- Cross-shard queries are batched + async

**YouTube** (Vitess):
- Vitess proxy handles all sharding transparently
- Added shards without rewriting a single app query
- Supports both hash and range sharding

**Shopify** (sharded by `shop_id`):
- Each Shopify store is a "shop" with its own `shop_id`
- All store data (products, orders, customers) co-located by `shop_id`
- Resharding done via dual-write migration with automated cutover

## When NOT to Shard

Sharding adds immense complexity. Before sharding:

- [ ] Can I use read replicas to scale reads?
- [ ] Can I add caching (Redis) to reduce DB load?
- [ ] Can I upgrade to a bigger machine (r6i.8xlarge = 256GB RAM)?
- [ ] Can I optimize slow queries (missing indexes, N+1)?
- [ ] Can I archive old data to reduce table size?

Sharding should be your *last* resort, not your first. Most "scale problems" are actually "index problems" or "cache problems" in disguise.

## Summary

| Decision | Recommendation |
|----------|---------------|
| Shard key | Hash-based if unsure; range if you do heavy sequential reads |
| Number of shards | Start with 4-8; add shards proactively before you hit 80% disk |
| Hot spots | Mitigate with read replicas + caching before resharding |
| Cross-shard JOINs | Denormalize to keep related data co-located |
| Resharding | Use consistent hashing from day one; avoid modulo-based routing |
| Tooling | Vitess (MySQL), Citus (PostgreSQL), MongoDB native sharding |

Sharding is a one-way door. Design your shard key carefully, leave room for growth in your initial shard count, and make sure your application can tolerate the eventual consistency that sharding introduces.
