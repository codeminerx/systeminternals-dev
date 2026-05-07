---
title: "Chat System Design: How to Build a WhatsApp-Scale Messaging System"
description: "Design a real-time chat system like WhatsApp from first principles. Cover WebSockets, message storage with Cassandra, fan-out patterns, online/offline presence, and the architecture decisions that scale to billions of messages per day."
date: 2026-05-05
tags: ["system-design", "distributed-systems", "messaging", "real-time", "scalability", "interviews", "websockets", "cassandra"]
structuredData:
  type: "Article"
  author: "systeminternals.dev"
  datePublished: "2026-05-05"
  dateModified: "2026-05-05"
draft: false
---

Every time you send a message and it appears instantly on your friend's phone, you've triggered one of the most fascinating distributed systems running at planetary scale. This post walks through designing a chat system—covering WebSocket connections, message ordering, fan-out patterns, and the trade-offs that separate a toy chat app from WhatsApp.

## The Scale Problem

Before diving in, let the numbers sink in:

- **WhatsApp**: 65+ billion messages per day
- **Peak throughput**: ~1 million messages per second during New Year's Eve
- **User expectations**: <100ms message delivery, always-on connections
- **Constraint**: Users are mobile, behind NAT, with intermittent connectivity

The core challenge isn't storing messages—it's maintaining real-time, bidirectional communication with hundreds of millions of always-connected devices.

## Requirements Gathering

### Functional Requirements
- **1:1 messaging**: Instant delivery between two users
- **Group chats**: 1 to N delivery, up to 256+ members
- **Message persistence**: Messages readable after logout/re-login
- **Online/offline status**: Presence indicators
- **Push notifications**: Delivered even when app is closed
- **End-to-end encryption**: Nobody, including the server, can read messages

### Non-Functional Requirements
- **Latency**: <100ms for message delivery within the same region
- **Availability**: 99.99% uptime (≤52 min downtime/year)
- **Scalability**: Millions of concurrent connections
- **Consistency**: Messages must appear in correct order per conversation

## Long Polling vs WebSockets

The first architectural decision: how do clients maintain a connection to the server?

### HTTP Long Polling

```
Client → Server: "Any messages?" (request hangs)
... 30 seconds pass ...
Server → Client: "No, try again"
Client → Server: "Any messages?" (new request)
... repeat forever ...
```

**Problems at scale:**
- New TCP connection per poll = massive connection churn
- Server must hold request open = thread/memory exhaustion
- Average latency = poll interval / 2 = 15s with 30s polls
- Expensive in terms of headers (~800 bytes overhead per request)

### WebSockets: The Right Abstraction

WebSocket starts as an HTTP handshake, then "upgrades" to a persistent TCP connection:

```http
GET /ws HTTP/1.1
Host: chat.example.com
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==
```

```http
HTTP/1.1 101 Switching Protocols
Upgrade: websocket
Connection: Upgrade
```

After the handshake, both client and server can send frames at any time—no request-response pairing required. This is the fundamental primitive for real-time messaging.

**Why WebSockets win for chat:**
- Single TCP connection per user = efficient
- Full-duplex = server pushes without client polling
- Lower latency = messages arrive as soon as they're sent
- Better battery life on mobile = no constant polling

## The WebSocket Gateway

At scale, you can't just spin up a chat server and expect it to handle millions of connections. The architecture uses a **WebSocket Gateway** tier:

<ChatSystemFlow client:load />

### Gateway Responsibilities

1. **Connection management**: Maintain millions of long-lived WebSocket connections
2. **Authentication**: Validate JWT on connect, associate user_id with connection
3. **Message routing**: Route incoming messages to appropriate downstream services
4. **Presence tracking**: Update online/offline status in Redis
5. **Health monitoring**: Detect stale connections via heartbeat

### Gateway as a Stateful Service

Here's the key insight: the gateway is *stateful*. It needs to know which user is connected to which gateway instance:

```python
# In Redis, per gateway instance:
# Key: "presence:{user_id}"
# Value: JSON { "gateway_id": "gw-us-east-1-a", "connected_at": 1715000000 }
```

When a message needs to go to User B, you look up their gateway, then push the message to that specific instance.

## 1:1 Message Flow

Here's what actually happens when User A sends "Hi B":

**Step 1: A → Gateway (WebSocket frame)**
```
WebSocket frame:
  opcode: 1 (text)
  payload: { "type": "message", "to": "user_b", "text": "Hi B", "client_msg_id": "abc123" }
```

**Step 2: Gateway validates and persists**
```python
# Generate globally unique message ID
msg_id = snowflake.generate()  # 64-bit: timestamp + node + seq

# Write to Cassandra
await cassandra.execute("""
    INSERT INTO messages (conversation_id, message_id, sender_id, text, created_at)
    VALUES (?, ?, ?, ?, ?)
""", [conversation_id, msg_id, user_a_id, "Hi B", now])
```

**Step 3: Gateway publishes to Redis Pub/Sub**
```python
# Each user's "inbox" is a Redis channel
await redis.publish(f"user:{user_b_id}", json.dumps({
    "msg_id": msg_id,
    "from": user_a_id,
    "text": "Hi B",
    "ts": now
}))
```

**Step 4: B's Gateway receives via Redis subscription**
```python
# On each gateway instance, a background task subscribes to its users' channels
async def start_subscriber(gateway_id):
    users = await redis.smembers(f"gateway:{gateway_id}:users")
    pubsub = redis.pubsub()
    await pubsub.subscribe(*[f"user:{uid}" for uid in users])
    async for msg in pubsub.listen():
        await push_to_websocket(msg['user_id'], msg['data'])
```

**Step 5: B's device receives push**
- If app open: push over WebSocket (instant)
- If app closed: send APNs (Apple) / FCM (Android) push notification

**End-to-end latency: ~50-80ms within same region**

## Message Storage: The Schema

WhatsApp-scale messaging requires a database optimized for write-heavy workloads with range queries. Cassandra is the canonical choice:

```sql
CREATE TABLE messages (
    conversation_id  bigint,       -- partition key (sharded by conversation)
    message_id      bigint,        -- clustering key (descending for reverse scan)
    sender_id       bigint,
    text            text,
    delivered_at    timestamp,
    read_at         timestamp,
    PRIMARY KEY ((conversation_id), message_id)
) WITH CLUSTERING ORDER BY (message_id DESC);
```

**Why this schema:**
- `conversation_id` as partition key = all messages for a conversation on same shard
- `message_id DESC` = fast "most recent messages" query
- Wide partitions = reading a conversation loads contiguous messages efficiently
- Append-only = ideal write pattern for SSDs

**Sharding strategy:**
```python
def get_shard(conversation_id: int, num_shards: int) -> int:
    return conversation_id % num_shards

# Route to Cassandra cluster for that shard
cluster = cassandra_clusters[get_shard(conversation_id, NUM_SHARDS)]
```

### Why Not PostgreSQL?

PostgreSQL works fine for <1M users. But at WhatsApp scale:
- **B-tree splits**: High write volume causes page splits and index bloat
- **Connection per shard**: 1M users × each with a connection = impossible
- **Single-node writes**: Hot spots on leader = throughput ceiling

## Group Chat: The Fan-Out Problem

Group messaging is where it gets interesting. When User A sends to a 100-person group, you need to deliver to 99 other members.

### Naive Approach (Don't Do This)

```
For each member in group:
    publish to member's channel
```

With 100 members and 1M messages/day, that's 99M Pub/Sub publishes. This works but wastes resources delivering to offline users.

### Better: Presence-Aware Fan-Out

```python
async def deliver_group_message(group_id: str, sender: str, message: dict):
    # Get all ONLINE members from Redis
    online_members = await redis.smembers(f"group:{group_id}:online")

    # Get all OFFLINE members  
    all_members = await redis.smembers(f"group:{group_id}:members")
    offline_members = all_members - online_members

    # Deliver to online users via Pub/Sub (instant)
    for member_id in online_members:
        await redis.publish(f"user:{member_id}", json.dumps(message))

    # Mark message as pending for offline users
    for member_id in offline_members:
        await redis.rpush(f"user:{member_id}:pending", json.dumps(message))
```

**Optimization**: When an offline user comes back online, their gateway pulls from the `pending` queue.

### Fan-Out on Write vs Fan-Out on Read

| Strategy | Description | Pros | Cons |
|----------|-------------|------|------|
| Fan-out on write | Replicate message to each recipient's inbox on send | Fast reads | Slow writes for large groups |
| Fan-out on read | Store message once, expand on read | Fast writes | Slow reads, must deduplicate |
| Hybrid | Small groups write, large groups read | Tunable | Complexity |

WhatsApp uses **hybrid**: groups up to 256 members use fan-out-on-write. Larger "channels" (like Telegram channels) use fan-out-on-read.

## Message Ordering: Getting It Right

Users expect messages to appear in the order they were sent. Sounds simple—until you consider:

- Messages can arrive out of order due to network retries
- A user might send from multiple devices
- Server-side processing delays vary

### Causality and Sequence Numbers

Each message gets a **logical timestamp** (Lamport clock):

```python
# Client-side
local_seq = counter.increment()  # 1, 2, 3, ...
message = { "seq": local_seq, "text": "Hi", "ts": now() }
send_to_server(message)
```

The server assigns a **server-side sequence number**:

```python
# Server-side
server_seq = redis.incr(f"conversation:{conv_id}:seq")
message["server_seq"] = server_seq
```

On the client, messages are displayed sorted by `server_seq`. If a message arrives with `seq` earlier than the last-displayed `seq`, it's a duplicate (ignore).

### Vector Clocks for Multi-Device

If User A is on phone and laptop simultaneously, each device has its own counter:

```
User A (phone):  [A: 5]
User A (laptop): [A: 3]
```

Vector clocks detect causality: if device A sends to device B, B can detect whether a message is "newer" or "stale" by comparing vector clocks.

## Online/Offline Presence

"How do I show the green dot?" is a surprisingly hard distributed systems problem.

### Architecture

```
Redis sorted set: "presence:{user_id}"
  Score: Unix timestamp of last heartbeat
  Member: gateway_id
  TTL: 60 seconds (if no heartbeat, key expires)
```

### Heartbeat Protocol

```python
# Client sends heartbeat every 30 seconds
async def heartbeat():
    await websocket.send(json.dumps({ "type": "ping" }))

# Server responds
async def server_heartbeat():
    await redis.zadd(f"presence:{user_id}", now(), gateway_id)
    await redis.expire(f"presence:{user_id}", 60)
```

### Presence Updates: Efficient Delivery

Broadcasting "User A is online" to all their contacts is expensive (O(friends)). Two approaches:

**1. Polling (simpler)**:
```javascript
// On contact list page load, fetch presence
GET /api/presence?users=id1,id2,id3
→ { "id1": "online", "id2": "offline", "id3": "online" }
```

**2. Delta pushes (more efficient)**:
- Subscribe to a "presence channel" when user opens contact list
- Receive incremental updates: "user_123 went online"
- Close subscription when user navigates away

## End-to-End Encryption (Simplified)

WhatsApp uses the **Signal Protocol** (Curve25519 + HMAC-SHA256 + Double Ratchet):

### Key Exchange on First Message

```
Alice generates: identity_key (long-term), ephemeral_key (per-session)
Bob generates:   identity_key (long-term), ephemeral_key (per-session)

1. Alice → Bob: [identity_key_A, ephemeral_key_A]
2. Bob   → Alice: [identity_key_B, ephemeral_key_B]

Both derive: shared_secret = ECDH(identity_key_A, ephemeral_key_B)
                         ⊕ ECDH(identity_key_B, ephemeral_key_A)
```

### Ratcheting: Forward Secrecy

After each message, keys evolve so compromise of current key doesn't expose past messages:

```
Ratchet state: chain_key_1 → chain_key_2 → chain_key_3 → ...
Message key_1 = HMAC(chain_key_1, "msg_key")
Message key_2 = HMAC(chain_key_2, "msg_key")
```

If someone steals Alice's phone, they can only read future messages—not past ones.

## Scaling to Millions of Connections

### The C10M Problem

A single server can handle ~1M WebSocket connections with proper tuning. Need hardware to test this? [Spin up a high-CPU cloud server on Vultr](https://www.vultr.com/?ref=8914132) and stress-test your WebSocket implementation. <!-- AFFILIATE: vultr -->

- Increase file descriptors (`ulimit -n`)
- Use `SO_REUSEPORT` for load balancing
- Tune kernel `tcp_tw_reuse`
- Use `epoll` (Linux) or `kqueue` (macOS) for event-driven I/O

### Horizontal Scaling: Connection Routing

```
                    ┌─────────────────────────────────┐
Client → DNS → LB → │  WS Gateway Pool (N instances)  │
                    │  ┌──────┐ ┌──────┐ ┌──────┐    │
                    │  │ gw-1 │ │ gw-2 │ │ gw-N │    │
                    │  └──────┘ └──────┘ └──────┘    │
                    └─────────────────────────────────┘
                              │
                        Redis Pub/Sub
                        (in-memory broker)
                              │
                    ┌─────────────────────────────────┐
                    │  Message Service (stateless)   │
                    │  ┌──────┐ ┌──────┐ ┌──────┐    │
                    │  │ msg-1│ │msg-2 │ │msg-N │    │
                    │  └──────┘ └──────┘ └──────┘    │
                    └─────────────────────────────────┘
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
         Cassandra        Cassandra        Cassandra
         Shard 0          Shard 1          Shard 2
```

The key insight: **gateways are stateful** (track connections), **message service is stateless** (just processes and stores).

## Database Sharding by User ID

Two common sharding strategies:

### Shard by Sender (Used by WhatsApp)

```python
shard = user_id % NUM_SHARDS
# All messages sent by this user are on the same shard
```

**Pros**: Read-your-own-writes consistency (all your messages on one shard)
**Cons**: Hot user problem (celebrities send 1000x more messages)

### Shard by Conversation

```python
shard = conversation_id % NUM_SHARDS
# All messages in a conversation on same shard
```

**Pros**: Efficient conversation reads (all messages on same shard)
**Cons**: If a conversation gets huge, it might exceed shard capacity

WhatsApp uses **shard by sender** with careful hot-spot mitigation (rate limiting celebrity accounts).

## The Hard Parts Nobody Talks About

1. **Duplicate delivery**: At scale, "at-least-once" delivery + client-side deduplication is cheaper than "exactly-once" delivery
2. **Tombstone management**: Deleted messages need "tombstones" in Cassandra for 30 days (hard delete = consistency nightmare)
3. **Typing indicators**: Broadcasting every keystroke is expensive; throttle to 1 update/second
4. **Media messages**: Images/videos go to object storage (S3), not Cassandra; metadata in Cassandra
5. **Multi-device sync**: If I delete a message on phone, it should delete on laptop too—this requires a sync protocol

A solid choice if you want to avoid managing infrastructure yourself. [DigitalOcean's App Platform](https://www.digitalocean.com/affiliates) handles deployment, scaling, and certificates — free tier available. <!-- AFFILIATE: digitalocean -->

## Related Posts

- [Rate Limiter System Design](/posts/rate-limiter-system-design) — Protecting APIs from abuse
- [Raft Consensus Algorithm](/posts/raft-consensus-algorithm-deep-dive) — Distributed agreement fundamentals
- [URL Shortener System Design](/posts/url-shortener-system-design) — Database sharding and Redis patterns
- [Redis Beyond Caching](/posts/redis-beyond-caching) — Redis as a primary data store

## Further Reading

- [The Secret Life of WhatsApp (HighScalability)](http://highscalability.com/blog/2022/1/11/the-secret-life-of-whatsapp.html) — Real WhatsApp architecture numbers
- [Signal Protocol Whitepaper](https://signal.org/docs/specifications/signal/) — E2E encryption in depth
- [How Discord Stores Trillions of Messages](https://discord.com/blog/how-discord-stores-trillions-of-messages) — Cassandra at scale case study

## Tools & Services

- **[Vultr](https://www.vultr.com/?ref=8914132)** — Cloud VPS for WebSocket gateways and Cassandra clusters. $100 free credit for new accounts. <!-- AFFILIATE: vultr -->
- **[DigitalOcean](https://www.digitalocean.com/affiliates)** — Simple cloud hosting for chat system prototypes. $100 free credit. <!-- AFFILIATE: digitalocean -->
