---
title: "ClickHouse Query Optimization: From Slow Queries to Sub-Second Response Times"
description: "A practical guide to optimizing ClickHouse queries — reading EXPLAIN plans, understanding data skip indexes, materialized views, and projection strategies for trillion-row datasets."
date: 2026-05-09
tags: ["clickhouse", "databases", "performance", "olap", "query-optimization", "analytics"]
structuredData:
  type: "Article"
  author: "systeminternals.dev"
  datePublished: "2026-05-09"
  dateModified: "2026-05-09"
draft: false
---

You wrote the query. It runs. And runs. And runs. ClickHouse is built for speed, but a naive query can still crawl through a trillion rows. The difference between a 50ms query and a 50-second query is understanding how ClickHouse actually executes your request.

This guide covers the techniques that turn slow analytical queries into sub-second responses on datasets that would bring a traditional RDBMS to its knees.

## Start With EXPLAIN

Never guess. Read the plan. ClickHouse's `EXPLAIN` syntax has three modes:

```sql
EXPLAIN [AST | SYNTAX | PLAN | PIPELINE] <your query>
```

### PLAN mode — the default

```sql
EXPLAIN PLAN SELECT user_id, count() FROM events
WHERE event_type = 'purchase'
  AND date >= '2026-01-01'
GROUP BY user_id;
```

Look for these signals in the output:

| Signal | What It Means | Fix |
|--------|---------------|-----|
| `ReadFromMergeTree` | Full table scan | Add WHERE on sorting key |
| `AggregatingTransform` | Aggregation late in pipeline | Push aggregation earlier |
| `SortingTransform` | Post-aggregation sort | Pre-sort by GROUP BY key |
| `ParallelParsingTransform` | Data parsed in parallel | Good — not a problem |

### PIPELINE mode — for parallelism analysis

```sql
EXPLAIN PIPELINE SELECT count() FROM events;
```

This shows how many threads will process the query and where bottlenecks occur.

### AST mode — for syntax validation

Useful when you suspect the query planner is misinterpreting your intent.

## The PRIMARY KEY is Your First Optimization

ClickHouse stores data sorted by the **primary key** (the first column(s) in the `ORDER BY` clause of your MergeTree table). This determines:

1. **What can be skipped** — ClickHouse reads granule chunks (8192 rows). If your WHERE clause filters on the primary key, ClickHouse skips entire granules that don't match.
2. **Where data is colocated** — Rows with the same primary key value live on the same shard.

### Granule Skipping Demo

```sql
-- Table sorted by (user_id, date)
CREATE TABLE events (
    user_id UInt32,
    date Date,
    event_type String,
    payload String
) ENGINE = MergeTree()
ORDER BY (user_id, date)
SETTINGS index_granularity = 8192;
```

With 10M rows across 1220 granules, a query filtering on `user_id = 42` reads only the granules containing that user:

```sql
EXPLAIN indexes=1 SELECT * FROM events WHERE user_id = 42;
-- Output shows: marks_to_drop = 1219, marks_to_use = 1
-- Only 1/1220 granules read = 99.9% data skipped
```

**Choose your ORDER BY based on your most frequent filter patterns.** If you filter by `tenant_id` 80% of the time and `date` 20%, put `tenant_id` first.

### How PRIMARY KEY Affects GROUP BY Performance

```sql
-- Good: primary key matches GROUP BY
-- Table: ORDER BY (tenant_id, date)
SELECT tenant_id, count() FROM events
WHERE tenant_id = 100
GROUP BY tenant_id;
-- Reads only one granule set, no final merge needed

-- Bad: GROUP BY on non-primary-key column
-- Table: ORDER BY (tenant_id, date)
SELECT event_type, count() FROM events
GROUP BY event_type;
-- Must scan all granules, aggregate across all threads, then merge
```

## ClickHouse Data Skip Indexes

Beyond the primary key, ClickHouse has secondary **data skip indexes** that work at the granule level.

```sql
ALTER TABLE events ADD INDEX idx_type event_type TYPE bloom_filter GRANULARITY 3;
ALTER TABLE events ADD INDEX idx_date date TYPE minmax GRANULARITY 4;
```

### Index Types

| Index Type | Best For | Granularity |
|------------|----------|-------------|
| `bloom_filter` | High-cardinality strings (user IDs, UUIDs) | 3 granules checked before reading |
| `minmax` | Range predicates on numeric/date columns | Full skip if range doesn't match |
| `set` | Equality on low-cardinality columns | Exact match per granule |
| `tokenbf_v1` | Full-text search on Strings | Bloom filter on tokens |
| `ngrambf_v1` | Prefix/substring search | N-gram bloom filter |

Indexes only help if the column appears in your WHERE clause:

```sql
-- Uses bloom_filter index on event_type
SELECT * FROM events WHERE event_type = 'purchase';

-- Ignores bloom_filter index (no WHERE on event_type)
SELECT * FROM events WHERE date > '2026-01-01';
```

### Index Granularity

`GRANULARITY N` means the index is checked once per N granules, not once per granule. Higher values = smaller index, less precise skipping, but faster writes. Lower values = more precise skipping, bigger index.

For high-cardinality columns with bloom_filter, `GRANULARITY 3` is typical — check 3 granules, skip if filter says no match.

## Materialized Views: Pre-Computation at Scale

Materialized views in ClickHouse recompute on every insert. They're the closest thing to a cache that ClickHouse offers, but unlike a cache, they're always consistent.

### Roll-Up View

```sql
-- Source table
CREATE TABLE events_raw (
    user_id UInt32,
    date DateTime,
    event_type String,
    amount Float64
) ENGINE = MergeTree()
ORDER BY (user_id, date);

-- Materialized view that aggregates by hour
CREATE MATERIALIZED VIEW events_hourly
ENGINE = SummingMergeTree()
PARTITION BY toYYYYMM(date)
ORDER BY (event_type, toStartOfHour(date))
AS
SELECT
    event_type,
    toStartOfHour(date) AS hour,
    count() AS cnt,
    sum(amount) AS total_amount
FROM events_raw
GROUP BY event_type, toStartOfHour(date);
```

Inserts automatically populate the view:

```sql
INSERT INTO events_raw VALUES (1, now(), 'purchase', 49.99);
-- View auto-populated with hourly aggregation

-- Query the pre-computed view instead of raw table
SELECT event_type, sum(total_amount) FROM events_hourly
WHERE hour >= '2026-05-01 00:00:00'
GROUP BY event_type;
```

### ClickHouse-Keeper for Real-Time Materialization

For sub-second latency on real-time data, consider using **ClickHouse-Keeper** (built-in coordination layer) to serve pre-aggregated results while raw events continue ingesting.

## Projections: Automatic Query Acceleration

Introduced in ClickHouse 22.8, **projections** are alternate sort orders that ClickHouse automatically selects when they match a query's filter pattern.

```sql
ALTER TABLE events ADD PROJECTION proj_user_date (
    SELECT user_id, date, count(), sum(amount)
    GROUP BY user_id, date
);
```

ClickHouse automatically uses `proj_user_date` when a query matches that SELECT pattern. Unlike materialized views, projections store full data — not just aggregates — so they work for any query on that projection's column set.

### When to Use Projections

- Queries that GROUP BY columns different from the primary key
- Queries that filter on columns not in the primary key
- High-cardinality columns where bloom_filter indexes alone aren't enough

```sql
-- Automatically picks proj_user_date
SELECT user_id, date, count() FROM events
WHERE user_id BETWEEN 1000 AND 2000
GROUP BY user_id, date;
```

## Sampling: The Nuclear Option

When you don't need exact counts, `SAMPLE` dramatically reduces scanned data:

```sql
SELECT count() FROM events SAMPLE 10000;
-- Reads exactly 10,000 granules, extrapolates to full table

-- Sampling with aggregation
SELECT user_id, count() FROM events
WHERE date > '2026-01-01'
SAMPLE 1000000
GROUP BY user_id;
-- If table has 100M granules, reads 1M and scales result
```

`SAMPLE` works on granule count, not row count. The `sample_key` determines which granules are selected.

```sql
CREATE TABLE events (...) ENGINE = MergeTree()
ORDER BY (user_id, date)
SAMPLE BY user_id;  -- deterministic sampling by user_id

SELECT * FROM events SAMPLE 1/10;  -- 10% of data, deterministic
```

## LIMIT BY + PREWHERE: Efficient Top-K Queries

```sql
SELECT user_id, date, amount
FROM events
WHERE date >= '2026-01-01'
LIMIT 100 BY user_id   -- top 100 per user, applied before final sort
ORDER BY amount DESC;
```

`LIMIT BY` reduces data volume early in the pipeline — only 100 rows per user are kept through the rest of the query.

### PREWHERE (Legacy)

Older ClickHouse versions used `PREWHERE` to filter columns before reading full rows. Modern ClickHouse auto-infers PREWHERE behavior from your WHERE clause — explicit `PREWHERE` is deprecated.

## JOIN Strategies

Join order and strategy dramatically affect performance in ClickHouse.

### Broadcast Join (small table on right)

```sql
SELECT e.user_id, u.plan
FROM events e
ANY LEFT JOIN users u ON e.user_id = u.id;
-- ClickHouse broadcasts users table to all shards if it's small enough
```

### Global JOIN (for large tables)

```sql
SELECT e.user_id, u.plan
FROM events e
GLOBAL ANY LEFT JOIN (
    SELECT id, plan FROM users WHERE plan = 'enterprise'
) u ON e.user_id = u.id;
-- Pre-filtered users table joined globally to avoid reshuffling
```

### Shuffle JOIN (when both tables are large)

```sql
SET join_algorithm = 'parallel_hash';
SELECT e.user_id, p.plan_name
FROM events e
JOIN plans p ON e.plan_id = p.id;
-- Data shuffled by join key across nodes
```

### Join Algorithm Comparison

| Algorithm | Best For | Memory | Speed |
|-----------|----------|--------|-------|
| `hash` | Default, balanced | Medium | Fast |
| `parallel_hash` | High cardinality join keys | Medium | Faster |
| `merge` | Sorted inputs | Low | Medium |
| `direct` | Key is primary key of right table | Minimal | Fastest |
| `grace_hash` | Very large joins that exceed memory | Adaptive | Adaptive |

## INTERPOLATE: Running Calculations Without Window Functions

ClickHouse supports `INTERPOLATE` for efficient running calculations that would normally require expensive window functions:

```sql
SELECT
    toStartOfDay(date) AS day,
    revenue,
    revenue - lag(revenue) INTERPOLATE AS prev_revenue
FROM daily_revenue
ORDER BY day
LIMIT 100;
```

This is optimized for columnar storage and often 10× faster than equivalent `LAG() OVER()` window functions.

## Common Anti-Patterns

### 1. SELECT * on Wide Tables

```sql
-- Bad: reads all 150 columns
SELECT * FROM events WHERE user_id = 42;

-- Good: reads only needed columns
SELECT user_id, date, amount FROM events WHERE user_id = 42;
```

ClickHouse reads column-by-column. Selecting all columns forces reads from every column file.

### 2. Functions on WHERE Columns

```sql
-- Bad: cannot use primary key or indexes
SELECT * FROM events WHERE toYYYYMM(date) = 202601;

-- Good: range scan on sortable date column
SELECT * FROM events WHERE date >= '2026-01-01' AND date < '2026-02-01';
```

### 3. Large IN Subqueries

```sql
-- Bad: millions of IDs in IN clause
SELECT * FROM events WHERE user_id IN (1, 2, 3, ...500000);

-- Good: use GLOBAL JOIN or pre-aggregate
SELECT * FROM events GLOBAL ANY JOIN user_set ON events.user_id = user_set.id;
```

### 4. Unpartitioned MERGE Tables

```sql
-- Bad: MERGE engine queries all underlying tables
SELECT * FROM system.movies WHERE title = 'Inception';

-- Good: query the specific table directly
SELECT * FROM movies_current WHERE title = 'Inception';
```

## Query Optimization Canvas

<ClickHouseQueryOptimizer client:load />

The visualizer above shows how different query patterns interact with ClickHouse's storage engine. Use the dropdown to select a query type, then click "Run Query" to see which granules are read and how the query pipeline executes.

## Summary: Query Optimization Checklist

Before shipping a ClickHouse query to production:

1. ✅ Run `EXPLAIN PLAN` — identify full scans
2. ✅ Confirm WHERE clause uses primary key or skip index
3. ✅ Check if GROUP BY order matches ORDER BY
4. ✅ Add bloom_filter/minmax index for non-key filter columns
5. ✅ Consider materialized view for frequent aggregations
6. ✅ Add projection if GROUP BY differs from primary key
7. ✅ Use `SAMPLE` for approximate counts
8. ✅ Prefer `GLOBAL JOIN` for large right-hand tables
9. ✅ Select only needed columns — never `SELECT *`
10. ✅ Keep functions out of WHERE on sortable columns

<ClickHouseQueryOptimizer client:load />