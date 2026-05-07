---
title: "SQL Indexing: A Deep Dive into Database Performance"
description: "B-tree and composite indexes, covering indexes, partial indexes, EXPLAIN plan analysis, and how to diagnose and fix slow SQL queries with real examples."
date: 2024-02-15
tags: ["sql", "databases", "performance", "indexing", "b-tree", "composite-index", "explain"]
structuredData:
  type: "Article"
  author: "systeminternals.dev"
  datePublished: "2024-02-15"
  dateModified: "2024-02-15"
---

If your queries are slow, chances are you're missing an index. But slapping indexes everywhere isn't the answer either. Let's dig into how they actually work.

## What Is an Index?

Think of a database index like a book's index. Instead of scanning every page to find "PostgreSQL," you flip to the back, find the term, and jump directly to page 247.

A database index works the same way—it's a separate data structure that maintains pointers to your actual rows, organized for fast lookups.

## B-Tree: The Workhorse

Most databases default to B-tree indexes. Here's why they're everywhere:

```sql
CREATE INDEX idx_users_email ON users(email);
```

B-trees are balanced tree structures that keep data sorted. They excel at:
- Equality lookups (`WHERE email = 'user@example.com'`)
- Range queries (`WHERE created_at > '2024-01-01'`)
- Sorting (`ORDER BY created_at`)

The key insight: B-trees maintain O(log n) lookup time regardless of table size. A table with 1 million rows? About 20 comparisons to find your row.

## When Indexes Hurt

Every index has a cost:

```sql
-- This INSERT now needs to update multiple indexes
INSERT INTO users (email, name, created_at) VALUES (...);
```

Each index is a separate data structure that must be maintained. More indexes = slower writes.

**Rule of thumb:** Index columns you query often. Don't index columns you rarely filter on.

## Composite Indexes

Order matters more than you think:

```sql
-- Index on (status, created_at)
CREATE INDEX idx_orders_status_date ON orders(status, created_at);

-- ✅ Uses the index (leftmost prefix)
SELECT * FROM orders WHERE status = 'pending';

-- ✅ Uses the index fully
SELECT * FROM orders WHERE status = 'pending' AND created_at > '2024-01-01';

-- ❌ Cannot use the index efficiently
SELECT * FROM orders WHERE created_at > '2024-01-01';
```

The leftmost prefix rule: a composite index can be used for queries that filter on the leftmost columns, but not if you skip them.

## Covering Indexes

Here's a performance trick—include all columns your query needs:

```sql
CREATE INDEX idx_users_email_name ON users(email, name);

-- This query never touches the table at all
SELECT name FROM users WHERE email = 'user@example.com';
```

The query is "covered" by the index. No need to fetch the actual row.

## EXPLAIN Is Your Friend

Always check your query plan:

```sql
EXPLAIN ANALYZE SELECT * FROM users WHERE email = 'test@example.com';
```

Look for:
- **Seq Scan**: No index used, scanning entire table
- **Index Scan**: Using an index to find rows
- **Index Only Scan**: Even better—covered by the index

## Partial Indexes

Why index rows you never query?

```sql
-- Only index active users
CREATE INDEX idx_active_users ON users(email) WHERE status = 'active';
```

Smaller index = faster lookups = less storage.

## The Bottom Line

1. Index columns in your WHERE clauses
2. Consider composite indexes for multi-column filters
3. Mind the order in composite indexes
4. Use EXPLAIN to verify your indexes work
5. Don't over-index—it slows down writes

Start with the slow queries in your logs. Add indexes surgically. Measure the impact.

Benchmarking query plans? [DigitalOcean](https://www.digitalocean.com/affiliates)'s PostgreSQL instances give you 4 vCPUs for large dataset tests. <!-- AFFILIATE: digitalocean -->

## Related Posts

- [PostgreSQL vs MySQL 2024](/posts/postgresql-vs-mysql-2024) — Different planners handle indexes differently; knowing which database you're using changes how you design indexes
- [Database Transactions and Isolation Levels](/posts/database-transactions-isolation-levels) — Indexes affect lock contention and contention under concurrent writes
- [Database Normalization](/posts/database-normalization-practical-guide) — Denormalization is sometimes chosen over indexing for read-heavy workloads

Testing query plans on large datasets? [Spin up a cloud database on DigitalOcean](https://www.digitalocean.com/affiliates) — PostgreSQL with 4 vCPUs handles millions of rows without breaking a sweat. <!-- AFFILIATE: digitalocean -->

## Tools & Services

- **[Vultr](https://www.vultr.com/?ref=8914132)** — Cloud VPS for testing query plans and index performance. $100 free credit for new accounts. <!-- AFFILIATE: vultr -->
- **[DigitalOcean](https://www.digitalocean.com/affiliates)** — Managed PostgreSQL with 4 vCPUs for large dataset indexing tests. $100 free credit. <!-- AFFILIATE: digitalocean -->
