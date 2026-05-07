---
title: "Database Transactions and Isolation Levels Explained"
description: "ACID properties, Read Uncommitted to Serializable isolation levels, dirty reads, non-repeatable reads, phantom reads, pessimistic vs optimistic locking, deadlock handling, and race condition prevention in SQL databases."
date: 2024-01-28
tags: ["sql", "databases", "transactions", "concurrency", "acid", "isolation-levels"]
structuredData:
  type: "Article"
  author: "systeminternals.dev"
  datePublished: "2024-01-28"
  dateModified: "2024-01-28"
---

Race conditions aren't just a multithreading problem. Your database has them too. Let's talk about transactions and isolation levels.

## The Classic Problem

Two users buy the last item simultaneously:

```
User A: SELECT quantity FROM products WHERE id = 1;  -- Returns 1
User B: SELECT quantity FROM products WHERE id = 1;  -- Returns 1
User A: UPDATE products SET quantity = 0 WHERE id = 1;
User B: UPDATE products SET quantity = 0 WHERE id = 1;
-- Both users "bought" the item. You oversold.
```

Transactions and proper isolation levels prevent this.

## ACID Properties

**Atomicity**: All or nothing. If any part fails, the entire transaction rolls back.

```sql
Testing isolation levels in practice? [DigitalOcean's managed PostgreSQL](https://www.digitalocean.com/affiliates) makes it easy to experiment with different isolation levels on a live database. <!-- AFFILIATE: digitalocean -->


UPDATE accounts SET balance = balance - 100 WHERE id = 1;
UPDATE accounts SET balance = balance + 100 WHERE id = 2;
-- If either fails, both are rolled back
COMMIT;
```

**Consistency**: Transactions move the database from one valid state to another. Constraints are enforced.

**Isolation**: Concurrent transactions don't interfere with each other (to a degree—see below).

**Durability**: Once committed, data survives crashes.

## Isolation Levels

Here's where it gets interesting. SQL defines four isolation levels, each trading performance for consistency:

### Read Uncommitted

The wild west. You can see other transactions' uncommitted changes.

```sql
SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;
```

**Allows:** Dirty reads (seeing uncommitted data that might be rolled back)

**Use case:** Almost never. Maybe some analytics where accuracy doesn't matter.

### Read Committed

You only see committed data. Default in PostgreSQL.

```sql
SET TRANSACTION ISOLATION LEVEL READ COMMITTED;

-- Transaction A
BEGIN;
SELECT balance FROM accounts WHERE id = 1;  -- Returns 100

-- Transaction B commits: UPDATE accounts SET balance = 50 WHERE id = 1;

SELECT balance FROM accounts WHERE id = 1;  -- Returns 50 (different!)
COMMIT;
```

**Allows:** Non-repeatable reads (same query, different results within a transaction)

**Use case:** Most OLTP applications. Good balance of consistency and performance.

### Repeatable Read

Your reads are consistent within the transaction. Default in MySQL.

```sql
SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;

-- Transaction A
BEGIN;
SELECT balance FROM accounts WHERE id = 1;  -- Returns 100

-- Transaction B commits: UPDATE accounts SET balance = 50 WHERE id = 1;

SELECT balance FROM accounts WHERE id = 1;  -- Still returns 100
COMMIT;
```

**Allows:** Phantom reads (new rows can appear from other transactions)

**Use case:** When you need consistent reads but can tolerate new rows appearing.

### Serializable

Transactions execute as if they ran one at a time.

```sql
SET TRANSACTION ISOLATION LEVEL SERIALIZABLE;
```

**Allows:** Nothing. Full isolation.

**Use case:** Financial systems, inventory management—anywhere race conditions are unacceptable.

**Cost:** Significant performance overhead. More deadlocks and retries.

## The Inventory Problem Solved

Remember our overselling problem? Here's how to fix it:

### Option 1: Serializable Isolation

```sql
SET TRANSACTION ISOLATION LEVEL SERIALIZABLE;
BEGIN;
SELECT quantity FROM products WHERE id = 1;
-- If quantity > 0
UPDATE products SET quantity = quantity - 1 WHERE id = 1;
INSERT INTO orders (product_id, user_id) VALUES (1, current_user_id);
COMMIT;
```

One transaction will succeed; the other will be rolled back with a serialization error. Retry it.

### Option 2: Pessimistic Locking

```sql
BEGIN;
SELECT quantity FROM products WHERE id = 1 FOR UPDATE;  -- Locks the row
-- If quantity > 0
UPDATE products SET quantity = quantity - 1 WHERE id = 1;
INSERT INTO orders (product_id, user_id) VALUES (1, current_user_id);
COMMIT;
```

`FOR UPDATE` locks the row until the transaction completes. Other transactions wait.

### Option 3: Optimistic Locking

```sql
-- Add a version column
ALTER TABLE products ADD COLUMN version INT DEFAULT 0;

-- Application code
BEGIN;
SELECT quantity, version FROM products WHERE id = 1;  -- quantity=1, version=5

UPDATE products 
SET quantity = quantity - 1, version = version + 1 
WHERE id = 1 AND version = 5;  -- Only succeeds if version unchanged

-- Check if UPDATE affected 1 row. If 0, someone else modified it. Retry.
COMMIT;
```

No locks. Check at update time if data changed. Faster but requires retry logic.

## Deadlocks

When two transactions wait for each other:

```
Transaction A: Locks row 1, wants row 2
Transaction B: Locks row 2, wants row 1
-- Deadlock!
```

Databases detect this and kill one transaction. Your code should:

1. Catch deadlock errors
2. Retry the transaction
3. Consider consistent ordering (always lock rows in the same order)

## Practical Guidelines

1. **Understand your database's default.** PostgreSQL defaults to Read Committed. MySQL to Repeatable Read.

2. **Use the lowest isolation level that's correct.** Higher isolation = worse performance.

3. **Prefer optimistic locking for low-contention scenarios.** It scales better.

4. **Use pessimistic locking (`FOR UPDATE`) when conflicts are common.**

5. **Always handle transaction failures.** Deadlocks and serialization errors happen.

6. **Keep transactions short.** Long transactions increase lock contention.

```sql
-- ❌ Bad: Long transaction
BEGIN;
SELECT * FROM products;  -- User stares at page
-- ... 5 minutes later ...
UPDATE products SET quantity = quantity - 1 WHERE id = 1;
COMMIT;

-- ✅ Good: Short transaction
-- Read outside transaction
-- Only use transaction for the critical update
BEGIN;
UPDATE products SET quantity = quantity - 1 WHERE id = 1 AND quantity > 0;
COMMIT;
```

Race conditions in databases are real. Choose the right isolation level, understand the tradeoffs, and test your concurrent scenarios.

If you're evaluating database hosting, [Vultr's managed databases](https://www.vultr.com/?ref=8914132) support PostgreSQL, MySQL, and Redis with automated failover. <!-- AFFILIATE: vultr -->

## Related Posts

- [PostgreSQL vs MySQL 2024](/posts/postgresql-vs-mysql-2024) — MVCC implementations differ between databases; PostgreSQL's version-based approach affects concurrency behavior
- [SQL Indexing Deep Dive](/posts/sql-indexing-deep-dive) — Index design directly affects lock contention under high concurrency
- [Redis Beyond Caching](/posts/redis-beyond-caching) — Redis intentionally lacks ACID transactions; understanding why helps you choose the right tool

## Tools & Services

- **[Vultr](https://www.vultr.com/?ref=8914132)** — Cloud VPS for database hosting. $100 free credit for new accounts. <!-- AFFILIATE: vultr -->
- **[DigitalOcean](https://www.digitalocean.com/affiliates)** — Managed databases with high availability and automated failover. $100 free credit. <!-- AFFILIATE: digitalocean -->
