---
title: "Distributed Cache System Design: Building a Memory Layer for High-Traffic Applications"
description: "Design distributed caches from LRU eviction to consistent hashing rings. Cover Redis, Memcached, cache-aside, write-through, thundering herd, and the architecture that keeps services fast at scale."
date: 2026-05-07
tags: ["system-design", "distributed-systems", "redis", "memcached", "caching", "scalability", "consistency", "cache-invalidation", "consistent-hashing", "interviews"]
structuredData:
  type: "Article"
  author: "systeminternals.dev"
  datePublished: "2026-05-07"
  dateModified: "2026-05-07"
draft: false
---

Every fast system in the world has a secret: it cheats. It remembers answers instead of recalculating them. It keeps hot data in memory instead of hitting disk every time. That's the cache—a simple idea with brutal complexity when you distribute it across a hundred machines.

This post dissects distributed cache design from the algorithms that decide what to keep, to the architectures that keep it fast and consistent across a cluster.

## Why You Need a Distributed Cache

Before designing anything, understand the concrete problems a distributed cache solves:

**Latency**: A Redis lookup takes ~0.5ms. A PostgreSQL query with indexes takes ~5-50ms. A disk read takes ~10ms. Three orders of magnitude difference.

**Throughput**: Your database can handle 10,000 queries/second. Your application needs 500,000. Cache the hot 20% of data and you serve 80% of requests from memory.

**Database cost**: AWS RDS costs ~$0.40/vCPU-hour. A Redis cluster costs ~$0.40/node-hour but handles 10-50x more queries per dollar.

**Availability**: A cache miss on a Redis cluster is gracefully slow. A cache miss on a crashed database is a 503.

The rule of thumb: 80% of your requests hit 20% of your data. Cache that 20%.

<DistributedCacheVisualizer client:load />

## The Three Caching Strategies

Every caching strategy is a variation on when you write to the cache relative to the database.

### Cache-Aside (Lazy Loading)

The most common pattern. Your application checks the cache first; on miss, it reads from the database and populates the cache:

```python
def get_user(user_id: int) -> User | None:
    # Step 1: Check cache
    cache_key = f"user:{user_id}"
    cached = redis.get(cache_key)
    if cached:
        return User.from_json(cached)  # Cache HIT

    # Step 2: Cache miss — read from database
    user = db.query("SELECT * FROM users WHERE id = %s", user_id)
    if user is None:
        return None

    # Step 3: Populate cache with TTL
    redis.setex(cache_key, ttl=3600, value=user.to_json())
    return user
```

**Pros**: Simple, only caches what's actually read, tolerant of cache failures (fallback to DB)
**Cons**: First request is always cold (cache stampede on startup), stale data possible

### Write-Through

You write to both the cache and database simultaneously:

```python
def create_user(user: User) -> User:
    # Write to both simultaneously
    db.query("INSERT INTO users ...", user)
    cache_key = f"user:{user.id}"
    redis.setex(cache_key, ttl=3600, value=user.to_json())
    return user
```

**Pros**: Cache is always warm for reads, no cache stampede, strong consistency
**Cons**: Writes are slower (two stores), cache fills with data nobody reads

### Write-Behind (Write-Back)

You write to the cache and return immediately; the cache asynchronously flushes to the database:

```python
def update_user(user_id: int, updates: dict) -> None:
    cache_key = f"user:{user_id}"
    # Write to cache immediately
    cached = redis.get(cache_key)
    user = User.from_json(cached) if cached else db.get(user_id)
    user.merge(updates)
    redis.setex(cache_key, ttl=3600, value=user.to_json())

    # Mark for async DB write (in a background worker)
    event_queue.push({"table": "users", "id": user_id, "op": "upsert"})
```

**Pros**: Writes are extremely fast, excellent for write-heavy workloads
**Cons**: Data loss risk if cache crashes before DB write, complexity in eventual consistency

## Cache Eviction: What to Kick Out

When memory is full, you need to decide what stays and what goes.

### LRU — Least Recently Used

The workhorse. Evict the data accessed furthest in the past:

```python
from collections import OrderedDict

class LRUCache:
    def __init__(self, capacity: int):
        self.capacity = capacity
        self.cache = OrderedDict()

    def get(self, key: str) -> str | None:
        if key not in self.cache:
            return None
        # Move to end (most recently used)
        self.cache.move_to_end(key)
        return self.cache[key]

    def put(self, key: str, value: str) -> None:
        if key in self.cache:
            self.cache.move_to_end(key)
        self.cache[key] = value
        if len(self.cache) > self.capacity:
            # Evict LRU (first item)
            self.cache.popitem(last=False)
```

Redis uses an approximated LRU (sampling `maxmemory-samples` keys) for performance. True LRU requires a linked list that wastes memory on metadata.

### LFU — Least Frequently Used

Evict the least-accessed item. Better for workloads where frequency matters more than recency:

```python
from collections import Counter

class LFUCache:
    def __init__(self, capacity: int):
        self.capacity = capacity
        self.cache = {}       # key -> (value, freq)
        self.freq_counter = Counter()

    def get(self, key: str) -> str | None:
        if key not in self.cache:
            return None
        freq = self.cache[key][1]
        self.freq_counter[freq] -= 1
        self.freq_counter[freq + 1] += 1
        self.cache[key] = (self.cache[key][0], freq + 1)
        return self.cache[key][0]
```

Redis 4.0+ supports LFU via `maxmemory-policy allkeys-lfu`. MongoDB uses LRU for in-memory reads. The right eviction policy depends on your access pattern:

| Policy | Best For | Avoid When |
|--------|----------|------------|
| LRU | General purpose, web apps | Access frequency matters |
| LFU | Stable hot datasets, leaderboards | Burst traffic, cache cold starts |
| TTL-only | Session stores, rate data | Need persistence of hot items |
| Random | Uniformly distributed data, cache-through | Hot spots exist |
| W-TinyLFU | Workload isolation, mixed read/write | Simple implementation needed |

## The Thundering Herd Problem

When a popular cache key expires, 10,000 requests can hit the database simultaneously—all of them discovering the cache is empty at the same time. This is the thundering herd.

### Probabilistic Early Expiration

Instead of serving a stale value or hitting the database, you probabilistically extend the TTL:

```python
import hashlib
import random

def get_with_probabilistic_early_expiry(cache, db, key, ttl=3600):
    """Serve stale with low probability while refreshing in background."""
    cached = cache.get(key)
    if cached:
        value, expiry = cached
        # If within 10% of TTL, 10% chance of early refresh
        if expiry - time.time() < ttl * 0.10 and random.random() < 0.10:
            # Asynchronously refresh
            asyncio.create_task(refresh_cache(cache, db, key, ttl))
        return value

    # Cold miss — refresh synchronously
    value = db.get(key)
    cache.setex(key, ttl, value)
    return value
```

### Lock-Based Cache Stampede Prevention

Use a distributed lock so only one request refreshes while others wait:

```python
import redis
import time

def get_with_lock(cache: redis.Redis, db, key: str, ttl: int = 3600):
    cached = cache.get(key)
    if cached:
        return cached

    # Try to acquire lock for cache population
    lock_key = f"lock:{key}"
    lock_acquired = cache.set(lock_key, "1", nx=True, ex=10)

    if lock_acquired:
        # We got the lock — refresh the cache
        value = db.get(key)
        cache.setex(key, ttl, value)
        cache.delete(lock_key)  # Release lock
        return value
    else:
        # Another request is refreshing — wait and retry
        for _ in range(10):
            time.sleep(0.1)
            cached = cache.get(key)
            if cached:
                return cached
        # Timeout — hit the database
        return db.get(key)
```

Redis SETNX (SET if Not eXists) is your distributed lock primitive.

## Consistent Hashing: Distributing Keys Across Nodes

With N cache nodes, which node stores which key? Naive hashing (`node = hash(key) % N`) breaks when you add or remove nodes—every key remaps, causing a cascade of cache misses.

Consistent hashing assigns keys to nodes in a ring:

```
                    [Node C: 0-100]
                          |
    [Node A: 200-360] --- RING --- [Node B: 100-200]
          |                            |
    Each key hashes to its           Node responsible
    position on the ring            for the nearest
    → Key at 150 goes to B           clockwise node
```

```python
import hashlib

class ConsistentHash:
    def __init__(self, nodes: list[str], virtual_nodes: int = 100):
        self.ring = {}  # hash -> node
        self.sorted_keys = []
        for node in nodes:
            for i in range(virtual_nodes):
                key = hashlib.md5(f"{node}:{i}".encode()).hexdigest()
                self.ring[key] = node
                self.sorted_keys.append(key)
        self.sorted_keys.sort()

    def get_node(self, key: str) -> str:
        if not self.ring:
            raise ValueError("No nodes in ring")
        hash_key = hashlib.md5(key.encode()).hexdigest()
        # Binary search for the first node >= hash_key
        for ring_key in self.sorted_keys:
            if ring_key >= hash_key:
                return self.ring[ring_key]
        # Wrap around to first node
        return self.ring[self.sorted_keys[0]]
```

Virtual nodes (e.g., 100 per physical node) spread the load more evenly. Adding a node only remaps keys near its position on the ring, not 1/N of all keys.

### Consistent Hashing in Practice

**Redis Cluster** doesn't use consistent hashing—instead, it uses hash slots (16,384 slots distributed across nodes). To add capacity, you migrate slots, not individual keys.

**Amazon DynamoDB** and **Cassandra** use consistent hashing with virtual nodes. Each node is responsible for a range of the hash ring.

## Distributing a Cache Cluster

A single Redis node handles ~100,000-200,000 requests/second. At 1,000,000 requests/second, you need a cluster.

### Redis Cluster Architecture

Redis Cluster shards data across multiple nodes using hash slots:

```bash
# 16,384 slots distributed across 6 nodes (3 masters + 3 replicas)
# Node A (master): slots 0-5460
# Node B (master): slots 5461-10922
# Node C (master): slots 10923-16383

# Which slot does a key live in?
CLUSTER KEYSLOT user:1234        # → slot number
CLUSTER Slots 0                  # → node info for slot 0
```

Each master has replica(s) for high availability. If Node A crashes, its replica is promoted to master automatically.

### Client Routing

```python
import redis

# redis-py cluster client handles slot routing automatically
from redis.cluster import RedisCluster

rc = RedisCluster(
    host='10.0.0.1',
    port=7000,
    read_from_replicas=True  # Read from replicas for lower latency
)

# Client routes automatically based on key slot
user = rc.get('user:1234')   # Routes to correct node
```

### Multi-Get: When One Request Hits N Nodes

If you need data from 50 cache keys, they might live on 10 different nodes:

```python
# Naive: 10 sequential round trips
results = [redis.get(f"user:{i}") for i in range(50)]

# Smart: parallel requests to each node
# 1. Group keys by slot/node
# 2. Send parallel MGET to each node
# 3. Merge results
from redis.asyncio import cluster as redis_cluster

async def mget_cluster(keys: list[str]) -> list[str | None]:
    """Multi-get optimized for Redis Cluster."""
    # Group by slot
    slot_map = defaultdict(list)
    for key in keys:
        slot = redis_cluster.keyslot(key)
        slot_map[slot].append(key)

    # Parallel MGET per node
    results = {}
    async with redis_cluster.RedisCluster() as rc:
        tasks = []
        for slot, slot_keys in slot_map.items():
            tasks.append(rc.mget(slot_keys))
        node_results = await asyncio.gather(*tasks)
        for node_result in node_results:
            results.update(dict(zip(slot_keys, node_result)))
    return [results.get(k) for k in keys]
```

## Cache Warming: Prepopulating After Deploy

After a restart, your cache is cold. Users see elevated latency until hot keys are repopulated. Cache warming preloads popular data:

```python
def warm_cache(redis_client, db, top_users: list[int]):
    """Warm cache for top N users after deployment."""
    pipeline = redis_client.pipeline()
    for user_id in top_users:
        user = db.query("SELECT * FROM users WHERE id = %s", user_id)
        if user:
            pipeline.setex(f"user:{user_id}", ttl=86400, value=user.to_json())
    # Execute all writes in one round trip
    pipeline.execute()

# Run on startup after deployment
# Kubernetes post-start hook, systemd unit, or application init
```

For Elasticsearch, warm queries can prepopulate search caches. For Kafka, consumer lag dashboards tell you when caches are healthy.

## Production Patterns

### Cache Key Design

Keys should be descriptive and bounded in size:

```bash
# Good: descriptive, bounded
SET user:12345:profile        "{...}"
SET session:abc123:cart        "{...}"
SET rate:192.168.1.1:minute   "42"

# Bad: unbounded strings, no separator
SET userexample123454545545    "{...}"
```

### Monitoring Cache Health

```bash
# Hit/miss rate
redis-cli INFO stats | grep -E "keyspace_hits|keyspace_misses"
# hit_rate = hits / (hits + misses)

# Memory fragmentation
redis-cli INFO memory | grep mem_fragmentation_ratio
# > 1.5 means wasted memory from fragmentation

# Latency distribution
redis-cli --latency-percentiles
# 50th, 99th, 99.9th percentile latencies

# Replication lag (for replica reads)
redis-cli INFO replication | grep lag
# Should be < 1 second for near-consistent reads
```

### Graceful Degradation

When the cache fails, your app should fall back to the database:

```python
def get_user_graceful(user_id: int) -> User | None:
    try:
        cached = redis.get(f"user:{user_id}")
        if cached:
            return User.from_json(cached)
    except redis.RedisError:
        # Log and continue — Redis is down but DB is up
        logger.warning("Redis unavailable, falling back to DB")

    user = db.query("SELECT * FROM users WHERE id = %s", user_id)
    return user
```

The key principle: cache failures should slow down your app, not crash it.

## When Not to Cache

Caching isn't always the answer:

- **Highly transient data**: Caching a rate counter that resets every minute adds complexity for little gain
- **Write-heavy workloads**: If 80% of operations are writes, cache overhead exceeds benefit
- **Strict consistency requirements**: Banking ledger reads must be fresh; caching savings aren't worth stale data risk
- **Small datasets**: If your DB fits in memory anyway, caching adds a layer with no benefit

Measure first. Cache when data shows hot spots.

## Summary

A distributed cache is a memory layer between your application and your database. The key decisions:

1. **Strategy**: Cache-aside (read-heavy), write-through (mixed), or write-behind (write-heavy)
2. **Eviction**: LRU for general use, LFU for stable hot sets, TTL for transient data
3. **Distribution**: Consistent hashing for even load across nodes, Redis Cluster for production-scale
4. **Stampede prevention**: Probabilistic early expiration or distributed locks
5. **Observability**: Hit rate, latency percentiles, memory fragmentation

Done right, a distributed cache handles 80% of your traffic and keeps your database healthy under load.

## Related Posts

- [Rate Limiter System Design](/posts/rate-limiter-system-design) — Redis-based distributed rate limiting with similar architectural patterns
- [Redis Beyond Caching](/posts/redis-beyond-caching) — Redis used as a primary data store with persistence
- [URL Shortener System Design](/posts/url-shortener-system-design) — Distributed storage with Redis as the hot-path layer
- [Raft Consensus Algorithm](/posts/raft-consensus-algorithm-deep-dive) — How distributed systems agree on state

## Further Reading

- [Redis Cluster Specification](https://redis.io/docs/management/scaling/)
- [Dynamo: Amazon's Key-Value Store](https://www.allthingsdistributed.com/2007/10/amazons_dynamo.html) — Consistent hashing origin story
- [Ben Mane's Cache Design Principles](https://redis.io/topics/lru-cache)

### TTL — Time-To-Live

Every key has an expiration. The simplest eviction: just wait:

```bash
# Redis TTL commands
SET session:1234 "user_data" EX 3600       # 1 hour TTL
TTL session:1234                            # Remaining time
EXPIRE session:1234 7200                   # Extend TTL

# Relative TTL updates (Redis 6.2+)
EXPIRE session:1234 3600 XX                 # Only if exists
