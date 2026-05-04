---
title: "ClickHouse Architecture: How a Column-Oriented Database Processes Billions of Rows"
description: "A deep dive into ClickHouse's architecture—vectorized execution, MergeTree storage, and how it achieves sub-second queries on trillion-row datasets."
date: 2026-05-03
tags: ["clickhouse", "databases", "columnar", "olap", "performance", "distributed-systems", "analytics"]
draft: false
---

If you've ever waited minutes for a query on a large dataset, ClickHouse feels like magic. But it's not magic—it's architecture. This post dissects how ClickHouse processes billions of rows in under a second, and why the design decisions matter for your analytics workload.

## The Problem with Row-Oriented Databases

Traditional databases store data **row by row**. When you run `SELECT user_id, SUM(purchase_amount) WHERE date > '2026-01-01'`, the engine:

1. Reads every row in the table
2. Materializes all columns for each row
3. Filters out rows that don't match the date
4. Aggregates the results

This is fine for transactional workloads. It's brutal for analytics.

**Column-oriented storage** inverts this. Data is stored **column by column**:

| User ID | Purchase Amount | Date |
|---------|-----------------|------|
| Col-1 | Col-2 | Col-3 |

Now the query only reads three columns—not 50. That's 17× less I/O before we even optimize further.

## ClickHouse's Architecture Pillars

<ClickHouseArchitecture client:load />

### 1. Vectorized Query Execution

ClickHouse doesn't operate on individual rows. It processes **chunks of columns** (typically 1024–8192 rows at a time) using SIMD instructions.

```sql
-- This doesn't scan row-by-row
SELECT date, count() FROM events
WHERE event_type = 'purchase'
GROUP BY date;
```

The execution pipeline:

1. **Read** column chunks into CPU cache
2. **Filter** using vectorized comparison operations
3. **Aggregate** across the chunk in tight loops
4. **Combine** results from all chunks

The result: processing ~10GB/s per core on modern hardware. A single query saturates all available cores.

### 2. MergeTree: The Storage Engine

ClickHouse's default table engine, **MergeTree**, organizes data in layers:

```
Data Part (sorted by primary key)
├── granular_0.bin   (column data, compressed)
├── granular_0.mrk   (mark file for offset lookups)
├── ...
└── checksums.txt
```

**Granules** are the atomic unit of storage. Each granule holds ~8192 rows of data for a single column, stored contiguously. Instead of reading row 5,200 from a column file, you read granule 0, then skip to granule 2—that's one disk seek, not thousands.

**The Merge Process**: MergeTree doesn't just store data, it merges it. Small parts get combined into larger parts in the background:

```
Part_20260101_001_1A3F → Part_20260101_001_1A3F + Part_20260101_001_2B4D → Merged_Part_20260101_001_3C7A
   (8KB)                           (16KB)                                              (24KB)
```

This is why **deletes are soft** in ClickHouse—there's no in-place mutation. A "delete" marks a row in a `delete.bin` file; the actual removal happens during merge. This is a fundamental trade-off: writes are blazing fast, but queries pay a small price for recently deleted rows.

### 3. Primary Key vs Sorting Key

In ClickHouse, the **primary key** and **sorting key are the same thing** (unlike PostgreSQL). Data is physically ordered by the primary key within each part:

```sql
CREATE TABLE events (
    user_id   UInt64,
    event_type String,
    timestamp DateTime,
    payload   String
) ENGINE = MergeTree()
ORDER BY (user_id, timestamp);  -- This defines physical order
```

Queries that filter by `user_id` hit a **sparse index** that marks every 8192nd granule. So a query for `user_id = 42` reads only the parts and granules where `42` could exist—skipping everything else.

### 4. Distributed Architecture

A ClickHouse cluster is a collection of **shards**, each running a `clickhouse-server` instance:

```
┌─────────────────────────────────────────────┐
│           Distributed Query Node            │
│  (parses query, coordinates execution)       │
└──────────┬──────────────┬───────────────────┘
           │              │
    ┌──────▼──────┐ ┌─────▼──────┐
    │  Shard 1    │ │  Shard 2   │
    │  (3 replicas)│ │  (3 replicas)│
    └─────────────┘ └─────────────┘
         ↑              ↑
   Replica 1         Replica 1
   Replica 2         Replica 2
   Replica 3         Replica 3
```

**Replication** is asynchronous. ZooKeeper (or ClickHouse Keeper) coordinates the replication log:

1. Insert arrives at any replica
2. Replica writes to its local part and logs to ZooKeeper
3. Other replicas pull the log and fetch missing parts
4. Consistency is eventual; inserts are idempotent via ZooKeeper

**Sharding** splits data by a sharding key:

```sql
CREATE TABLE events_sharded ON CLUSTER my_cluster (
    ...
) ENGINE = MergeTree()
ORDER BY (user_id, timestamp)
PARTITION BY toYYYYMM(timestamp)
TTL timestamp + INTERVAL 3 MONTH;

-- Data is split by user_id modulo number of shards
-- Shard key defined in distributed table, not here
```

### 5. Materialized Views: Pre-Computation at Scale

Materialized views in ClickHouse are **real-time**—they update as new data arrives, not on a schedule:

```sql
CREATE MATERIALIZED VIEW hourly_sales
ENGINE = SummingMergeTree()
ORDER BY (hour, product_id)
AS SELECT
    toStartOfHour(timestamp) AS hour,
    product_id,
    sum(purchase_amount) AS total_sales
FROM events
WHERE event_type = 'purchase'
GROUP BY hour, product_id;
```

The `SummingMergeTree` engine automatically sums rows with the same key during background merges. You can query the materialized view instead of the raw table—orders of magnitude faster.

## Where ClickHouse Struggles

No architecture is perfect. ClickHouse's weaknesses:

| Scenario | Why It Struggles |
|----------|-----------------|
| High-frequency single-row inserts | No in-place writes; background merges can't keep up |
| Queries without primary key filters | Full scan of all parts |
| Point lookups (`WHERE id = ?`) | Sparse index still scans chunks |
| Updates/Deletes | Soft deletes only; heavy UPDATE = re-insert pattern |
| Multi-record transactions | No ACID transactions across shards |

## Sizing a ClickHouse Node

Rule of thumb for memory sizing:

```
RAM = (size of hot data parts) × 1.2
```

ClickHouse keeps merged parts in memory for query execution. If your hot dataset is 500GB, plan for ~600GB RAM.

**CPU scaling**: ClickHouse is highly parallelizable. A 32-core machine isn't 2× faster than a 16-core—it might be 1.8×. But across a cluster, linear scaling holds until you hit network bottlenecks.

## Quick Start

```bash
# Install (macOS via Homebrew)
brew install clickhouse

# Start server
clickhouse-server

# Connect
clickhouse-client

# Create table and insert
CREATE TABLE events (
    user_id   UInt64,
    event_type String,
    timestamp DateTime DEFAULT now()
) ENGINE = MergeTree()
ORDER BY (user_id, timestamp);

INSERT INTO events VALUES (1, 'click', now());
```

## When to Use ClickHouse

- **Log analytics**: 10M–10B+ events/day
- **Time-series data**: Metrics, IoT sensor data
- **Business intelligence**: Ad-hoc queries on wide tables
- **Session analysis**: User behavior across millions of sessions

Not for: OLTP workloads, frequent updates, small datasets (<1M rows), or when you need strong transactional guarantees.

---

ClickHouse's architecture is a deliberate set of trade-offs: fast writes and fast reads, at the cost of soft deletes and no ACID transactions. Understanding these trade-offs is what separates a ClickHouse novice from a ClickHouse expert.

Next: [TCP/IP Internals: How a Packet Travels Across the Network](/posts/tcp-ip-internals-packet-journey) →