---
title: "Distributed Cache System Design: Patterns, Eviction, and Consistent Hashing"
description: "Design distributed caches from cache-aside to consistent hashing. Cover Memcached vs Redis, cache invalidation strategies, cache stampede prevention, and the architecture behind systems like Redis Cluster and Infinispan at planetary scale."
date: 2026-05-06
tags: ["system-design", "distributed-systems", "redis", "memcached", "caching", "scalability", "interviews", "consistent-hashing"]
structuredData:
  type: "Article"
  author: "systeminternals.dev"
  datePublished: "2026-05-06"
  dateModified: "2026-05-06"
draft: false
---

Every fast system in the world is fast because of a cache. Netflix serves 15% of global internet traffic—but the vast majority of those requests never touch a database. Neither does your browser, your CDN, your API gateway, or the person who just loaded this page. Caching is the backbone of every scalable system, and designing one wrong means your database melts under load at 2 AM.

This post walks through designing a distributed cache from the ground up: the patterns that govern read/write, the eviction policies that keep memory bounded, the sharding strategies that distribute load, and the failure modes that kill production systems.

## Why Caching Matters

A database query takes 5–20ms. A cache lookup takes 0.1–1ms. At 100,000 requests/second, that difference is the difference between 500–2,000 seconds of database time versus 10–100 seconds.

```
Without cache:
  100,000 req/s × 10ms = 1,000,000ms/s = 1,000 backend threads saturating

With cache (95% hit rate):
  5,000 req/s × 10ms = 50ms of actual DB time
  95,000 req/s × 0.5ms = 47.5ms of cache time
  Total: ~100ms effective backend time
```

Databases are shared resources. Every millisecond you save per request compounds at scale.

## The Five Cache Patterns

<DistributedCacheFlow client:load />

### 1. Cache-Aside (Lazy Loading)

The most common pattern. The application manages the cache explicitly:

```python
def get_user(user_id: str) -> dict:
    # Step 1: Check cache first
    cached = redis.get(f"user:{user_id}")
    if cached:
        return json.loads(cached)

    # Step 2: Cache miss — load from database
    user = db.query("SELECT * FROM users WHERE id = %s", user_id)

    # Step 3: Populate cache with TTL
    redis.setex(f"user:{user_id}", 300, json.dumps(user))  # 5 min TTL
    return user
```

**Pros:**
- Application controls everything: when to cache, what to cache, when to invalidate
- Cache only contains data that's actually read (no wasted memory)
- Database is always the source of truth

**Cons:**
- First request after deployment or restart is always a cache miss (cold start)
- Cache and database can drift: application updates DB but forgets to invalidate cache
- Three round trips per cache miss (check cache → query DB → write cache)

### 2. Read-Through

The cache is a "smart" layer that loads data on miss automatically:

```python
# Application just asks the cache — it handles loading
user = cache.get(f"user:{user_id}")  # Block直到 cache fetches from DB

# The cache's loader function does the work:
def user_loader(key: str) -> bytes:
    user_id = key.split(":")[1]
    user = db.query("SELECT * FROM users WHERE id = %s", user_id)
    return json.dumps(user)
```

With Redis Modules or a library like `cache-aside-redis`:

```python
from dogpile.cache import RedisBackend

region = Region(backend=RedisBackend, executor=ThreadPoolExecutor(1))
@region.cache_on_arguments(expiration=300)
def get_user(user_id: str) -> dict:
    return db.query("SELECT * FROM users WHERE id = %s", user_id)
```

**Pros:** Cleaner application code, cache handles loading automatically
**Cons:** More complex cache implementation, application less explicit about what's happening

### 3. Write-Through

Every write goes to cache AND database simultaneously:

```python
def update_user(user_id: str, data: dict):
    # Write to cache and DB in the same transaction
    db.query("UPDATE users SET ... WHERE id = %s", user_id)
    redis.set(f"user:{user_id}", json.dumps(data))
    # Both succeed or the operation fails
```

**Pros:** Cache is always consistent with the database. Read-after-write always hits cache.
**Cons:** Adds latency to every write (cache write + DB write). Wasted memory for data nobody reads.

### 4. Write-Behind (Write-Back)

Writes go to the cache first, and the cache asynchronously flushes to the database:

```python
def update_user(user_id: str, data: dict):
    # Write to cache immediately
    redis.set(f"user:{user_id}", json.dumps(data))

    # Mark as dirty — a background worker flushes to DB
    redis.sadd("dirty:users", user_id)

# Background job (e.g., every 10 seconds):
def flush_dirty_users():
    for user_id in redis.smembers("dirty:users"):
        user_data = redis.get(f"user:{user_id}")
        db.query("UPDATE users SET ... WHERE id = %s", user_id, user_data)
        redis.srem("dirty:users", user_id)
```

**Pros:** Writes are fast (cache only, not DB). Excellent for write-heavy workloads.
**Cons:** Data loss risk if cache crashes before flushing. Complicated to implement correctly.

### 5. Refresh-Ahead (Proactive)

The cache proactively refreshes entries before they expire:

```python
# A background refresher monitors cache and refreshes before TTL expires
def refresh_hot_entries():
    for key in hot_keys:  # Tracked by access frequency
        ttl = redis.ttl(key)
        if ttl < 60:  # Refresh when 60 seconds left
            data = db.query("SELECT * FROM users WHERE id = %s", key)
            redis.setex(key, 300, json.dumps(data))
```

**Pros:** Users never see cache misses on hot data.
**Cons:** Wasted resources refreshing entries nobody reads. Complex to tune correctly.

## Cache Invalidation: The Hard Part

"Caches are lies you tell yourself to feel better about your database." — The problem is when the lie gets too old.

### TTL (Time-To-Live)

The simplest strategy: every cache entry has an expiration time.

```python
# Short TTL for rapidly changing data
redis.setex(f"user:session:{session_id}", 1800, data)  # 30 min

# Longer TTL for stable reference data
redis.setex(f"product:categories", 86400, data)        # 24 hours
```

| Data Type | TTL | Rationale |
|-----------|-----|-----------|
| User sessions | 15–60 min | Must reflect logout quickly |
| Product catalog | 1–24 hours | Changes infrequently |
| Social media feeds | 5–15 min | Balance freshness vs speed |
| Leaderboards | 5–30 sec | Real-time competition |

### Eviction Policies

When memory is full, the cache must evict something. The most common policies:

| Policy | How it works | Best for |
|--------|-------------|---------|
| **LRU** (Least Recently Used) | Evict the least recently accessed item | General purpose, most workloads |
| **LFU** (Least Frequently Used) | Evict least-accessed item overall | Stable hot dataset |
| **FIFO** (First In, First Out) | Evict oldest entry | Simple, predictable latency |
| **Random** | Evict a random entry | Works well at scale (simpler, no bookkeeping) |
| **TTL** | Evict expired entries first | Time-sensitive data |

Redis uses LRU by default but supports all of these:

```
# redis.conf — set eviction policy
maxmemory-policy allkeys-lru

# Available policies:
# noeviction, allkeys-lru, allkeys-random,
# volatile-lru, volatile-ttl, volatile-random, allkeys-lfu, volatile-lfu
```

### Eviction in Memcached

Memcached uses LRU with a slab allocator:

```
# Memcached eviction: pages → slabs → chunks
# Each slab class has chunks of a fixed size
# LRU per slab class (not global)

Slab 1:  64-byte chunks     ← Items ≤ 64 bytes
Slab 2:  128-byte chunks     ← Items ≤ 128 bytes
Slab 3:  256-byte chunks
...
Slab 42: 1MB chunks         ← Large objects
```

When a slab class runs out of free chunks, it evicts from the **tail** of its per-slab LRU. This means large items can expire before small ones even if the small items are older—a footgun in production.

## Consistent Hashing: Distributing Keys Across Nodes

The naive approach to distribution is `hash(key) % num_nodes`. It works until you add or remove a node, which remaps ~1/N of all keys and causes a cascade of cache misses (the "thundering herd" problem).

**Consistent hashing** solves this with a hash ring:

```
                    hash("user:123")
                         ↓
                        104°
                         │
           0° ←─────── ● ───────→ 360°
                       /   ↑
              Node A   /    │   Node B
             0°–120°  /     │   240°–360°
                      /     │
                     /   Node C
                    /    120°–240°
```

Every node occupies a range on the ring. Every key hashes to a point on the ring and is served by the first node clockwise from that point.

### Adding a Node: Only K/N Keys Move

With K virtual nodes per physical node, adding Node D only shifts ~K/N of the key space:

```python
import hashlib

class ConsistentHash:
    def __init__(self, nodes: list[str], vnodes: int = 150):
        self.ring = {}
        self.sorted_keys = []

        for node in nodes:
            for i in range(vnodes):
                key = hashlib.md5(f"{node}:{i}").hexdigest()
                self.ring[key] = node
                self.sorted_keys.append(key)

        self.sorted_keys.sort()

    def get_node(self, key: str) -> str:
        hash_val = int(hashlib.md5(key).hexdigest(), 16)
        # Binary search for the first node >= hash_val
        pos = bisect.bisect_right(self.sorted_keys, hash_val)
        if pos >= len(self.sorted_keys):
            pos = 0
        return self.ring[self.sorted_keys[pos]]
```

### Virtual Nodes for Better Distribution

Without virtual nodes, each physical node is one point on the ring. A high-traffic node becomes a bottleneck. Virtual nodes (typically 150–200 per physical node) give a more uniform distribution:

```
Physical node A → 150 virtual points spread around the ring
Physical node B → 150 virtual points spread around the ring
Physical node C → 150 virtual points spread around the ring

Result: adding/removing any node causes ~1/3 of virtual nodes to shift
→ only 1/3 * (1/N) of physical keys remap ≈ 1/N keys move
```

### Redis Cluster: Hash Slots, Not Consistent Hashing

Redis Cluster takes a different approach: 16,384 hash slots. Keys are assigned to slots via `CRC16(key) mod 16384`, and slots are distributed across nodes:

```
Node A: slots 0–5460
Node B: slots 5461–10922
Node C: slots 10923–16383
```

**This is simpler than consistent hashing** for Redis because slot assignment is deterministic—no lookup required. The tradeoff: resharding requires slot migration (Redis Cluster handles this online).

## Cache Stampede: When Caches Kill Themselves

The worst failure mode: cache expires, 10,000 requests hit the database simultaneously because they all saw the miss at the same time. This is a **cache stampede** (aka the thundering herd problem).

### Solution 1: Probabilistic Early Expiration

Instead of waiting for TTL to expire, probabilistically refresh before it expires:

```python
# probcache.py logic
def get_with_probabilistic_expiry(key, cache, db):
    value, expiry = cache.get_with_expiry(key)
    if value is None:
        # Cache miss — load from DB
        value = db.get(key)
        cache.setex(key, 300, value)
        return value

    # Check if we should refresh early
    ttl_remaining = expiry - time.time()
    if ttl_remaining < 0:
        return value

    # Probability of early refresh:
    # higher when TTL is low and item is popular
    threshold = recalc_threshold(value, ttl_remaining, ...)
    if random.random() < threshold:
        # Async refresh in background
        background_refresh(key, db, cache)
    return value
```

### Solution 2: Cache Locking (Mutex)

Only one process refreshes; others wait:

```python
import redis

def get_with_lock(key: str, cache: redis.Redis, db, ttl: int = 300):
    value = cache.get(key)
    if value:
        return json.loads(value)

    # Try to acquire lock
    lock_key = f"lock:{key}"
    acquired = cache.set(lock_key, "1", nx=True, ex=10)

    if acquired:
        # We got the lock — refresh from DB
        value = db.query("SELECT * FROM users WHERE id = %s", key)
        cache.setex(key, ttl, json.dumps(value))
        cache.delete(lock_key)
        return value
    else:
        # Another process is refreshing — wait and retry
        time.sleep(0.1)
        return get_with_lock(key, cache, db, ttl)
```

### Solution 3: Background Refreshing with Lease

Google's memcached uses "leases" to prevent stampedes:

```
1. Cache miss → memcached gives client a lease token (64-bit int)
2. Client fetches from DB, sends result back with lease token
3. Memcached verifies token is still valid, stores value
4. Other clients hitting same key during this window get served from cache
```

## Hot Keys: When One Key Breaks Everything

Even with consistent hashing, some keys are accessed millions of times per second. A celebrity's profile, a viral tweet's metadata, a hot product's price. These "hot keys" can saturate a single cache node regardless of how many nodes you have.

### Solutions for Hot Keys:

**1. Replicate hot keys across multiple nodes**

```
Key "trending:hashtag:1" replicated to nodes A, B, C, D
Read requests randomly pick one of the replicas
```

**2. Split hot keys into sub-keys**

```python
# Instead of one monolithic cache entry:
redis.set("leaderboard:global", json.dumps(top_1000))

# Partition by score range:
redis.set("leaderboard:1", json.dumps(top_100))    # 1M–100M score
redis.set("leaderboard:2", json.dumps(top_100_2))   # 100M–200M score
```

**3. Client-side throttling**

```python
async def get_hot_key_throttled(key: str, redis_cluster, db):
    # Rate limit per key from the client side
    rate_key = f"ratelimit:hotkey:{hash(key) % 1000}"
    allowed = redis_cluster.incr(rate_key)
    if allowed == 1:
        redis_cluster.expire(rate_key, 1)
    if allowed > 100:  # Max 100 reads/sec per sub-shard
        return db.get(key)  # Fall back to DB
    return redis_cluster.get(key)
```

## Memcached vs Redis: Which Cache?

| Feature | Memcached | Redis |
|---------|-----------|-------|
| Data structures | Strings only | Strings, hashes, lists, sets, sorted sets, streams, bitmaps |
| Eviction policies | LRU per slab class | LRU, LFU, TTL, random, noeviction |
| Persistence | None | RDB snapshots + AOF append-only file |
| Replication | None (stateless) | Master-replica replication |
| Clustering | Consistent hashing (client-side) | Hash slots (server-side) |
| Protocol | ASCII, Binary | ASCII, Binary, RESP (wire protocol) |
| Max value size | 1MB | 512MB |
| Multi-threaded | Yes (uses all cores) | Yes (Redis 6+) |
| Use when | Simple string caching, pure memory pressure | Need data structures, persistence, replication |

For most web applications: **start with Redis**. The richer data structures (sorted sets for leaderboards, streams for queues, hashes for objects) pay for themselves quickly. If you're Facebook-scale and only need string caching, Memcached's multi-threaded architecture has lower CPU overhead.

## Multi-Level Caching: L1 + L2 Architecture

Real production systems stack multiple cache levels:

```
Browser Cache (L1)          → Milliseconds, kilobytes, per-user
                    ↓ miss
CDN Edge Cache (L2)          → Milliseconds, megabytes, shared globally
                    ↓ miss
Application In-Memory (L3)   → Microseconds, gigabytes, per-host (e.g., Go map + LRU)
                    ↓ miss
Distributed Redis (L4)      → Milliseconds, terabytes, shared cluster
                    ↓ miss
Database (L5)               → Milliseconds–seconds, terabytes, shared
```

```python
# Multi-level lookup: L1 (in-memory) → L2 (Redis) → DB
class MultiLevelCache:
    def __init__(self, l1: dict, l2: Redis, db):
        self.l1 = l1  # e.g., Python dict with LRU from cachetools
        self.l2 = l2
        self.db = db

    def get(self, key: str) -> Optional[dict]:
        # L1: microsecond lookup
        val = self.l1.get(key)
        if val:
            return val

        # L2: Redis
        val = self.l2.get(key)
        if val:
            self.l1[key] = val  # Promote to L1
            return val

        # L3: Database
        val = self.db.query(key)
        self.l2.setex(key, 300, val)
        self.l1[key] = val
        return val
```

## Production Architecture

A production distributed cache cluster looks like:

```
App Servers
    │
    ├─ Redis Sentinel (3 nodes): automated failover, read replicas
    │       │
    │       └─ Master (writes) ←→ Replica 1 ←→ Replica 2
    │                    │
    │                    └─ Sentinel monitors: ping every 1s
    │                                    detects failover in ~10s
    │
    └─ Redis Cluster (6 nodes): horizontal sharding, 16,384 slots
            │
            ├─ Node A (slots 0-5460)      Primary + 1 replica
            ├─ Node B (slots 5461-10922) Primary + 1 replica
            ├─ Node C (slots 10923-16383)Primary + 1 replica
            ├─ Node A-replica
            ├─ Node B-replica
            └─ Node C-replica
```

### The Cache Monitoring Dashboard

If you can't measure it, you can't control it:

```prometheus
# Cache hit rate
cache_hits_total / (cache_hits_total + cache_misses_total)

# Latency percentiles
cache_operation_duration_seconds{quantile="0.99"}

# Memory utilization
redis_memory_used_bytes / redis_memory_max_bytes

# Eviction rate (if non-zero, you need more memory)
redis_evicted_keys_total

# Stale reads from replicas
redis_replica_reads_lagged_bytes
```

## Conclusion

A distributed cache is deceptively simple: store the answer so you don't have to ask again. But the engineering underneath is deep:

1. **Pattern**: Cache-aside for most cases, read-through when you want cleaner code
2. **Eviction**: LRU for general use, LFU when you know your access distribution
3. **Distribution**: Consistent hashing (or hash slots with Redis Cluster) for horizontal scale
4. **Stampede prevention**: Probabilistic early expiration or mutex locks
5. **Hot keys**: Replicate across nodes or partition aggressively
6. **Multi-level**: Stack L1 (in-memory) + L2 (Redis) for the best latency/throughput tradeoff

The right cache architecture is the one that survives your next viral moment without taking your database with it.

---

**Related Posts**

- [Rate Limiter System Design](/posts/rate-limiter-system-design) — Redis as the state store for distributed rate limiting
- [Redis Beyond Caching](/posts/redis-beyond-caching) — Redis data structures that power production caches
- [URL Shortener System Design](/posts/url-shortener-system-design) — Consistent hashing in action for distributed storage
- [Raft Consensus Algorithm](/posts/raft-consensus-algorithm-deep-dive) — How distributed caches achieve consistency

---

**External Resources**

- [Designing Data-Intensive Applications: Caching](https://dataintensive.net/) — Martin Kleppmann's definitive chapter on caching hierarchies
- [Memcached vs Redis: A Deep Dive](https://redis.io/topics/memcached) — When to use each, from the Redis team
- [Consistent Hashing and Random Trees](https://www.akamai.com/us/en/multimedia/documents/technical-publication/consistent-hashing-and-random-trees-distributed-caching-protocols.pdf) — The original paper
- [Caching Challenges: Cache Stampede](https://people.cs.uchicago.edu/~jcma/papers/facebook-caching.pdf) — How Facebook handles stampedes at scale
- [Google's Guava Cache](https://github.com/google/guava/wiki/CachesExplained) — Excellent reference implementation of refresh-ahead and eviction
