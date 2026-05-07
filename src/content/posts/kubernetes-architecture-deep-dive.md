---
title: "Kubernetes Architecture Deep Dive: How Container Orchestration Actually Works"
description: "A technical deep dive into Kubernetes architecture—control plane, etcd, scheduler, kubelet, pod lifecycle, networking, and how all the components work together to orchestrate containers at scale."
date: 2026-05-06
tags: ["kubernetes", "kubernetes-architecture", "container-orchestration", "devops", "distributed-systems", "etcd", "scheduler", "pods", "cloud-native", "k8s"]
draft: false
---

Every major cloud-native deployment in 2026 runs on Kubernetes. Yet most engineers know Kubernetes only as "that YAML thing that runs Docker containers." The reality is far more interesting: a distributed system of API servers, schedulers, etcd clusters, and kubelet agents that together form the world's most popular container orchestration platform.

This post dissects Kubernetes from the inside—how the control plane works, how the scheduler decides where pods run, how kubelet keeps containers alive, and how the networking model enables service discovery across a distributed cluster.

## What Kubernetes Is Actually Doing

When you deploy an application to Kubernetes, you're interacting with a complex distributed system:

```
You (kubectl) → API Server → etcd → Scheduler → Kubelet → Container Runtime
                    ↑
              (all control loop decisions flow through here)
```

The fundamental model is a **control loop**: watch the desired state, compare to actual state, take action to reconcile differences. This pattern repeats at every layer—from the API server watching etcd, to the scheduler watching unscheduled pods, to kubelet watching container state.

## The Control Plane: Where Decisions Happen

The Kubernetes control plane is the "brain" of the cluster—a set of components that accept your desired state and work to make it happen.

<KubernetesArchitecture client:load />

### API Server: The Front Door

The `kube-apiserver` is the central hub. Every kubectl command, every dashboard request, every pod spec change flows through it:

```bash
# What kubectl actually does
kubectl apply -f deployment.yaml
    ↓
POST /api/v1/namespaces/default/deployments
    ↓
kube-apiserver validates → writes to etcd → returns Deployment object
    ↓
All other control plane components watch the API server for changes
```

The API server is the only component that talks to etcd directly. The scheduler, kubelet, and controller managers all communicate through the API server's watch interface. This design means:

- **etcd never receives direct requests from workers** — security boundary
- **The API server is the single source of truth** — no conflicting state
- **All state changes are audited** — every write goes through one component

The API server uses **etcd watch** to notify all clients of changes. When you create a Deployment, the API server writes it to etcd, then notifies all watching clients (scheduler, controller-manager) via the watch stream.

### etcd: The Cluster's Memory

etcd stores all cluster state in a distributed, Raft-replicated key-value store. If the API server is the brain, etcd is the memory—every piece of configuration, every pod status, every Deployment spec lives here.

```bash
# Inspect etcd directly (what's actually stored)
ETCDCTL_API=3 etcdctl get /registry/ --prefix | head -50

# See cluster health
kubectl get etcd -n kube-system
```

**What etcd stores:**

| Key Pattern | Value |
|-------------|-------|
| `/registry/pods/*` | Pod specs and status |
| `/registry/deployments/*` | Deployment specs |
| `/registry/nodes/*` | Node specs and conditions |
| `/registry/services/*` | Service definitions |
| `/registry/configmaps/*` | ConfigMap data |

Each key encodes the full resource path—namespaces are part of the key, not a field. This flat structure makes watch queries efficient.

**Replication:** etcd uses Raft (as covered in our [Raft deep dive](/posts/raft-consensus-algorithm-deep-dive)) to replicate data across all control plane nodes. A 3-node etcd cluster tolerates 1 failure; a 5-node cluster tolerates 2.

### Scheduler: Where Pods Get Placed

The `kube-scheduler` watches for unscheduled pods—pods with no `spec.nodeName` set—and assigns them to nodes. The decision process:

```
1. Filtering: Can this pod run on this node?
   - Does the node have enough CPU/memory?
   - Does the pod have node affinity/anti-affinity rules?
   - Are there taints/tolerations that prevent placement?
   - Are there topology constraints (zone, region)?

2. Scoring: Among eligible nodes, which is best?
   - Least requested resources (spread load)
   - Node affinity weights
   - Pod affinity/anti-affinity (keep related pods together or apart)
   - Data locality (prefer nodes with local volumes)

3. Binding: Assign the pod to the winning node
   - Update pod.spec.nodeName via API server
   - Kubelet on the target node sees the assignment and starts containers
```

```yaml
# Pod spec that demonstrates scheduling features
apiVersion: v1
kind: Pod
metadata:
  name: web-server
spec:
  # Node selector - simplest placement constraint
  nodeSelector:
    disktype: ssd
  
  # Tolerations - work around node taints
  tolerations:
  - key: "node.kubernetes.io/disk-pressure"
    operator: "Exists"
    effect: "NoSchedule"
  
  # Affinity - keep this pod near its database
  affinity:
    podAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
      - labelSelector:
          matchLabels:
            app: postgres
        topologyKey: "kubernetes.io/hostname"
  
  containers:
  - name: nginx
    image: nginx:latest
    resources:
      requests:
        memory: "64Mi"
        cpu: "250m"
      limits:
        memory: "128Mi"
        cpu: "500m"
```

**Multi-level scheduling:** The scheduler isn't one algorithm—it's a pluggable pipeline. You can write custom scheduler plugins that run at specific points in the scheduling cycle. Kubernetes' `kube-scheduler` itself is composed of plugins (NodeResources, NodeAffinity, PodTopologySpread, etc.).

### Controller Manager: Running the Reconciliation Loops

The `kube-controller-manager` runs controller loops—each controller is a reconciliation loop that drives actual state toward desired state:

| Controller | What It Reconciles |
|------------|--------------------|
| **ReplicaSet** | Pod count matches desired replicas |
| **Deployment** | ReplicaSet version matches desired version |
| **StatefulSet** | Pods have stable network identity, persistent storage |
| **Job/CronJob** | Jobs complete; CronJobs schedule on time |
| **Endpoint** | Service selectors match pod IPs |
| **ServiceAccount** | Service accounts have proper RBAC |

Each controller watches its resource type via the API server. When the desired state diverges from actual state, the controller takes action—creating pods, updating ReplicaSets, patching services.

### Cloud Controller Manager: Cloud-Specific Logic

For managed Kubernetes (EKS, GKE, AKS), the cloud controller manager handles cloud-specific reconciliation:

- **Node controller**: Detects node failures, provisions cloud instances
- **Route controller**: Sets up cloud routing tables for pod networking
- **Service controller**: Creates cloud load balancers for Services of type LoadBalancer

This separation means the core Kubernetes code doesn't need cloud-provider-specific logic.

## Kubelet: The Node Agent

Every node in a Kubernetes cluster runs `kubelet`—the agent that communicates between the API server and the container runtime.

```
API Server (desired state)
    ↓ watch /pods
kubelet
    ↓  sync pod
container runtime (Docker, containerd, CRI-O)
    ↓ create
containers
```

### Pod Lifecycle

Pods go through a defined lifecycle:

```
Pending → Running → Succeeded/Failed
    ↓         ↓
  (scheduled) (containers running)
```

**Pod phases:**

| Phase | Meaning |
|-------|---------|
| `Pending` | Pod accepted, waiting for scheduler + image pull |
| `Running` | At least one container running (starting/restarting/running) |
| `Succeeded` | All containers exited successfully |
| `Failed` | At least one container exited with failure |
| `Unknown` | Node communication lost |

**Init containers** run before the main containers, guaranteeing the main containers don't start until prerequisites are met:

```yaml
spec:
  initContainers:
  - name: wait-for-db
    image: busybox:1.36
    command: ['sh', '-c', 'until nc -z db:5432; do echo waiting; sleep 2; done']
  
  containers:
  - name: app
    image: myapp:latest
```

### Probe Types

Kubelet continuously checks container health via probes:

```yaml
spec:
  containers:
  - name: api
    image: myapi:latest
    
    # Does the process exist? (lowest level)
    livenessProbe:
      exec:
        command: ['cat', '/tmp/healthy']
      initialDelaySeconds: 5
      periodSeconds: 10
    
    # Does it respond to HTTP?
    readinessProbe:
      httpGet:
        path: /healthz
        port: 8080
      initialDelaySeconds: 3
      periodSeconds: 5
    
    # Does the container handle SIGTERM gracefully?
    startupProbe:
      httpGet:
        path: /started
        port: 8080
      failureThreshold: 30
      periodSeconds: 10
```

Failed probes trigger kubelet to restart containers or remove pods from Service endpoints.

## Container Runtime: Under the Hood

Kubernetes doesn't run containers itself—it delegates to a **Container Runtime Interface (CRI)** implementation:

```
kubelet
    ↓ CRI API (gRPC)
containerd (or Docker, CRI-O)
    ↓ OCI image + runtime spec
runc → namespaces + cgroups → containers
```

**containerd** is the most common runtime in 2026. It handles:

- Image management (pull, unpack, cache)
- Container lifecycle (create, start, stop, delete)
- Storage (layer management, snapshot)
- Networking (via CNI plugins)

**OCI Runtime** (`runc`) takes the container bundle and actually creates the Linux namespaces (PID, network, mount, IPC) and cgroups (CPU, memory, I/O limits).

```bash
# What kubelet actually does for a pod
# 1. Pull images
crictl pull nginx:latest

# 2. Create container (with config.json)
crictl create <pod-sandbox-id> config.json image.json

# 3. Start container
crictl start <container-id>

# 4. Report status to API server
```

## Networking: How Pods Talk to Each Other

Kubernetes networking has three fundamental requirements:

1. **Pod-to-pod**: Any pod can talk to any other pod (no NAT)
2. **Pod-to-service**: Pods can reach Services via clusterIP (virtual IP)
3. **External-to-service**: External clients can reach Services

### CNI: The Plugin Model

Kubernetes delegates networking to **CNI (Container Network Interface)** plugins. The common ones:

| Plugin | Model |
|--------|-------|
| **Calico** | BGP routes, policy-based |
| **Cilium** | eBPF-based, transparent encryption |
| **Flannel** | VXLAN overlay, simple |
| **Weave** | sleeve fast-path, policy |

When kubelet creates a pod, it calls the CNI plugin to set up networking:

```bash
# CNI configuration (typical Calico)
cat /etc/cni/net.d/10-calico.conflist
{
  "cniVersion": "0.3.1",
  "name": "k8s-pod-network",
  "plugins": [
    {
      "type": "calico",
      "ipam": { "type": "calico-ipam" }
    },
    {
      "type": "portmap",
      "capabilities": {"portMappings": true}
    }
  ]
}
```

### Pod Networking Model

Each pod gets its own **IP address** (unique in the cluster):

```
Pod A (10.244.1.15) → veth0 → eth0 (host) → CNI bridge → eth0 (host) → Pod B (10.244.2.8)
```

The CNI bridge (often called `cni0` or `br0`) connects pod veth pairs. Traffic between pods on the same node stays on the bridge; traffic to other nodes routes via the pod's routing table.

### Services: Virtual IPs for Stable Endpoints

Services provide a stable virtual IP that load-balances to backing pods:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: web-service
spec:
  selector:
    app: web
  ports:
  - port: 80        # Service port
    targetPort: 8080  # Container port
  type: ClusterIP   # Internal only
```

**kube-proxy** watches for Service changes and updates iptables/ipvs rules on each node:

```
# What kube-proxy actually installs on each node
-A KUBE-SVC-XXXXXXXX -p tcp -m tcp --dport 80 \
  -j KUBE-SEP-XXXXXXXX   # DNAT to pod IP

-A KUBE-SEP-XXXXXXXX -s 10.244.1.15 -m comment --comment "web-service" \
  -j ACCEPT           # Allow traffic to pod
```

When you call `web-service:80`, the packet:
1. Matches the Service's iptables rule
2. DNATs to a randomly selected pod IP
3. Routes normally (pod-to-pod networking)

### DNS: Service Discovery

CoreDNS provides cluster-wide DNS. Every Service gets a DNS name:

```bash
# Service discovery
web-service.default.svc.cluster.local
web-service.default.svc
web-service.default

# Headless Service (for pod discovery)
mysql-headless.default.svc.cluster.local → 10.244.1.15, 10.244.2.20, ...
```

CoreDNS watches the API server for Service and Endpoint changes, keeping DNS records current as pods come and go.

## Storage: Volumes and Persistence

Kubernetes abstracts storage through the **Container Storage Interface (CSI)**:

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: mysql-data
spec:
  accessModes:
    - ReadWriteOnce      # Single node r/w
  storageClassName: fast-ssd
  resources:
    requests:
      storage: 50Gi
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: mysql
spec:
  template:
    spec:
      containers:
      - name: mysql
        volumeMounts:
        - name: mysql-data
          mountPath: /var/lib/mysql
      volumes:
      - name: mysql-data
        persistentVolumeClaim:
          claimName: mysql-data
```

**Volume lifecycle:**

| Type | Lifecycle | Use Case |
|------|-----------|----------|
| **emptyDir** | Pod lifetime | Temporary scratch space |
| **hostPath** | Node lifetime | Node-specific access |
| **PersistentVolumeClaim** | Independent | Database storage |
| **ConfigMap/Secret** | Independent | Configuration injection |

CSI drivers (AWS EBS CSI, GCE PD CSI, etc.) handle provisioning, attachment, and mounting when PVCs are bound to PVs.

## Authentication and Authorization

Every request to the API server goes through authentication, authorization, and admission control:

```
Request → AuthN (who are you?) → AuthZ (what can you do?) → Admission (mutate/validate) → etcd
```

### Authentication

Multiple authenticator plugins; common ones:

```bash
# Static tokens (not for production)
--token-auth-file=/var/run/secrets/token.csv

# Bootstrap tokens (for new nodes)
kubectl get secrets -n kube-system | grep bootstrap

# x509 client certificates (most common for users)
# Certificate issued by the cluster CA
openssl x509 -in user.crt -text -noout | grep Subject

# Service account tokens (for pods)
# Automatically mounted at /var/run/secrets/kubernetes.io/serviceaccount/
```

### RBAC (Role-Based Access Control)

```yaml
# Role (namespace-scoped)
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  namespace: default
rules:
- apiGroups: [""]
  resources: ["pods"]
  verbs: ["get", "list", "watch"]

---
# RoleBinding (grant role to user)
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: read-pods
  namespace: default
subjects:
- kind: User
  name: jane@example.com
roleRef:
  kind: Role
  name: read-pods
```

### Admission Controllers

Admission controllers intercept requests after AuthN/AuthZ:

```bash
# Enabled admission controllers
--enable-admission-plugins=\
  NamespaceLifecycle,\
  LimitRanger,\
  ServiceAccount,\
  DefaultStorageClass,\
  PersistentVolumeClaimResize,\
  MutatingAdmissionWebhook,\
  ValidatingAdmissionWebhook
```

Common patterns:
- **LimitRanger**: Enforce resource limits on pods
- **DefaultStorageClass**: Set default StorageClass for PVCs
- **MutatingWebhook**: Inject sidecars, set defaults

## Networking in Production: Ingress and Load Balancing

External traffic enters the cluster through:

### Ingress Controller

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: web-ingress
  annotations:
    nginx.ingress.kubernetes.io/rewrite-target: /
spec:
  rules:
  - host: myapp.example.com
    http:
      paths:
      - path: /api
        pathType: Prefix
        backend:
          service:
            name: api-service
            port:
              number: 80
      - path: /
        pathType: Prefix
        backend:
          service:
            name: frontend-service
            port:
              number: 80
```

The Ingress controller (nginx, Contour, Ambassador) watches Ingress resources and configures the ingress proxy accordingly.

### MetalLB: Load Balancing Without Cloud

For bare-metal clusters, MetalLB announces service IPs via ARP/NDP or BGP:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: my-service
spec:
  type: LoadBalancer   # MetalLB handles this on bare-metal
  selector:
    app: myapp
  ports:
  - port: 80
    targetPort: 8080
```

MetalLB assigns an IP from a pool and responds to ARP requests, making the service reachable externally.

## Production Patterns

### Horizontal Pod Autoscaler (HPA)

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: web-hpa
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: web
  minReplicas: 3
  maxReplicas: 100
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70
```

The HPA controller polls metrics every 15 seconds (configurable), scaling pods based on observed utilization vs target.

### Pod Disruption Budget (PDB)

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: web-pdb
spec:
  minAvailable: 2   # At least 2 pods always available
  # OR maxUnavailable: 1 (only 1 pod down at a time during disruptions)
  selector:
    matchLabels:
      app: web
```

PDB ensures voluntary disruptions (node drain, upgrades) don't take down too many pods simultaneously.

### Resource Quotas and LimitRanges

```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: default-quota
spec:
  hard:
    requests.cpu: "10"
    requests.memory: 20Gi
    limits.cpu: "20"
    limits.memory: 40Gi
    pods: "50"
---
apiVersion: v1
kind: LimitRange
metadata:
  name: default-limits
spec:
  limits:
  - type: Container
    default:
      cpu: 500m
      memory: 256Mi
    defaultRequest:
      cpu: 100m
      memory: 64Mi
```

Without LimitRange, pods with no resource requests can starve other tenants.

## The Big Picture

Kubernetes is a distributed system built on four principles:

1. **Declarative configuration**: You describe desired state; Kubernetes reconciles
2. **Control loops**: Every component is a reconciliation loop watching for drift
3. **Loose coupling**: Components communicate only through the API server
4. **Scalability**: All components are horizontally scalable (except etcd)

The control plane (API server, etcd, scheduler, controller-manager) coordinates work. Need compute resources to practice? [Vultr's high-memory instances](https://www.vultr.com/?ref=8914132) are ideal for etcd and control plane components. <!-- AFFILIATE: vultr -->
 The data plane (kubelet, container runtime, CNI) executes it. The result is a system that can recover from node failures, scale workloads across hundreds of machines, and provide the self-healing capabilities that make containers practical for production.

Building a production cluster? [Vultr](https://www.vultr.com/?ref=8914132) offers high-memory instances ideal for Kubernetes control plane components, and [DigitalOcean](https://www.digitalocean.com/affiliates) provides managed Kubernetes if you want zero operational overhead. <!-- AFFILIATE: vultr digitalocean -->

---

**Next:** [Paxos Consensus Algorithm Deep Dive](/posts/paxos-consensus-algorithm-deep-dive) → for more distributed systems theory
**Previous:** [Raft Consensus Algorithm](/posts/raft-consensus-algorithm-deep-dive) → for the consensus algorithm Kubernetes uses internally

---

**External Resources**

- [Kubernetes Documentation](https://kubernetes.io/docs/) — The official reference
- [Kubernetes The Hard Way (Kelsey Hightower)](https://github.com/kelseyhightower/kubernetes-the-hard-way) — Build a cluster from scratch to understand every component
- [etcd Documentation](https://etcd.io/docs/) — The consistency backend
- [CNCF Landscape](https://landscape.cncf.io/) — The broader cloud-native ecosystem

## Tools & Services

- **[Vultr](https://www.vultr.com/?ref=8914132)** — Cloud VPS for Kubernetes worker nodes and development clusters. $100 free credit for new accounts. <!-- AFFILIATE: vultr -->
- **[DigitalOcean](https://www.digitalocean.com/affiliates)** — Managed Kubernetes service, zero ops overhead. $100 free credit. <!-- AFFILIATE: digitalocean -->
