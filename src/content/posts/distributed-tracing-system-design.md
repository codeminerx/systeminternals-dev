---
title: "Distributed Tracing System Design: How to Debug Latency Across 100 Services"
description: "Design a distributed tracing system from scratch. Cover trace models, OpenTelemetry, span propagation, sampling strategies, and the architecture that makes microservices debuggable."
date: 2026-05-14
tags: ["system-design", "distributed-systems", "observability", "microservices", "opentelemetry", "tracing", "latency", "interviews"]
structuredData:
  type: "Article"
  author: "systeminternals.dev"
  datePublished: "2026-05-14"
  dateModified: "2026-05-14"
draft: false
---

When a user reports "checkout is slow," you have 100 microservices, 3 programming languages, and 4 engineers who touched checkout last week. Distributed tracing is the difference between a 2-hour incident and a 2-minute fix.

This post walks through designing a tracing system from first principles to production architecture.

## The Problem: Logs Don't Scale

Traditional debugging works for a single service:

```bash
grep "checkout" app.log | jq ".latency" | sort -n
```

But microservices kill this approach. A single user request touches:

- API Gateway → Auth Service → Cart Service → Inventory Service → Payment Service → Order Service → Email Service

When checkout is slow, you need to know: *which service?* A grep on 7 log files across 4 machines doesn't cut it.

<DistributedTracingFlow client:load />

## The Trace Model

A distributed trace is a **causal chain of events** across service boundaries.

### Three Core Concepts

**1. Trace**
The complete journey of a request from ingress to response. Every operation in a microservice architecture that contributes to handling one user request belongs to the same trace. Represented as a directed acyclic graph (DAG) of spans.

**2. Span**
A single named operation within a trace. Spans have:
- **Name**: `http.get /api/checkout` or `db.query SELECT`
- **Start time / End time**: Duration
- **Span ID**: Unique 64-bit identifier
- **Parent Span ID**: Links spans into a tree
- **Attributes**: Key-value metadata (HTTP status, DB statement, user ID)
- **Events/Logs**: Timestamp Structured log entries within the span
- **Span Kind**: `client` (outgoing call) or `server` (incoming request)

**3. Context Propagation**

The critical mechanism. When Service A calls Service B, Service A injects its span context into the HTTP/gRPC headers. Service B extracts the context and creates a child span — linking the two services causally.

```
Trace: [A-root-span] ──► [B-child-span] ──► [C-child-span]
         │                    │                    │
         └─ span-A-001         └─ span-B-002        └─ span-C-003
             parent: null         parent: A-001        parent: B-002
```

### The Three Pillars of Observability

| Pillar | What It Answers | Tool |
|--------|-----------------|------|
| **Logs** | What happened? | "NullPointerException in checkout" |
| **Metrics** | How much? How fast? | "p99 latency spiked to 2.3s" |
| **Traces** | Where in the chain? | "Payment service spans are 1.8s of the 2.1s total" |

Traces fill the gap: pinpointing *where* latency or errors occur in a distributed system.

## System Architecture

### High-Level Flow

```
Client Request
      │
      ▼
┌─────────────────┐
│  API Gateway    │  ← Creates root span (trace-id, span-id)
│  Ingress point  │    Injects trace context into headers
└────────┬────────┘
         │ HTTP with trace headers
         ▼
┌─────────────────┐
│  Checkout Svc   │  ← Receives request, extracts context
│  (Java)         │    Creates child span: checkout.validate
└────────┬────────┘
         │ gRPC call
         ▼
┌─────────────────┐     ┌─────────────────┐
│  Payment Svc    │ ──► │  Fraud Svc      │
│  (Go)           │     │  (Python)       │
└────────┬────────┘     └─────────────────┘
         │
         ▼
┌─────────────────┐
│  Data Store     │
│  (PostgreSQL)  │
└─────────────────┘
```

### Trace Collection Pipeline

**1. Instrumentation**
Services are instrumented either automatically (OpenTelemetry auto-instrumentation agents) or manually (SDK calls):

```python
from opentelemetry import trace

tracer = trace.get_tracer(__name__)

@tracer.start_as_current_span("checkout.process")
def process_checkout(cart_id: str, user_id: str):
    # This span is automatically parented to the incoming span context
    current_span = trace.get_current_span()
    current_span.set_attribute("user.id", user_id)
    current_span.set_attribute("cart.id", cart_id)
    
    with tracer.start_as_current_span("checkout.validate_cart") as span:
        span.set_attribute("cart.size", len(items))
        validate_cart(items)
    
    with tracer.start_as_current_span("checkout.call_payment") as span:
        result = payment_client.charge(user_id, total)
        span.set_attribute("payment.amount_cents", total * 100)
```

**2. Context Propagation**

The magic that links spans across services. Two standards dominate:

**W3C Trace Context** (current standard):
```
traceparent: 00-0af7651916cd43dd8448edb4c8a82a98-abcdef1234567890-01
     │          │                        │                    │
     │          │                        │                    └── trace-flags (01 = sampled)
     │          │                        └────── span-id (16 hex chars)
     │          └───────────────────────── trace-id (32 hex chars)
     └── version (00)
```

**B3 Propagation** (Zipkin legacy):
```
X-B3-TraceId: abcdef1234567890
X-B3-SpanId:  1234567890abcdef
X-B3-ParentSpanId: fedcba0987654321
X-B3-Sampled: 1
```

Propagation happens via:
- **HTTP headers**: Most common
- **gRPC metadata**: For gRPC services
- **Message queues**: Kafka headers, RabbitMQ properties
- **Database queries**: Attach span context to idempotency keys

**3. Trace Exporter**

Spans are buffered locally and exported via OTLP (OpenTelemetry Protocol) to a backend:

```python
from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor

provider = TracerProvider()
# Ship spans to OpenTelemetry Collector or Jaeger backend
exporter = OTLPSpanExporter(endpoint="otel-collector:4317", insecure=True)
provider.add_span_processor(BatchSpanProcessor(exporter))
trace.set_tracer_provider(provider)
```

**4. Trace Backend**

Centralized store for all traces. Options:

| Backend | Best For | Strengths | Weaknesses |
|---------|----------|-----------|-----------|
| **Jaeger** | Self-hosted | CNCF, mature, strong UI | Operational overhead |
| **Zipkin** | Simpler setups | Lightweight, simple | Less feature-rich |
| **GCP Trace** | GCP workloads | Native BigQuery export | Vendor lock-in |
| **AWS X-Ray** | AWS workloads | Lambda integration | Limited controls |
| **Tempo (Grafana)** | Metrics+Tracing | Unified Grafana stack | Newer |

**5. Storage Architecture**

Traces are write-heavy (millions per second) and read-light (debugging sessions). Typical stack:

```
Ingest: Services → OTLP → OpenTelemetry Collector
              │
              ├──► Kafka (buffer for burst absorption)
              │
              ▼
         Trace Processor (aggregation, tag enrichment)
              │
              ├──► Jaeger Collector → Elasticsearch → Jaeger UI
              │
              └──► Tempo → Object Storage (S3/GCS) → Grafana
```

For cost efficiency at scale, traces are often stored in columnar formats (Parquet on S3) and only indexed by trace-id and timestamp. Full-text search of span attributes uses Elasticsearch.

## Sampling: The Key to Cost Control

At Netflix scale, a single service handles 50,000 requests/second. With 100 spans per request, that's **5 million spans per second**. Storing all of them is economically impossible.

### Sampling Strategies

**Head-Based Sampling** (decide at request start):
- Sampler makes the sampling decision at the *root span* before any work is done
- Simple: `if random() < 0.01: trace else: skip`
- Problem: you might miss the one slow request (because you sampled based on the start, not the outcome)

**Tail-Based Sampling** (decide after the trace completes):
- Buffer all spans in Kafka
- Processor examines the completed trace
- Sample if: latency > 1s, error occurred, or specific user/service
- Problem: requires buffering infrastructure

```python
# Tail-based sampler in Python
class TailSamplingProcessor:
    def __init__(self, rules: list[TailRule]):
        self.rules = rules  # [(condition, sample_rate)]
    
    def should_sample(self, trace: Trace) -> bool:
        for condition, rate in self.rules:
            if condition(trace):
                return random() < rate
        return False  # default: don't sample

# Example rules
rules = [
    (lambda t: t.duration_ms > 1000, 1.0),      # Always sample slow traces
    (lambda t: t.has_error, 1.0),                # Always sample error traces
    (lambda t: t.service == "checkout", 0.1),   # 10% of checkout traces
    (lambda _: True, 0.01),                      # 1% of everything else
]
```

**Probabilistic with Error Bias** (practical middle ground):
- 1% of all traces sampled by default
- 100% of traces with errors always sampled
- 100% of traces over p99 threshold always sampled

## Service Map and Dependency Analysis

Beyond individual traces, aggregating spans across millions of requests reveals the **service graph** — which services call which, and how frequently:

```
     ┌──────────────────────────────────────┐
     │         Checkout Flow                │
     │  (aggregated from 1M traces)         │
     └──────────────────────────────────────┘
                         │
          ┌──────────────┼──────────────┐
          │              │              │
          ▼              ▼              ▼
    ┌──────────┐  ┌───────────┐  ┌───────────┐
    │  Cart    │  │ Inventory │  │  Payment  │
    │  12ms     │  │  8ms      │  │  180ms    │
    │  99.9% OK │  │  99.9% OK │  │  99.7% OK │
    └──────────┘  └───────────┘  └───────────┘
                                              │
                           ┌──────────────────┤
                           ▼                  ▼
                     ┌───────────┐       ┌──────────┐
                     │   Fraud   │       │   Bank   │
                     │   45ms    │       │  120ms   │
                     │  99.95%   │       │  99.99%  │
                     └───────────┘       └──────────┘
```

This service map reveals:
- **Payment is the bottleneck** (180ms, 0.3% errors)
- **Fraud service adds 45ms** to payment flow
- **Cart is fast** (12ms, low error rate)

## OpenTelemetry: The Standard That Won

Before OpenTelemetry (OTel), every vendor had their own instrumentation SDK:

- Datadog APM: `ddtrace` library
- New Relic: `newrelic` library  
- Jaeger: `jaeger-client` library

Switching vendors meant re-instrumenting every service. OTel's brilliance: **vendor-neutral instrumentation**:

```python
# Instrument once with OTel, export anywhere
from opentelemetry.sdk.resources import Resource
from opentelemetry.semconv.resource import ServiceConstants

resource = Resource.create({
    ServiceConstants.SERVICE_NAME: "checkout-service",
    ServiceConstants.SERVICE_VERSION: "2.4.1",
    "deployment.environment": "production",
})

# Swap exporters without changing instrumentation code
provider = TracerProvider(resource=resource)

# Ship to Jaeger
provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter(
    endpoint="http://jaeger:4317", insecure=True
)))

# Or switch to Tempo/Grafane with zero code changes
provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter(
    endpoint="http://tempo:4317", insecure=True
)))
```

OTel also standardized the data model: trace events, metric instruments, and log records all share a common semantic conventions library. This is why Grafana can now query traces from Jaeger, Tempo, X-Ray, and Honeycomb in the same panel.

## Common Pitfalls

**1. Missing spans on async operations**
Thread pools, message queues, and cron jobs are invisible to incoming HTTP header propagation. Always explicitly pass span context:

```python
# Bad: context lost in thread pool
def background_task():
    process_order(order_id)  # No span!

# Good: explicit context propagation
def background_task(trace_context: dict):
    with tracer.start_as_current_span(
        "background.process_order",
        context=extract_context(trace_context)  # Restore parent context
    ):
        process_order(order_id)
```

**2. Cardinality explosions**
Don't put user IDs, email addresses, or order IDs directly in span attributes — you'll create billions of unique time-series. Instead:
- Use `user.type: "premium"` not `user.id: "abc123"`
- Use `order.region: "us-west"` not `order.id: "ORD-12345"`
- For high-cardinality data, write to logs, not span attributes

**3. Context propagation between microservices and databases**
When your service calls PostgreSQL, the database driver creates an internal span. But the SQL statement text in the span attribute is a PII risk. Use `db.system: "postgresql"` for the driver attribute and scrub statement content:

```python
span.set_attribute("db.system", "postgresql")
span.set_attribute("db.name", "checkout")
# DO NOT: span.set_attribute("db.statement", "SELECT * FROM users WHERE email='...'")
```

## Production Deployment Checklist

- [ ] Auto-instrument all HTTP/gRPC ingress points
- [ ] Manual spans on critical business logic (checkout, payment, signup)
- [ ] Error spans include stack traces and exception messages
- [ ] Tail sampling keeps 100% of error traces
- [ ] Trace context propagates through Kafka/SQS message headers
- [ ] Service-level SLO dashboards using trace aggregation
- [ ] P99/p95 latency SLIs by service from trace data
- [ ] Span cardinality audits (prevent metric explosion)
- [ ] OpenTelemetry Collector runs as sidecar or daemonset
- [ ] Trace data retention: hot storage 7 days, cold storage 90 days

## The Tracing Revolution

Before distributed tracing, debugging microservices was archaeology — grep through logs, guess, restart services, repeat.

Tracing made it science. The causal chain from root span to leaf span shows exactly where time is spent, where errors occur, and which service is responsible. Combined with OpenTelemetry's vendor-neutral standard, your teams instrument once and iterate on observability backends without re-writing instrumentation.

The next time a user reports "checkout is slow," you open Grafana, filter to `service.name=checkout AND duration > 1s`, and within 30 seconds you know: the payment service's call to the bank API is averaging 180ms with 0.3% timeouts. Fixed.

That's the power of distributed tracing.

---

## Related Posts

- [Rate Limiter System Design](/posts/rate-limiter-system-design) — Redis patterns for protecting tracing-observable services
- [Database Sharding System Design](/posts/database-sharding-system-design) — tracing across sharded database nodes
- [Chat Messaging System Design](/posts/chat-messaging-system-design) — real-time spans and message queue tracing
- [Kubernetes Architecture Deep Dive](/posts/kubernetes-architecture-deep-dive) — tracing in container environments with eBPF