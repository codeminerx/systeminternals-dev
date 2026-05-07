---
title: "URL Shortener System Design: How to Handle Millions of Redirects Per Second"
description: "Design a URL shortening service like bit.ly or TinyURL from scratch. Cover hash techniques, distributed storage, redirect latency, and the architecture that handles millions of requests per day."
date: 2026-05-03
tags: ["system-design", "distributed-systems", "architecture", "scalability", "interviews", "high-availability", "hash", "base62"]
structuredData:
  type: "Article"
  author: "systeminternals.dev"
  datePublished: "2026-05-03"
  dateModified: "2026-05-03"
draft: false
---

Every time you click a shortened link, you're using one of the most elegant distributed systems running today. This post walks through designing a URL shortener from scratch—covering the decisions that matter at scale.

## The Core Problem

A URL shortener does one thing: maps a short alias to a long URL. Sounds simple. The hard part is doing it:

- **Fast**: <10ms redirect latency
- **Reliable**: 99.99% uptime (links never "die")
- **Scalable**: Millions of redirects per minute
- **Cheap**: Storage and compute at scale

## The Naive Approach (And Why It Breaks)

The instinct is to start with a database:

```sql
CREATE TABLE urls (
    id   SERIAL PRIMARY KEY,
    slug VARCHAR(16) UNIQUE,
    url  TEXT NOT NULL
);
```

Generate `slug` from `id` in base62 (a-z, A-Z, 0-9):

| ID | Slug |
|----|------|
| 1 | b |
| 2 | c |
| ... | ... |
| 1000000000 | GjKxQ0 |

**Problems at scale:**

1. **Short slugs run out**: base62 with 7 chars = 62^7 ≈ 3.5 trillion combinations. Fine in theory, but sequential IDs make slugs predictable and easy to enumerate.
2. **Sequential slug = hot spots**: All new links cluster around similar prefixes; caching is harder.
3. **Database bottleneck**: Every redirect is a DB lookup. At 10M RPS, you need thousands of DB connections.

## Step 1: Choosing a Slug Generation Strategy

<UrlShortenerFlow client:load />

### Option A: Hash-Based (MD5/SHA-1 of URL)

```python
import hashlib
import base64

def generate_slug(url: str, length: int = 7) -> str:
    hash_bytes = hashlib.md5(url.encode()).digest()
    return base64.urlsafe_b64encode(hash_bytes)[:length].rstrip('=')
```

**Problem**: Collisions. Different URLs can hash to the same slug. You need a collision check—another DB lookup before inserting.

**Mitigation**: Use the URL + a random salt:

```python
def generate_slug(url: str) -> str:
    for attempt in range(5):
        salt = secrets.token_hex(4)
        slug = base64.urlsafe_b64encode(
            hashlib.sha256((url + salt).encode()).digest()
        )[:7].rstrip('=')
        if not slug_exists(slug):  # DB check
            return slug
    raise Exception("Could not generate unique slug")
```

### Option B: Counter-Based (Distributed ID Generator)

Use a service like Twitter's Snowflake or a simple Redis INCR:

```python
# Using Redis
def generate_slug(counter: int) -> str:
    return base62_encode(counter)

# Redis atomic operation
slug_id = redis.incr("url:id:counter")
slug = base62_encode(slug_id)
```

**Advantages**: No collisions, no pre-check needed, slug is non-sequential if you add a random offset.

### Option C: Custom Alphabet (KSuid or ULID)

```python
import ksuid

slug = ksuid.random().base62()  # "01ARZ3NDEKTSV4RRFFQ69G5FAV"
```

KSUIDs are time-sortable, globally unique, and use a URL-safe alphabet. 27 characters gives you ~217 quintillion possible slugs.

**Recommendation**: Use KSUID or Snowflake-style IDs for production. Hash-based for read-heavy workloads where URL deduplication matters more than insert speed.

## Step 2: Storage Architecture

### Hot Data: Redis Cache

80% of requests are popular links (bit.ly top 10% get 90% of traffic). Cache aggressively:

```
Key: slug
Value: {"url": "https://example.com/very/long/path", "created_at": "2026-01-15"}
TTL: 7 days (refresh on access)
```

At 10M RPS with 1KB per entry: ~10GB RAM. Completely feasible.

### Warm Data: Key-Value Store (DynamoDB / RocksDB)

Popular but not hot enough for Redis:

```sql
-- DynamoDB table design
Table: UrlMappings
  Partition Key: slug (String)
  Attributes: long_url, created_at, click_count, expires_at
  GSI: long_url-index (for deduplication on insert)

Read: 5 RCU per 4KB item
Write: 5 WCU per 1KB item
Cost: ~$0.25/GB/month
```

### Cold Data: Archival Storage

Links older than 2 years with <100 clicks: move to S3/Glacier. Nobody's clicking 2022's campaign links anyway.

## Step 3: The Redirect Flow

<RedirectLatency client:load />

When a user clicks `https://siyuan.ca/abc123`:

```
1. Browser → DNS (5ms)
2. DNS → siyuan.ca IP
3. Browser → Load Balancer (2ms)
4. Load Balancer → Cache Layer (Redis) (1ms)
5. HIT: Redis returns URL → 301 redirect → Browser
   MISS: Redis → DB lookup (5ms) → 301 redirect

Total (cache hit): ~15-25ms
Total (cache miss): ~40-60ms
```

**Critical decision: 301 vs 302**

- **301 (Permanent)**: Browser caches the redirect. SEO value passes to destination. Better for shared links.
- **302 (Temporary)**: Browser does NOT cache. Better for tracking links you might change.

Default to **301**. It's better for users and passes SEO value.

### Writing a New Short Link

```
1. Validate URL (must be http/https, max 2048 chars)
2. Check for duplicates (hash-based)
3. Generate slug (snowflake ID)
4. Write to Redis (immediate availability)
5. Async write to DynamoDB (write-behind for durability)
6. Return slug to user
```

## Step 4: Handling Writes at Scale

Writing is much less frequent than reading (maybe 100:1 ratio). But during viral moments, write volume spikes:

```
Normal day: 100 new links/second
Viral moment: 50,000 new links/second
```

**Solution: Write buffer with async flush**

```
API Server → Kafka → Consumer → Batch Write to DynamoDB
                ↑
         Redis (immediate read path)
```

Kafka buffers spikes. The consumer batches writes: 1000 links per DynamoDB batch write. This absorbs 100× traffic bursts without provisioning for peak.

## Step 5: Analytics Pipeline

<ClickAnalyticsFlow client:load />

Every redirect is a data point. Track:

| Data | Use Case |
|------|----------|
| `referer` | Where is traffic coming from? |
| `user_agent` | Browser, OS, device |
| `geo` | Country/city of click |
| `timestamp` | When did the click happen? |
| `slug` | Which link was clicked? |

**Stream to Kafka → Flink/Spark → ClickHouse**

```sql
-- Real-time dashboard in ClickHouse
SELECT
    slug,
    date,
    count() as clicks,
    uniqExact(referer) as unique_referers,
    stateMerge(geo_state) as geo_distribution
FROM clicks
WHERE date = today()
GROUP BY slug, date
ORDER BY clicks DESC
LIMIT 100;
```

This is exactly what Bitly and TinyURL do. ClickHouse handles billions of events per day at sub-second query speed.

## Step 6: High Availability Design

```
                    ┌─────────────┐
                    │   Route 53   │
                    │   (DNS)      │
                    └──────┬──────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
         ┌────▼────┐ ┌────▼────┐ ┌────▼────┐
         │   PoP 1  │ │   PoP 2  │ │   PoP 3  │
         │ (US-East)│ │ (EU-West)│ │ (Asia-Pac)│
         └────┬────┘ └────┬────┘ └────┬────┘
              │            │            │
         ┌────▼────┐ ┌────▼────┐ ┌────▼────┐
         │  Redis  │ │  Redis  │ │  Redis  │
         │ Cluster │ │ Cluster │ │ Cluster │
         └────┬────┘ └────┬────┘ └────┬────┘
              │            │            │
         ┌────▼────────────▼────────────▼────┐
         │         Global Traffic           │
         │         Manager (Route 53)        │
         └──────────────────────────────────┘
```

**Failure domains:**
- Redis cluster fails: fall back to DynamoDB (higher latency but functional)
- Entire PoP fails: Route 53 health checks shift traffic in <30 seconds
- DynamoDB throttling: use local Redis as circuit breaker

**SLA math:**
- DynamoDB: 99.999% availability (3 nines = 5 minutes/month downtime)
- Redis: 99.99% (52 minutes/year)
- Combined path: still meets 99.99% overall

## Step 7: Preventing Abuse

URL shorteners are abuse targets. Protect against:

**1. Spam URLs**

```python
async def validate_url(url: str) -> bool:
    # Block private IPs
    if is_private_ip(url): return False

    # Check against blocklist (VirusTotal API)
    if await is_malicious(url): return False

    # Rate limit per user
    if await rate_limit_exceeded(user_id): return False

    return True
```

**2. Storage Exhaustion**

Limit slug creation per account:
- Anonymous: 10/hour
- Authenticated: 10,000/hour
- Paid: unlimited

**3. Redirect Loops**

Detect and block cycles (A→B→A):
```python
visited = set()
def follow_redirect_chain(url: str) -> str:
    for _ in range(10):  # max hops
        if url in visited: raise LoopDetected()
        visited.add(url)
        url = resolve_redirect(url)
    return url
```

## The Full Request Flow

```
User clicks https://short.ly/abc123

→ DNS resolves to nearest PoP (5ms)
→ Load balancer routes to app server (2ms)
→ Redis lookup (1ms)
  → HIT: return 301 with long_url
  → MISS: DynamoDB lookup (10ms), cache in Redis, return 301
→ Browser follows redirect (http://long-url.com)

Parallel: click event → Kafka → analytics pipeline → ClickHouse
```

End-to-end latency: **15-50ms** (cache hit vs miss)

## Sizing and Cost

For 1B redirects/month:

| Component | Spec | Monthly Cost |
|-----------|------|-------------|
| Redis (hot cache) | 50GB RAM, 3 replicas | ~$400 |
| DynamoDB (storage) | 1TB data, 50K WCU, 100K RCU | ~$800 |
| Kafka (analytics) | 3 brokers, 100MB/s throughput | ~$600 |
| ClickHouse (analytics) | 3 nodes, 10TB storage | ~$1,500 |
| Compute (API servers) | 20 instances, auto-scaling | ~$1,000 |
| **Total** | | **~$4,300/month** |

That's ~$0.0000043 per redirect. At 10M RPS, you'd need roughly 20× this capacity—and pricing would drop significantly at that scale with committed use.

---

## When to Use URL Shortening

**Good for:**
- Marketing campaigns (trackable links)
- SMS messages (character limits)
- Social media (aesthetic links)
- User-generated content sharing

**Bad for:**
- Internal services (use proper DNS)
- Permanent document links (they break when you shut down the service)
- Anything where uptime is critical (add another failure point)

The URL shortener is a simple idea that becomes complex at scale. The design above handles billions of redirects per month while keeping latency under 50ms and uptime above 99.99%.

Next: [Database Transactions and Isolation Levels Explained](/posts/database-transactions-isolation-levels) →

## Further Reading

Building a URL shortener that scales globally? [Cloudflare's CDN and DNS](https://www.cloudflare.com/partners/) ensure low latency redirects worldwide. <!-- AFFILIATE: cloudflare -->

- [Redis Beyond Caching](/posts/redis-beyond-caching) — Redis is often used as the primary data store for URL shorteners at scale, not just as a cache
- [Distributed Cache System Design](/posts/distributed-cache-system-design) — The same sharding strategies (consistent hashing) used in URL shorteners appear in distributed cache design
- [Rate Limiter System Design](/posts/rate-limiter-system-design) — Both URL shorteners and rate limiters face the challenge of distributed state and latency requirements

Building a URL shortener prototype? [DigitalOcean's App Platform](https://www.digitalocean.com/affiliates) handles deployment and HTTPS certificates automatically. <!-- AFFILIATE: digitalocean -->

## Tools & Services

- **[Vultr](https://www.vultr.com/?ref=8914132)** — Cloud VPS for URL shortener backend deployment. $100 free credit for new accounts. <!-- AFFILIATE: vultr -->
- **[DigitalOcean](https://www.digitalocean.com/affiliates)** — App Platform for automatic HTTPS and easy deployments. $100 free credit. <!-- AFFILIATE: digitalocean -->
- **[Cloudflare](https://www.cloudflare.com/partners/)** — CDN and DNS for global URL shortener distribution. <!-- AFFILIATE: cloudflare -->
