---
title: "Redis Beyond Caching: Using Redis as a Primary Database"
description: "Redis data structures (hashes, lists, sets, sorted sets, streams), persistence options (RDB/AOF), pub/sub, rate limiting, and when to use Redis as a primary database instead of just a cache."
date: 2024-01-20
tags: ["redis", "databases", "nosql", "caching"]
---

Redis started as a cache, but it's evolved into something much more powerful. Let's explore using Redis beyond simple key-value caching.

## Redis Data Structures

This is where Redis shines. It's not just `GET` and `SET`.

### Strings

The basics, but powerful:

```bash
SET user:1:session "abc123" EX 3600  # Expires in 1 hour
GET user:1:session

# Atomic increment - perfect for counters
INCR page:views:home
INCRBY user:1:points 50
```

### Hashes

Store objects without serialization overhead:

```bash
HSET user:1 name "Alice" email "alice@example.com" role "admin"
HGET user:1 email
HGETALL user:1

# Increment a field atomically
HINCRBY user:1 login_count 1
```

### Lists

Ordered collections. Great for queues and timelines:

```bash
# Add to a list
LPUSH notifications:user:1 "New message from Bob"
LPUSH notifications:user:1 "Your order shipped"

# Get recent notifications
LRANGE notifications:user:1 0 9  # Last 10

# Use as a queue
RPUSH queue:emails "email-job-1"
LPOP queue:emails  # Process FIFO
```

### Sets

Unique collections. Perfect for tags, followers, etc:

```bash
SADD user:1:followers 2 3 4
SADD user:2:followers 1 3 5

# Who follows both?
SINTER user:1:followers user:2:followers

# Is user 3 a follower?
SISMEMBER user:1:followers 3
```

### Sorted Sets

Ranked data. Leaderboards, time-series, priority queues:

```bash
# Leaderboard
ZADD leaderboard 100 "alice" 85 "bob" 92 "charlie"

# Top 3 players
ZREVRANGE leaderboard 0 2 WITHSCORES

# Time-based feeds (score = timestamp)
ZADD feed:user:1 1706745600 "post:123"
ZADD feed:user:1 1706832000 "post:124"

# Get posts from last 24 hours
ZRANGEBYSCORE feed:user:1 (NOW-86400) +inf
```

## Persistence: Redis as a Real Database

Redis isn't just in-memory. You have persistence options:

### RDB (Snapshotting)

Point-in-time snapshots saved to disk:

```
# redis.conf
save 900 1      # Save if 1 key changed in 900 seconds
save 300 10     # Save if 10 keys changed in 300 seconds
save 60 10000   # Save if 10000 keys changed in 60 seconds
```

**Pros:** Compact, fast recovery
**Cons:** Data loss between snapshots

### AOF (Append-Only File)

Log every write operation:

```
# redis.conf
appendonly yes
appendfsync everysec  # Sync to disk every second
```

**Pros:** Minimal data loss (at most 1 second)
**Cons:** Larger files, slower recovery

### Best of Both

Use both for durability + fast recovery:

```
# redis.conf
appendonly yes
appendfsync everysec
save 900 1
```

## Redis Streams

Event sourcing and message queues built into Redis:

```bash
# Add events to a stream
XADD orders * product_id 123 user_id 456 status "pending"

# Read new events
XREAD BLOCK 5000 STREAMS orders $

# Consumer groups for distributed processing
XGROUP CREATE orders order-processors $
XREADGROUP GROUP order-processors worker-1 COUNT 10 STREAMS orders >
XACK orders order-processors 1234567890-0
```

Streams give you Kafka-like functionality without running Kafka.

## Use Cases Where Redis Excels

### Session Storage

```bash
HSET session:abc123 user_id 1 role "admin" expires_at 1706918400
EXPIRE session:abc123 3600
```

Fast reads, automatic expiration, no database load.

### Rate Limiting

```bash
# Sliding window rate limit
local key = "ratelimit:" .. user_id
local count = redis.call("INCR", key)
if count == 1 then
    redis.call("EXPIRE", key, 60)
end
return count <= 100  -- 100 requests per minute
```

### Real-time Leaderboards

```bash
ZINCRBY game:leaderboard 10 "player:1"
ZREVRANK game:leaderboard "player:1"  # Get rank
ZREVRANGE game:leaderboard 0 99 WITHSCORES  # Top 100
```

Sorted sets make this trivial. Try doing this efficiently in SQL.

### Pub/Sub

```bash
# Publisher
PUBLISH chat:room:1 "Hello everyone!"

# Subscriber
SUBSCRIBE chat:room:1
```

Simple real-time messaging without a separate message broker.

## When NOT to Use Redis as Primary

- **Complex queries**: No JOINs, no ad-hoc queries
- **Large datasets**: Everything must fit in RAM (or use Redis on Flash)
- **Strong consistency**: Redis is eventually consistent in cluster mode
- **Complex transactions**: Limited ACID guarantees

## Redis Cluster for Scale

When one instance isn't enough:

```bash
# Data is automatically sharded across nodes
# Each key hashes to a slot (0-16383)
# Slots are distributed across nodes
```

Redis Cluster provides:
- Automatic sharding
- High availability (replicas)
- Linear scalability

## Practical Architecture

The sweet spot: Redis alongside a traditional database.

```
┌─────────────┐     ┌─────────────┐     ┌──────────────┐
│   Client    │────▶│    Redis    │────▶│  PostgreSQL  │
└─────────────┘     │   (hot)     │     │   (source)   │
                    └─────────────┘     └──────────────┘
```

- PostgreSQL: Source of truth, complex queries
- Redis: Sessions, caching, real-time features

## The Bottom Line

Redis isn't just a cache. With the right use case, it's a powerful primary database:

- Use it for session management, real-time features, and leaderboards
- Enable persistence (AOF + RDB) for durability
- Consider Redis Cluster for horizontal scaling
- Pair it with a relational database for complex queries

The key is understanding what Redis does well—fast, structured data access—and using it where that matters most.
