import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type Dispatch, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject, type SetStateAction } from "react";
import { createPortal } from "react-dom";
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Cloud,
  Copy,
  FileCode2,
  FolderOpen,
  Layers3,
  ListFilter,
  LoaderCircle,
  Maximize2,
  Minimize2,
  Minus,
  Network,
  PanelLeftClose,
  PanelLeftOpen,
  Pause,
  Play,
  RefreshCw,
  Search,
  Server,
  TerminalSquare,
  X,
} from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import {
  errorFrom,
  kubernetes,
  type ConnectionInfo,
  type DeploymentSummary,
  type StatefulSetSummary,
  type ServiceSummary,
  type IngressSummary,
  type EventSummary,
  type InfraError,
  type KubernetesContext,
  type NamespaceInfo,
  type PodSummary,
  type ResourceKind,
  type ResourceSummary,
  type ResourceWatchMessage,
} from "./lib/kubernetes";

type Section = "overview" | "workloads" | "network";
type Kind = "pod" | "deployment" | "statefulset" | "service" | "ingress";
type DetailTab = "summary" | "pods" | "events" | "logs" | "yaml";
type Selection = { kind: Kind; name: string; namespace: string };
type LoadState = "loading" | "ready" | "error";
type WatchStatus = "live" | "reconnecting" | "stale" | "polling";

const LAST_NAMESPACE_PREFIX = "infra.namespace.";

function formatAge(date?: string): string {
  if (!date) return "—";
  const elapsed = Date.now() - new Date(date).getTime();
  if (!Number.isFinite(elapsed) || elapsed < 0) return "—";
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  return `${Math.floor(days / 30)}mo`;
}

function podHealthy(pod: PodSummary): boolean {
  return pod.status === "Running" && pod.readyContainers === pod.totalContainers;
}

function deploymentHealthy(deployment: DeploymentSummary): boolean {
  return deployment.ready >= deployment.desired && deployment.available >= deployment.desired;
}

function eventsNewestFirst(items: EventSummary[]): EventSummary[] {
  return [...items].sort((left, right) => {
    const leftTime = Date.parse(left.lastSeen ?? "") || 0;
    const rightTime = Date.parse(right.lastSeen ?? "") || 0;
    return rightTime - leftTime;
  });
}

function updateWatchedList<T extends { name: string; namespace: string }>(items: T[], message: ResourceWatchMessage): T[] {
  if (message.action === "snapshot") return (message.resources ?? []) as unknown as T[];
  if (message.action === "delete") return items.filter((item) => item.name !== message.name || item.namespace !== message.namespace);
  if (message.action !== "upsert" || !message.resource) return items;
  const resource = message.resource as unknown as T;
  const index = items.findIndex((item) => item.name === resource.name && item.namespace === resource.namespace);
  if (index < 0) return [...items, resource];
  const next = [...items];
  next[index] = resource;
  return next;
}

function selectedResourceIn(message: ResourceWatchMessage, selection: Selection): ResourceSummary | null {
  if (message.kind !== selection.kind) return null;
  if (message.action === "upsert") {
    const resource = message.resource;
    return resource?.name === selection.name && resource.namespace === selection.namespace ? resource : null;
  }
  if (message.action === "snapshot") return message.resources?.find((item) => item.name === selection.name && item.namespace === selection.namespace) ?? null;
  return null;
}

function statusTone(status: string): "good" | "bad" | "muted" {
  if (["Running", "Healthy", "Active"].includes(status)) return "good";
  if (["Pending", "Unknown"].includes(status)) return "muted";
  return "bad";
}

function isRuntimeAvailable(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

export default function App() {
  const [section, setSection] = useState<Section>("overview");
  const [contexts, setContexts] = useState<KubernetesContext[]>([]);
  const [activeContext, setActiveContext] = useState<ConnectionInfo | null>(null);
  const [namespaces, setNamespaces] = useState<NamespaceInfo[]>([]);
  const [namespace, setNamespace] = useState("all");
  const [pods, setPods] = useState<PodSummary[]>([]);
  const [deployments, setDeployments] = useState<DeploymentSummary[]>([]);
  const [statefulSets, setStatefulSets] = useState<StatefulSetSummary[]>([]);
  const [services, setServices] = useState<ServiceSummary[]>([]);
  const [ingresses, setIngresses] = useState<IngressSummary[]>([]);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [detailTab, setDetailTab] = useState<DetailTab>("summary");
  const [detailPod, setDetailPod] = useState<PodSummary | null>(null);
  const [detailDeployment, setDetailDeployment] = useState<DeploymentSummary | null>(null);
  const [detailStatefulSet, setDetailStatefulSet] = useState<StatefulSetSummary | null>(null);
  const [detailService, setDetailService] = useState<ServiceSummary | null>(null);
  const [detailIngress, setDetailIngress] = useState<IngressSummary | null>(null);
  const [logPodName, setLogPodName] = useState("");
  const [relatedPods, setRelatedPods] = useState<PodSummary[]>([]);
  const [events, setEvents] = useState<EventSummary[]>([]);
  const [eventsError, setEventsError] = useState<InfraError | null>(null);
  const [yaml, setYaml] = useState("");
  const [yamlError, setYamlError] = useState<InfraError | null>(null);
  const [relatedError, setRelatedError] = useState<InfraError | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [logContainer, setLogContainer] = useState("");
  const [logSearch, setLogSearch] = useState("");
  const [showLogTimestamps, setShowLogTimestamps] = useState(false);
  const [logPaused, setLogPaused] = useState(false);
  const [loadState, setLoadState] = useState<LoadState>("ready");
  const [detailState, setDetailState] = useState<LoadState>("loading");
  const [error, setError] = useState<InfraError | null>(null);
  const [listErrors, setListErrors] = useState<Partial<Record<ResourceKind, InfraError>>>({});
  const [detailError, setDetailError] = useState<InfraError | null>(null);
  const [query, setQuery] = useState("");
  const [kindFilter, setKindFilter] = useState<"all" | Kind>("all");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarContentVisible, setSidebarContentVisible] = useState(true);
  const [contextMenuOpen, setContextMenuOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [windowMaximized, setWindowMaximized] = useState(false);
  const [detailWidth, setDetailWidth] = useState(480);
  const [detailExpanded, setDetailExpanded] = useState(false);
  const [detailResizing, setDetailResizing] = useState(false);
  const [renderedSelection, setRenderedSelection] = useState<Selection | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [windowVisible, setWindowVisible] = useState(document.visibilityState === "visible");
  const [watchStatuses, setWatchStatuses] = useState<Partial<Record<ResourceKind, WatchStatus>>>({});
  const [watchIssues, setWatchIssues] = useState<Partial<Record<ResourceKind, string>>>({});
  const [yamlRevision, setYamlRevision] = useState(0);
  const requestId = useRef(0);
  const detailRequestId = useRef(0);
  const watchSubscription = useRef<string | null>(null);
  const eventSubscription = useRef<string | null>(null);
  const selectedRef = useRef<Selection | null>(null);
  const renderedSelectionRef = useRef<Selection | null>(null);
  const logStreamId = useRef<string | null>(null);
  const loadedDetailKey = useRef<string | null>(null);
  const logPane = useRef<HTMLDivElement>(null);
  const contextMenu = useRef<HTMLDivElement>(null);
  const detailResize = useRef<{ pointerId: number } | null>(null);
  selectedRef.current = selection;

  useEffect(() => {
    if (!sidebarCollapsed) { setSidebarContentVisible(true); return; }
    setContextMenuOpen(false);
    const timer = window.setTimeout(() => setSidebarContentVisible(false), 220);
    return () => window.clearTimeout(timer);
  }, [sidebarCollapsed]);

  useLayoutEffect(() => {
    let frame = 0;
    let timer = 0;
    if (selection) {
      const wasClosed = !renderedSelectionRef.current;
      renderedSelectionRef.current = selection;
      setRenderedSelection(selection);
      if (wasClosed) {
        setPanelOpen(false);
        frame = window.requestAnimationFrame(() => setPanelOpen(true));
      } else setPanelOpen(true);
    } else if (renderedSelectionRef.current) {
      setPanelOpen(false);
      timer = window.setTimeout(() => {
        if (!selectedRef.current) {
          renderedSelectionRef.current = null;
          setRenderedSelection(null);
        }
      }, 260);
    }
    return () => { window.cancelAnimationFrame(frame); window.clearTimeout(timer); };
  }, [selection]);

  const loadLists = useCallback(async (activeNamespace: string, request: number) => {
    setLoadState("loading");
    setError(null);
    setListErrors({});
    try {
      const scope = activeNamespace === "all" ? null : activeNamespace;
      const results = await Promise.allSettled([
        kubernetes.pods(scope),
        kubernetes.deployments(scope),
        kubernetes.statefulSets(scope),
        kubernetes.services(scope),
        kubernetes.ingresses(scope),
      ]);
      if (request !== requestId.current) return;
      const kinds: ResourceKind[] = ["pod", "deployment", "statefulset", "service", "ingress"];
      const failures: Partial<Record<ResourceKind, InfraError>> = {};
      results.forEach((result, index) => { if (result.status === "rejected") failures[kinds[index]] = errorFrom(result.reason); });
      setListErrors(failures);
      if (results.every((result) => result.status === "rejected")) throw results[0].status === "rejected" ? results[0].reason : undefined;
      const [podsResult, deploymentsResult, statefulSetsResult, servicesResult, ingressesResult] = results;
      setPods(podsResult.status === "fulfilled" ? podsResult.value : []);
      setDeployments(deploymentsResult.status === "fulfilled" ? deploymentsResult.value : []);
      setStatefulSets(statefulSetsResult.status === "fulfilled" ? statefulSetsResult.value : []);
      setServices(servicesResult.status === "fulfilled" ? servicesResult.value : []);
      setIngresses(ingressesResult.status === "fulfilled" ? ingressesResult.value : []);
      setError(null);
      setLastUpdated(new Date());
      setLoadState("ready");
    } catch (cause) {
      if (request !== requestId.current) return;
      setError(errorFrom(cause));
      setLoadState("error");
    }
  }, []);

  const connect = useCallback(async (contextName: string, preferredNamespace?: string) => {
    const request = ++requestId.current;
    setLoadState("loading");
    setError(null);
    setSelection(null);
    setActiveContext(null);
    setPods([]);
    setDeployments([]);
    setStatefulSets([]);
    setServices([]);
    setIngresses([]);
    try {
      const connection = await kubernetes.connect(contextName);
      if (request !== requestId.current) return;
      const nextNamespaces = await kubernetes.namespaces();
      if (request !== requestId.current) return;
      setActiveContext(connection);
      setNamespaces(nextNamespaces);
      const storedNamespace = localStorage.getItem(`${LAST_NAMESPACE_PREFIX}${contextName}`);
      const proposed = preferredNamespace ?? storedNamespace ?? connection.namespace;
      const nextNamespace = proposed === "all" || nextNamespaces.some((item) => item.name === proposed)
        ? proposed
        : nextNamespaces.some((item) => item.name === connection.namespace) ? connection.namespace : "all";
      setNamespace(nextNamespace);
      localStorage.setItem(`${LAST_NAMESPACE_PREFIX}${contextName}`, nextNamespace);
      await loadLists(nextNamespace, request);
    } catch (cause) {
      if (request !== requestId.current) return;
      setError(errorFrom(cause));
      setLoadState("error");
    }
  }, [loadLists]);

  const openKubeconfig = useCallback(async () => {
    try {
      const selection = await open({
        multiple: false,
        directory: false,
        title: "Open Kubernetes config",
      });
      const path = Array.isArray(selection) ? selection[0] : selection;
      if (!path) return;

      const request = ++requestId.current;
      setLoadState("loading");
      setError(null);
      setActiveContext(null);
      setSelection(null);
      setContexts([]);
      setNamespaces([]);
      setPods([]);
      setDeployments([]);
      setStatefulSets([]);
      setServices([]);
      setIngresses([]);
      const available = await kubernetes.loadKubeconfig(path);
      if (request !== requestId.current) return;
      setContexts(available);
      if (available.length === 0) {
        setError({ kind: "kubeconfig", message: "This file has no Kubernetes contexts. Choose another kubeconfig file." });
        setLoadState("ready");
      } else {
        const context = available.find((item) => item.isCurrent) ?? available[0];
        await connect(context.name);
      }
    } catch (cause) {
      setError(errorFrom(cause));
      setLoadState("ready");
    }
  }, [connect]);

  useEffect(() => {
    if (!isRuntimeAvailable()) return;
    let cancelled = false;
    setLoadState("loading");
    void kubernetes.restoreKubeconfig().then((available) => {
      if (cancelled) return;
      setContexts(available);
      if (available.length === 0) {
        setLoadState("ready");
        return;
      }
      const context = available.find((item) => item.isCurrent) ?? available[0];
      void connect(context.name);
    }).catch((cause) => {
      if (cancelled) return;
      setError(errorFrom(cause));
      setLoadState("ready");
    });
    return () => { cancelled = true; };
  }, [connect]);

  useEffect(() => {
    if (!isRuntimeAvailable()) return;
    const currentWindow = getCurrentWindow();
    void currentWindow.isMaximized().then(setWindowMaximized).catch(() => undefined);
    const unlisten = currentWindow.onResized(() => {
      void currentWindow.isMaximized().then(setWindowMaximized).catch(() => undefined);
    });
    return () => { void unlisten.then((dispose) => dispose()); };
  }, []);

  useEffect(() => {
    if (!contextMenuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!contextMenu.current?.contains(event.target as Node)) setContextMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setContextMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [contextMenuOpen]);

  useEffect(() => {
    const updateVisibility = () => {
      setWatchStatuses({});
      setWindowVisible(document.visibilityState === "visible");
    };
    document.addEventListener("visibilitychange", updateVisibility);
    return () => document.removeEventListener("visibilitychange", updateVisibility);
  }, []);

  const watchedKinds = useMemo(() => {
    const kinds: ResourceKind[] = section === "network" ? ["service", "ingress"] : section === "workloads" ? ["pod", "deployment", "statefulset"] : ["pod", "deployment"];
    if (selection && !kinds.includes(selection.kind)) kinds.push(selection.kind);
    if (selection && ["deployment", "statefulset", "service"].includes(selection.kind) && !kinds.includes("pod")) kinds.push("pod");
    return kinds;
  }, [section, selection]);
  const watchedKindsKey = watchedKinds.join(",");

  useEffect(() => {
    if (!activeContext || loadState !== "ready" || !windowVisible) return;
    const subscriptionId = crypto.randomUUID();
    watchSubscription.current = subscriptionId;
    const kinds = watchedKindsKey.split(",") as ResourceKind[];
    setWatchStatuses({});
    setWatchIssues({});
    void kubernetes.watchResources(subscriptionId, namespace === "all" ? null : namespace, kinds, (message) => {
      if (watchSubscription.current !== subscriptionId) return;
      if (message.status) setWatchStatuses((current) => ({ ...current, [message.kind]: message.status }));
      setWatchIssues((current) => {
        if (current[message.kind] === message.error) return current;
        return { ...current, [message.kind]: message.error };
      });
      if (message.action === "state") return;
      setListErrors((current) => {
        if (!current[message.kind]) return current;
        const next = { ...current };
        delete next[message.kind];
        return next;
      });
      if (message.kind === "pod") setPods((items) => updateWatchedList(items, message));
      if (message.kind === "deployment") setDeployments((items) => updateWatchedList(items, message));
      if (message.kind === "statefulset") setStatefulSets((items) => updateWatchedList(items, message));
      if (message.kind === "service") setServices((items) => updateWatchedList(items, message));
      if (message.kind === "ingress") setIngresses((items) => updateWatchedList(items, message));
      setLastUpdated(new Date());
      const currentSelection = selectedRef.current;
      if (!currentSelection || currentSelection.kind !== message.kind) return;
      const resource = selectedResourceIn(message, currentSelection);
      if (resource) {
        if (message.kind === "pod") setDetailPod(resource as PodSummary);
        if (message.kind === "deployment") setDetailDeployment(resource as DeploymentSummary);
        if (message.kind === "statefulset") setDetailStatefulSet(resource as StatefulSetSummary);
        if (message.kind === "service") setDetailService(resource as ServiceSummary);
        if (message.kind === "ingress") setDetailIngress(resource as IngressSummary);
        setYamlRevision((revision) => revision + 1);
      } else if (message.action === "delete" && message.name === currentSelection.name && message.namespace === currentSelection.namespace || message.action === "snapshot" && !resource) {
        setDetailError({ kind: "not_found", message: "This resource no longer exists." });
        setDetailState("error");
      }
    }).catch((cause) => {
      if (watchSubscription.current !== subscriptionId) return;
      const message = errorFrom(cause).message;
      const statuses: Partial<Record<ResourceKind, WatchStatus>> = {};
      const issues: Partial<Record<ResourceKind, string>> = {};
      for (const kind of kinds) { statuses[kind] = "stale"; issues[kind] = message; }
      setWatchStatuses(statuses);
      setWatchIssues(issues);
    });
    return () => {
      if (watchSubscription.current === subscriptionId) watchSubscription.current = null;
      void kubernetes.cancelResourceWatch(subscriptionId).catch(() => undefined);
    };
  }, [activeContext, loadState, namespace, watchedKindsKey, windowVisible]);

  useEffect(() => {
    if (!activeContext || !windowVisible || !selection || detailTab !== "events" || detailState !== "ready") return;
    const subscriptionId = crypto.randomUUID();
    eventSubscription.current = subscriptionId;
    const eventKind = { pod: "Pod", deployment: "Deployment", statefulset: "StatefulSet", service: "Service", ingress: "Ingress" }[selection.kind];
    void kubernetes.watchResources(subscriptionId, selection.namespace, ["event"], (message) => {
      if (eventSubscription.current !== subscriptionId) return;
      if (message.action === "snapshot" || message.action === "upsert" || message.action === "delete") {
        setEvents((items) => eventsNewestFirst(updateWatchedList(items, message)));
        setEventsError(null);
      } else if (message.status === "stale") {
        setEventsError({ kind: "connection", message: message.error ?? "Events are not current." });
      }
    }, selection.name, eventKind).catch((cause) => {
      if (eventSubscription.current === subscriptionId) setEventsError(errorFrom(cause));
    });
    return () => {
      if (eventSubscription.current === subscriptionId) eventSubscription.current = null;
      void kubernetes.cancelResourceWatch(subscriptionId).catch(() => undefined);
    };
  }, [activeContext, detailState, detailTab, selection, windowVisible]);

  useEffect(() => {
    if (!selection) {
      loadedDetailKey.current = null;
      return;
    }
    const selectionKey = `${selection.kind}:${selection.namespace}/${selection.name}`;
    loadedDetailKey.current = null;
    const request = ++detailRequestId.current;
    setDetailState("loading");
    setDetailError(null);
    setDetailPod(null);
    setDetailDeployment(null);
    setDetailStatefulSet(null);
    setDetailService(null);
    setDetailIngress(null);
    setRelatedPods([]);
    setEvents([]);
    setEventsError(null);
    setYaml("");
    setYamlError(null);
    setRelatedError(null);
    setLogPaused(false);
    const applyCommon = (eventsResult: PromiseSettledResult<EventSummary[]>, yamlResult: PromiseSettledResult<string>) => {
      if (eventsResult.status === "fulfilled") setEvents(eventsNewestFirst(eventsResult.value));
      else setEventsError(errorFrom(eventsResult.reason));
      if (yamlResult.status === "fulfilled") setYaml(yamlResult.value);
      else setYamlError(errorFrom(yamlResult.reason));
    };
    const tasks = selection.kind === "pod"
      ? Promise.allSettled([
          kubernetes.pod(selection.name, selection.namespace),
          kubernetes.events(selection.name, selection.namespace),
          kubernetes.yaml("pod", selection.name, selection.namespace),
        ]).then(([podResult, eventsResult, yamlResult]) => {
          if (request !== detailRequestId.current) return;
          if (podResult.status === "rejected") throw podResult.reason;
          setDetailPod(podResult.value);
          setLogContainer(podResult.value.containers[0]?.name ?? "");
          setLogPodName(podResult.value.name);
          applyCommon(eventsResult, yamlResult);
        })
      : selection.kind === "deployment"
      ? Promise.allSettled([
          kubernetes.deployment(selection.name, selection.namespace),
          kubernetes.relatedPods("deployment", selection.name, selection.namespace),
          kubernetes.events(selection.name, selection.namespace),
          kubernetes.yaml("deployment", selection.name, selection.namespace),
        ]).then(([deploymentResult, podsResult, eventsResult, yamlResult]) => {
          if (request !== detailRequestId.current) return;
          if (deploymentResult.status === "rejected") throw deploymentResult.reason;
          setDetailDeployment(deploymentResult.value);
          if (podsResult.status === "fulfilled") {
            setRelatedPods(podsResult.value);
            setLogPodName(podsResult.value[0]?.name ?? "");
            setLogContainer(podsResult.value[0]?.containers[0]?.name ?? "");
          }
          else setRelatedError(errorFrom(podsResult.reason));
          applyCommon(eventsResult, yamlResult);
        })
      : selection.kind === "statefulset"
      ? Promise.allSettled([
          kubernetes.statefulSet(selection.name, selection.namespace),
          kubernetes.relatedPods("statefulset", selection.name, selection.namespace),
          kubernetes.events(selection.name, selection.namespace),
          kubernetes.yaml("statefulset", selection.name, selection.namespace),
        ]).then(([resourceResult, podsResult, eventsResult, yamlResult]) => {
          if (request !== detailRequestId.current) return;
          if (resourceResult.status === "rejected") throw resourceResult.reason;
          setDetailStatefulSet(resourceResult.value);
          if (podsResult.status === "fulfilled") {
            setRelatedPods(podsResult.value);
            setLogPodName(podsResult.value[0]?.name ?? "");
            setLogContainer(podsResult.value[0]?.containers[0]?.name ?? "");
          } else setRelatedError(errorFrom(podsResult.reason));
          applyCommon(eventsResult, yamlResult);
        })
      : selection.kind === "service"
      ? Promise.allSettled([
          kubernetes.service(selection.name, selection.namespace),
          kubernetes.relatedPods("service", selection.name, selection.namespace),
          kubernetes.events(selection.name, selection.namespace),
          kubernetes.yaml("service", selection.name, selection.namespace),
        ]).then(([resourceResult, podsResult, eventsResult, yamlResult]) => {
          if (request !== detailRequestId.current) return;
          if (resourceResult.status === "rejected") throw resourceResult.reason;
          setDetailService(resourceResult.value);
          if (podsResult.status === "fulfilled") setRelatedPods(podsResult.value);
          else setRelatedError(errorFrom(podsResult.reason));
          applyCommon(eventsResult, yamlResult);
        })
      : Promise.allSettled([
          kubernetes.ingress(selection.name, selection.namespace),
          kubernetes.events(selection.name, selection.namespace),
          kubernetes.yaml("ingress", selection.name, selection.namespace),
        ]).then(([resourceResult, eventsResult, yamlResult]) => {
          if (request !== detailRequestId.current) return;
          if (resourceResult.status === "rejected") throw resourceResult.reason;
          setDetailIngress(resourceResult.value);
          applyCommon(eventsResult, yamlResult);
        });
    void tasks.then(() => {
      if (request === detailRequestId.current) {
        loadedDetailKey.current = selectionKey;
        setDetailState("ready");
      }
    }).catch((cause) => {
      if (request !== detailRequestId.current) return;
      setDetailError(errorFrom(cause));
      setDetailState("error");
    });
    return () => {
      detailRequestId.current += 1;
      if (logStreamId.current) {
        const streamId = logStreamId.current;
        logStreamId.current = null;
        void kubernetes.cancelLogStream(streamId).catch(() => undefined);
      }
    };
  }, [selection]);

  useEffect(() => {
    if (!selection || !["deployment", "statefulset", "service"].includes(selection.kind)) return;
    const selector = selection.kind === "deployment" ? detailDeployment?.selector : selection.kind === "statefulset" ? detailStatefulSet?.selector : detailService?.selector;
    if (!selector) return;
    const labels = Object.entries(selector);
    setRelatedPods(labels.length ? pods.filter((pod) => pod.namespace === selection.namespace && labels.every(([key, value]) => pod.labels[key] === value)) : []);
  }, [detailDeployment, detailService, detailStatefulSet, pods, selection]);

  useEffect(() => {
    if (!selection || detailTab !== "yaml" || detailState !== "ready" || !activeContext) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void kubernetes.yaml(selection.kind, selection.name, selection.namespace).then((value) => {
        if (!cancelled) { setYaml(value); setYamlError(null); }
      }).catch((cause) => {
        if (!cancelled) setYamlError(errorFrom(cause));
      });
    }, 160);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [activeContext, detailState, detailTab, selection, yamlRevision]);

  useLayoutEffect(() => {
    setLogs([]);
    if (selection) {
      setLogPodName("");
      setLogContainer("");
      setDetailTab("summary");
    }
    setDetailError(null);
    if (logStreamId.current) {
      const streamId = logStreamId.current;
      logStreamId.current = null;
      void kubernetes.cancelLogStream(streamId).catch(() => undefined);
    }
  }, [selection]);

  useLayoutEffect(() => {
    setLogs([]);
    setDetailError(null);
    if (logStreamId.current) {
      const streamId = logStreamId.current;
      logStreamId.current = null;
      void kubernetes.cancelLogStream(streamId).catch(() => undefined);
    }
  }, [logPodName, logContainer]);

  const logTargetName = selection?.kind === "pod" ? detailPod?.name : relatedPods.find((item) => item.name === logPodName)?.name ?? relatedPods[0]?.name;
  const logTargetNamespace = selection?.kind === "pod" ? detailPod?.namespace : relatedPods.find((item) => item.name === logTargetName)?.namespace;

  useEffect(() => {
    if (!selection || !["pod", "deployment", "statefulset"].includes(selection.kind) || detailTab !== "logs" || detailState !== "ready" || logPaused) return;
    const selectionKey = `${selection.kind}:${selection.namespace}/${selection.name}`;
    if (loadedDetailKey.current !== selectionKey) return;
    if (!logTargetName || !logTargetNamespace) return;
    const streamId = crypto.randomUUID();
    logStreamId.current = streamId;
    void kubernetes.streamLogs(streamId, logTargetName, logTargetNamespace, logContainer || undefined, (line) => {
      if (logStreamId.current !== streamId) return;
      setLogs((existing) => [...existing.slice(-1199), line]);
    }).catch((cause) => {
      setDetailError(errorFrom(cause));
    }).finally(() => {
      if (logStreamId.current === streamId) logStreamId.current = null;
    });
    return () => {
      if (logStreamId.current === streamId) logStreamId.current = null;
      void kubernetes.cancelLogStream(streamId).catch(() => undefined);
    };
  }, [detailState, detailTab, logContainer, logPaused, logTargetName, logTargetNamespace, selection]);

  useLayoutEffect(() => {
    if (logPane.current) logPane.current.scrollTop = logPane.current.scrollHeight;
  }, [detailTab, logs, logContainer, logPodName, selection]);

  const problemPods = useMemo(() => pods.filter((pod) => !podHealthy(pod)), [pods]);
  const unhealthyDeployments = useMemo(() => deployments.filter((item) => !deploymentHealthy(item)), [deployments]);
  const refresh = () => {
    if (activeContext) void loadLists(namespace, ++requestId.current);
  };

  const chooseNamespace = (nextNamespace: string) => {
    setNamespace(nextNamespace);
    setPods([]);
    setDeployments([]);
    setStatefulSets([]);
    setServices([]);
    setIngresses([]);
    if (activeContext) {
      localStorage.setItem(`${LAST_NAMESPACE_PREFIX}${activeContext.context}`, nextNamespace);
      void loadLists(nextNamespace, ++requestId.current);
    }
    setSelection(null);
  };

  const openResource = (kind: Kind, name: string, resourceNamespace: string) => {
    setSelection({ kind, name, namespace: resourceNamespace });
  };

  const closeDetails = () => { setDetailResizing(false); setSelection(null); };

  const copyText = async (value: string) => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  };

  const switchLogStream = () => {
    if (!selection) return;
    setLogPaused((paused) => !paused);
  };

  const toggleMaximize = async () => {
    const currentWindow = getCurrentWindow();
    try {
      await currentWindow.toggleMaximize();
      setWindowMaximized(await currentWindow.isMaximized());
    } catch {
      // The native window may be closing while its controls are clicked.
    }
  };

  const beginDetailResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    detailResize.current = { pointerId: event.pointerId };
    setDetailResizing(true);
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };
  const moveDetailResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (detailResize.current?.pointerId !== event.pointerId || !event.currentTarget.parentElement) return;
    const bounds = event.currentTarget.parentElement.parentElement?.getBoundingClientRect();
    if (!bounds) return;
    setDetailWidth(Math.max(320, Math.min(1050, bounds.right - event.clientX, bounds.width - 620)));
  };
  const endDetailResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (detailResize.current?.pointerId === event.pointerId) {
      detailResize.current = null;
      setDetailResizing(false);
    }
  };
  const resizeDetailByKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      const bounds = event.currentTarget.parentElement?.parentElement?.getBoundingClientRect();
      setDetailWidth((width) => Math.max(320, Math.min(1050, (bounds?.width ?? 1670) - 620, width + (event.key === "ArrowLeft" ? 24 : -24))));
    } else if (event.key === "Home") {
      event.preventDefault();
      setDetailWidth(480);
    }
  };

  const displayContext = contexts.find((item) => item.name === activeContext?.context);
  const visibleKinds: ResourceKind[] = section === "network" ? ["service", "ingress"] : section === "workloads" ? ["pod", "deployment", "statefulset"] : ["pod", "deployment"];
  const visibleListError = visibleKinds.map((kind) => listErrors[kind]).find(Boolean) ?? error;
  const currentWatchStatuses = watchedKinds.map((kind) => watchStatuses[kind]);
  const liveState = !windowVisible || currentWatchStatuses.some((status) => status === "stale" || status === "polling") ? "Stale" : currentWatchStatuses.every((status) => status === "live") ? "Live" : "Reconnecting";
  const allHealthy = loadState === "ready" && !visibleListError && liveState === "Live" && problemPods.length === 0 && unhealthyDeployments.length === 0;
  const liveIssue = watchedKinds.map((kind) => watchIssues[kind] ? `${kind}: ${watchIssues[kind]}` : null).filter(Boolean).join("\n");

  return (
    <main className="app-frame">
      <header className="titlebar" data-tauri-drag-region>
        <div className="titlebar-brand" data-tauri-drag-region>
          <span className="brand-mark" aria-hidden="true"><Activity size={15} strokeWidth={2.2} /></span>
          <span>Infra</span>
          <span className="titlebar-divider" />
          <span className="titlebar-caption">Kubernetes workspace</span>
        </div>
        <div className="window-controls" aria-label="Window controls">
          <button aria-label="Minimize window" onClick={() => void getCurrentWindow().minimize()}><Minus size={13} /></button>
          <button aria-label={windowMaximized ? "Restore window" : "Maximize window"} onClick={toggleMaximize}>
            {windowMaximized ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
          </button>
          <button className="window-close" aria-label="Close window" onClick={() => void getCurrentWindow().close()}><X size={14} /></button>
        </div>
      </header>

      <div className="workspace">
        <aside className={`sidebar ${sidebarCollapsed ? "sidebar-collapsed" : ""} ${sidebarContentVisible ? "sidebar-content-visible" : "sidebar-compact"}`}>
          <div className={`sidebar-context ${contextMenuOpen ? "context-menu-open" : ""}`} ref={contextMenu}>
            <button
              className="context-trigger"
              type="button"
              aria-label="Choose Kubernetes context or config file"
              aria-expanded={contextMenuOpen}
              onClick={() => setContextMenuOpen((open) => !open)}
            >
              <span className="context-avatar"><Cloud size={16} /></span>
              {sidebarContentVisible && (
                <span className="context-copy">
                  <span className="eyebrow">ACTIVE CLUSTER</span>
                  <strong title={activeContext?.context ?? "No context selected"}>{activeContext?.context ?? "Not connected"}</strong>
                  <span className="context-server" title={displayContext?.server}>{displayContext?.cluster ?? "Local kubeconfig"}</span>
                </span>
              )}
              {sidebarContentVisible && <ChevronDown size={14} className="context-chevron" />}
            </button>
              <div className={`context-menu ${contextMenuOpen ? "menu-open" : ""}`} role="menu" aria-label="Kubernetes contexts" aria-hidden={!contextMenuOpen} inert={!contextMenuOpen}>
                {contexts.map((item) => (
                  <button
                    className={`context-option ${activeContext?.context === item.name ? "context-option-active" : ""}`}
                    type="button"
                    role="menuitem"
                    key={item.name}
                    title={item.name}
                    onClick={() => { setContextMenuOpen(false); void connect(item.name); }}
                  >
                    <strong>{item.name}</strong>
                    <span>{item.cluster}{item.namespace ? ` · ${item.namespace}` : ""}</span>
                  </button>
                ))}
                <button
                  className="context-menu-file"
                  type="button"
                  role="menuitem"
                  onClick={() => { setContextMenuOpen(false); void openKubeconfig(); }}
                >
                  <FolderOpen size={14} /> Open kubeconfig file
                </button>
              </div>
          </div>

          {sidebarContentVisible && <div className="nav-heading">WORKSPACE</div>}
          <nav className="primary-nav" aria-label="Main navigation">
            <button className={`nav-item ${section === "overview" ? "nav-item-active" : ""}`} onClick={() => setSection("overview")} title="Overview">
              <Activity size={16} /><span>Overview</span>
            </button>
            <button className={`nav-item ${section === "workloads" ? "nav-item-active" : ""}`} onClick={() => { setSection("workloads"); setKindFilter("all"); }} title="Workloads">
              <Layers3 size={16} /><span>Workloads</span>
              {sidebarContentVisible && <span className="nav-count">{pods.length + deployments.length + statefulSets.length}</span>}
            </button>
            <button className={`nav-item ${section === "network" ? "nav-item-active" : ""}`} onClick={() => { setSection("network"); setKindFilter("all"); }} title="Network">
              <Network size={16} /><span>Network</span>
              {sidebarContentVisible && <span className="nav-count">{services.length + ingresses.length}</span>}
            </button>
          </nav>

          {sidebarContentVisible && <div className="nav-heading nav-heading-spaced">CLUSTER</div>}
          <div className="namespace-control">
            <Server size={15} />
            {sidebarContentVisible && <span>Namespace</span>}
            {sidebarContentVisible && <NamespacePicker value={namespace} namespaces={namespaces} disabled={!activeContext} onChange={chooseNamespace} />}
          </div>

          <div className="sidebar-bottom">
            <div className={`connection-indicator ${activeContext ? "connection-online" : "connection-offline"}`}>
              <span className="connection-dot" />
              {sidebarContentVisible && <span>{activeContext ? liveState : "Disconnected"}</span>}
            </div>
            <button className="collapse-button" aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"} onClick={() => setSidebarCollapsed((value) => !value)}>
              {sidebarCollapsed ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}
              {sidebarContentVisible && <span>Collapse sidebar</span>}
            </button>
          </div>
        </aside>

        <section className="main-area">
          <div className="content-toolbar">
            <div className="breadcrumbs">
              <span>{section === "overview" ? "Overview" : section === "network" ? "Network" : "Workloads"}</span>
              {selection && <><ChevronRight size={14} /><span className="breadcrumb-current">{selection.name}</span></>}
            </div>
            <div className="toolbar-actions">
              <button className="icon-button" onClick={() => void openKubeconfig()} aria-label="Open kubeconfig file" title="Open kubeconfig file">
                <FolderOpen size={15} />
              </button>
              <NamespacePicker compact value={namespace} namespaces={namespaces} disabled={!activeContext} onChange={chooseNamespace} />
              {lastUpdated && <span className="updated-label">Updated {lastUpdated.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>}
              {activeContext && <span className={`watch-state watch-state-${liveState.toLowerCase()}`} title={liveIssue || `${liveState} resource updates`}><span />{liveState}</span>}
              <button className="icon-button" onClick={refresh} aria-label="Refresh workloads" title="Refresh">
                <RefreshCw size={15} className={loadState === "loading" && activeContext ? "spin" : ""} />
              </button>
            </div>
          </div>

          <div className={`content-and-detail ${panelOpen ? "detail-open" : ""} ${renderedSelection && !panelOpen ? "detail-closing" : ""} ${panelOpen && detailExpanded ? "detail-expanded" : ""} ${detailResizing ? "detail-resizing" : ""}`}>
            <div className="primary-content" inert={Boolean(panelOpen && detailExpanded)}>
              {!activeContext ? (
                <ConnectionScreen contexts={contexts} error={error} loading={loadState === "loading"} onOpenKubeconfig={() => void openKubeconfig()} onConnect={(name) => void connect(name)} />
              ) : section === "overview" ? (
                <Overview
                  context={activeContext}
                  namespace={namespace}
                  pods={pods}
                  deployments={deployments}
                  problemPods={problemPods}
                  unhealthyDeployments={unhealthyDeployments}
                  loadState={loadState}
                  error={visibleListError}
                  onResource={openResource}
                  onOpenWorkloads={() => setSection("workloads")}
                  onRetry={refresh}
                  allHealthy={allHealthy}
                  liveState={liveState}
                />
              ) : (
                <Workloads
                  key={section}
                  section={section}
                  pods={pods}
                  deployments={deployments}
                  statefulSets={statefulSets}
                  services={services}
                  ingresses={ingresses}
                  query={query}
                  onQuery={setQuery}
                  kindFilter={kindFilter}
                  onKindFilter={setKindFilter}
                  loadState={loadState}
                  error={visibleListError}
                  onRetry={refresh}
                  onResource={openResource}
                />
              )}
            </div>
            {renderedSelection && (
              <DetailPanel
                selection={renderedSelection}
                tab={detailTab}
                setTab={setDetailTab}
                state={detailState}
                error={detailError}
                pod={detailPod}
                deployment={detailDeployment}
                statefulSet={detailStatefulSet}
                service={detailService}
                ingress={detailIngress}
                relatedPods={relatedPods}
                logPodName={logPodName}
                setLogPodName={setLogPodName}
                events={events}
                eventsError={eventsError}
                yaml={yaml}
                yamlError={yamlError}
                relatedError={relatedError}
                logs={logs}
                logContainer={logContainer}
                setLogContainer={setLogContainer}
                logSearch={logSearch}
                setLogSearch={setLogSearch}
                showLogTimestamps={showLogTimestamps}
                setShowLogTimestamps={setShowLogTimestamps}
                paused={logPaused}
                logPane={logPane}
                copied={copied}
                width={panelOpen ? detailWidth : 0}
                expanded={panelOpen && detailExpanded}
                closing={!panelOpen}
                onToggleExpanded={() => setDetailExpanded((value) => !value)}
                onResizeStart={beginDetailResize}
                onResizeMove={moveDetailResize}
                onResizeEnd={endDetailResize}
                onResizeKeyDown={resizeDetailByKeyboard}
                onClose={closeDetails}
                onResource={openResource}
                onCopy={copyText}
                onToggleLogs={switchLogStream}
              />
            )}
          </div>
        </section>
      </div>
    </main>
  );
}

function ConnectionScreen({
  contexts,
  error,
  loading,
  onConnect,
  onOpenKubeconfig,
}: {
  contexts: KubernetesContext[];
  error: InfraError | null;
  loading: boolean;
  onConnect: (context: string) => void;
  onOpenKubeconfig: () => void;
}) {
  const [selected, setSelected] = useState(contexts.find((item) => item.isCurrent)?.name ?? contexts[0]?.name ?? "");
  const noContexts = contexts.length === 0;
  useEffect(() => {
    setSelected(contexts.find((item) => item.isCurrent)?.name ?? contexts[0]?.name ?? "");
  }, [contexts]);
  return (
    <div className="connection-page">
      <div className="connection-panel">
        <div className="connection-symbol">{error?.kind === "permission_denied" ? <AlertTriangle size={22} /> : <Cloud size={22} />}</div>
        <p className="eyebrow">CLUSTER CONNECTION</p>
        <h1>{loading ? contexts.length ? "Connecting to cluster" : "Loading kubeconfig" : noContexts ? "Open a kubeconfig file" : "Choose a context"}</h1>
        <p className="connection-description">
          {loading ? contexts.length ? `Connecting to ${selected}…` : "Reading the selected Kubernetes config file…" : error?.message ?? (noContexts
            ? "Choose a Kubernetes config file from this computer. Infra will not modify it, and credentials stay on this device."
            : "Choose a context from this file. Credentials stay on this device.")}
        </p>
        {!noContexts && <span className="field-label">Kubernetes context</span>}
        {!noContexts && <DropdownMenu
          className="connect-context-picker"
          ariaLabel="Kubernetes context"
          value={selected}
          options={contexts.map((item) => ({ value: item.name, label: item.name }))}
          onChange={setSelected}
        />}
        <button className="primary-button" disabled={loading} onClick={() => noContexts ? onOpenKubeconfig() : onConnect(selected)}>
          {loading ? "Connecting…" : noContexts ? "Open kubeconfig file" : "Connect to cluster"}
        </button>
        {!noContexts && <button className="open-another-config" onClick={onOpenKubeconfig}>Choose a different file</button>}
        <div className="connection-footnote"><CircleHelp size={14} /> Context changes here do not modify your kubeconfig.</div>
      </div>
    </div>
  );
}

function DropdownMenu({
  className = "",
  ariaLabel,
  value,
  options,
  onChange,
}: {
  className?: string;
  ariaLabel: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number; width: number } | null>(null);
  const selected = options.find((option) => option.value === value)?.label ?? value;
  const widestOption = Math.max(0, ...options.map((option) => option.label.length * 6 + 24));
  useLayoutEffect(() => {
    if (!open) return;
    const placeMenu = () => {
      const trigger = root.current?.querySelector<HTMLButtonElement>(".dropdown-menu-trigger");
      if (!trigger) return;
      const bounds = trigger.getBoundingClientRect();
      const contentWidth = Math.max(widestOption, bounds.width);
      const width = Math.min(className.includes("connect-context-picker") ? bounds.width : contentWidth, className.includes("connect-context-picker") ? window.innerWidth - 16 : 260, window.innerWidth - 16);
      const left = Math.max(8, Math.min(bounds.left, window.innerWidth - width - 8));
      const height = Math.min(options.length * 29 + 8, 320, window.innerHeight * 0.55);
      const preferredTop = bounds.bottom + height > window.innerHeight - 8 && bounds.top > height + 5 ? bounds.top - height - 5 : bounds.bottom + 5;
      const top = Math.max(8, Math.min(preferredTop, window.innerHeight - height - 8));
      setPosition({ left, top, width });
    };
    placeMenu();
    window.addEventListener("resize", placeMenu);
    window.addEventListener("scroll", placeMenu, true);
    return () => {
      window.removeEventListener("resize", placeMenu);
      window.removeEventListener("scroll", placeMenu, true);
    };
  }, [className, open, options.length, widestOption]);
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node) && !menu.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return <>
    <div className={`dropdown-menu-picker ${className}`} ref={root}>
      <button
        type="button"
        className="dropdown-menu-trigger"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span>{selected}</span><ChevronDown size={13} />
      </button>
    </div>
    {createPortal(
        <div ref={menu} className={`dropdown-menu-options ${open && position ? "menu-open" : ""}`} role="listbox" aria-label={ariaLabel} aria-hidden={!open} inert={!open} style={{ left: position?.left ?? -10000, top: position?.top ?? -10000, width: position?.width ?? 0 }}>
          {options.map((option) => (
            <button
              type="button"
              role="option"
              aria-selected={option.value === value}
              className={`dropdown-menu-option ${option.value === value ? "dropdown-menu-option-selected" : ""}`}
              key={option.value}
              title={option.label}
              onClick={() => { setOpen(false); onChange(option.value); }}
            >
              {option.label}
            </button>
          ))}
        </div>, document.body)}
  </>;
}

function NamespacePicker({
  value,
  namespaces,
  disabled,
  compact = false,
  onChange,
}: {
  value: string;
  namespaces: NamespaceInfo[];
  disabled: boolean;
  compact?: boolean;
  onChange: (namespace: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const options = [{ name: "all", label: "All namespaces" }, ...namespaces.map((item) => ({ name: item.name, label: item.name }))];
  const current = options.find((item) => item.name === value)?.label ?? value;
  return (
    <div className={`namespace-picker ${compact ? "namespace-picker-compact" : ""}`} ref={root}>
      <button
        type="button"
        className="namespace-picker-button"
        aria-label={`Namespace: ${current}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
      >
        <span>{current}</span><ChevronDown size={13} />
      </button>
        <div className={`namespace-menu ${open ? "menu-open" : ""}`} role="listbox" aria-label="Namespaces" aria-hidden={!open} inert={!open}>
          {options.map((item) => (
            <button
              type="button"
              role="option"
              aria-selected={item.name === value}
              className={`namespace-option ${item.name === value ? "namespace-option-selected" : ""}`}
              key={item.name}
              title={item.label}
              onClick={() => { setOpen(false); onChange(item.name); }}
            >
              {item.label}
            </button>
          ))}
        </div>
    </div>
  );
}

function Overview({
  context,
  namespace,
  pods,
  deployments,
  problemPods,
  unhealthyDeployments,
  loadState,
  error,
  onResource,
  onOpenWorkloads,
  onRetry,
  allHealthy,
  liveState,
}: {
  context: ConnectionInfo | null;
  namespace: string;
  pods: PodSummary[];
  deployments: DeploymentSummary[];
  problemPods: PodSummary[];
  unhealthyDeployments: DeploymentSummary[];
  loadState: LoadState;
  error: InfraError | null;
  onResource: (kind: Kind, name: string, namespace: string) => void;
  onOpenWorkloads: () => void;
  onRetry: () => void;
  allHealthy: boolean;
  liveState: string;
}) {
  const totalReadyPods = pods.reduce((count, pod) => count + pod.readyContainers, 0);
  const totalContainers = pods.reduce((count, pod) => count + pod.totalContainers, 0);
  const recentProblems = [
    ...problemPods.map((pod) => ({ kind: "pod" as const, name: pod.name, namespace: pod.namespace, status: pod.status, note: `${pod.restarts} restarts · ${pod.readyContainers}/${pod.totalContainers} containers ready`, age: pod.createdAt })),
    ...unhealthyDeployments.map((item) => ({ kind: "deployment" as const, name: item.name, namespace: item.namespace, status: "Rollout incomplete", note: `${item.ready}/${item.desired} replicas ready`, age: item.createdAt })),
  ].slice(0, 6);

  return (
    <div className="screen overview-screen">
      <div className="page-heading overview-heading">
        <div>
          <p className="eyebrow">CLUSTER OVERVIEW</p>
          <h1>{context?.context ?? "Cluster"}</h1>
          <p className="page-subtitle">{namespace === "all" ? "All namespaces" : namespace} <span className="subtle-separator">/</span> {context?.server || "Kubernetes API"}</p>
        </div>
        <div className={`health-banner ${allHealthy ? "health-good" : "health-attention"}`}>
          {allHealthy ? <Check size={15} /> : <Activity size={15} />}
          <span>{loadState === "loading" ? "Checking workloads" : loadState === "error" || error ? "Workload status incomplete" : liveState === "Reconnecting" ? "Syncing updates" : liveState === "Stale" ? "Status may be outdated" : allHealthy ? "No workload issues" : `${problemPods.length + unhealthyDeployments.length} need attention`}</span>
        </div>
      </div>

      {error && <InlineError error={error} onRetry={onRetry} />}

      <section className="health-strip" aria-label="Workload summary">
        <SummaryMetric label="Pods ready" value={loadState !== "ready" ? "—" : `${totalReadyPods}/${totalContainers}`} note={loadState === "ready" ? `${pods.length} pods` : "pods"} tone={problemPods.length ? "warning" : "normal"} />
        <SummaryMetric label="Deployments" value={loadState !== "ready" ? "—" : `${deployments.filter(deploymentHealthy).length}/${deployments.length}`} note="fully available" tone={unhealthyDeployments.length ? "warning" : "normal"} />
        <SummaryMetric label="Needs attention" value={loadState !== "ready" ? "—" : `${problemPods.length + unhealthyDeployments.length}`} note="pods and deployments" tone={problemPods.length + unhealthyDeployments.length ? "danger" : "normal"} />
      </section>

      <div className="overview-columns">
        <section className="problem-section">
          <div className="section-heading">
            <div><h2>Needs attention</h2><p>Resources with an incomplete or unhealthy state</p></div>
            <button className="text-button" onClick={onOpenWorkloads}>All workloads <ChevronRight size={14} /></button>
          </div>
          {loadState === "loading" ? <LoadingState label="Reading Pods and Deployments" compact /> : loadState === "error" ? null : recentProblems.length === 0 ? (
            <div className="quiet-empty"><span className="empty-check"><Check size={16} /></span><div><strong>Workloads look steady</strong><span>No unhealthy Pods or incomplete Deployments in this scope.</span></div></div>
          ) : (
            <div className="problem-list">
              {recentProblems.map((problem) => (
                <button className="problem-row" key={`${problem.kind}-${problem.namespace}-${problem.name}`} onClick={() => onResource(problem.kind, problem.name, problem.namespace)}>
                  <span className="problem-icon"><AlertTriangle size={15} /></span>
                  <span className="problem-main"><strong>{problem.name}</strong><span>{problem.note}</span></span>
                  <span className={`status-text status-${statusTone(problem.status)}`}>{problem.status}</span>
                  <span className="row-age">{formatAge(problem.age)}</span>
                  <ChevronRight size={14} className="row-chevron" />
                </button>
              ))}
            </div>
          )}
        </section>

        <section className="deployment-section">
          <div className="section-heading">
            <div><h2>Deployments</h2><p>Rollout and replica status</p></div>
            <span className="section-count">{deployments.length}</span>
          </div>
          {loadState === "loading" ? <LoadingState label="Loading Deployments" compact /> : loadState === "error" ? null : deployments.length === 0 ? (
            <div className="small-empty">No Deployments in this namespace.</div>
          ) : (
            <div className="deployment-list">
              {deployments.slice(0, 7).map((deployment) => (
                <button key={`${deployment.namespace}-${deployment.name}`} className="deployment-row" onClick={() => onResource("deployment", deployment.name, deployment.namespace)}>
                  <span className={`resource-state ${deploymentHealthy(deployment) ? "resource-state-good" : "resource-state-bad"}`} />
                  <span className="deployment-name"><strong>{deployment.name}</strong><small>{deployment.namespace}</small></span>
                  <span className="replica-count">{deployment.ready}<span>/</span>{deployment.desired}</span>
                  <ChevronRight size={14} className="row-chevron" />
                </button>
              ))}
              {deployments.length > 7 && <button className="list-more" onClick={onOpenWorkloads}>Show {deployments.length - 7} more</button>}
            </div>
          )}
        </section>
      </div>
      <div className="overview-footer"><span><Activity size={13} /> Read-only cluster data</span><span>Resource status comes directly from Kubernetes</span></div>
    </div>
  );
}

function SummaryMetric({ label, value, note, tone }: { label: string; value: string; note: string; tone: "normal" | "warning" | "danger" }) {
  return <div className={`summary-metric metric-${tone}`}><span className="metric-label">{label}</span><strong>{value}</strong><span className="metric-note">{note}</span></div>;
}

function Workloads({
  section,
  pods,
  deployments,
  statefulSets,
  services,
  ingresses,
  query,
  onQuery,
  kindFilter,
  onKindFilter,
  loadState,
  error,
  onRetry,
  onResource,
}: {
  section: "workloads" | "network";
  pods: PodSummary[];
  deployments: DeploymentSummary[];
  statefulSets: StatefulSetSummary[];
  services: ServiceSummary[];
  ingresses: IngressSummary[];
  query: string;
  onQuery: (value: string) => void;
  kindFilter: "all" | Kind;
  onKindFilter: (value: "all" | Kind) => void;
  loadState: LoadState;
  error: InfraError | null;
  onRetry: () => void;
  onResource: (kind: Kind, name: string, namespace: string) => void;
}) {
  const resourceKinds: Kind[] = section === "network" ? ["service", "ingress"] : ["deployment", "statefulset", "pod"];
  const resourceOptions = [{ value: "all", label: "All resource types" }, ...resourceKinds.map((kind) => ({ value: kind, label: ({ deployment: "Deployments", statefulset: "StatefulSets", pod: "Pods", service: "Services", ingress: "Ingresses" } as const)[kind] }))];
  const normalized = query.trim().toLowerCase();
  const rows = [
    ...deployments.map((item) => ({ kind: "deployment" as const, name: item.name, namespace: item.namespace, status: deploymentHealthy(item) ? "Available" : "Progressing", ready: `${item.ready}/${item.desired}`, detail: item.image ?? "", age: item.createdAt, restarts: "—" })),
    ...statefulSets.map((item) => ({ kind: "statefulset" as const, name: item.name, namespace: item.namespace, status: item.ready >= item.desired ? "Ready" : "Progressing", ready: `${item.ready}/${item.desired}`, detail: item.image ?? "", age: item.createdAt, restarts: "—" })),
    ...pods.map((item) => ({ kind: "pod" as const, name: item.name, namespace: item.namespace, status: item.status, ready: `${item.readyContainers}/${item.totalContainers}`, detail: item.node ?? "", age: item.createdAt, restarts: `${item.restarts}` })),
    ...services.map((item) => ({ kind: "service" as const, name: item.name, namespace: item.namespace, status: item.serviceType, ready: [item.clusterIp, ...item.externalIps].filter(Boolean).join(" · ") || "—", detail: item.ports.join(", "), age: item.createdAt, restarts: "—" })),
    ...ingresses.map((item) => ({ kind: "ingress" as const, name: item.name, namespace: item.namespace, status: item.addresses.length ? "Address assigned" : "No address", ready: item.addresses.join(", ") || "—", detail: item.hosts.join(", ") || "No host", age: item.createdAt, restarts: "—" })),
  ].filter((row) => resourceKinds.includes(row.kind) && (kindFilter === "all" || row.kind === kindFilter) && (!normalized || `${row.name} ${row.namespace} ${row.status} ${row.detail}`.toLowerCase().includes(normalized)));
  const resourceTitle = section === "network" ? "Network" : "Workloads";
  return (
    <div className={`screen workloads-screen ${section === "network" ? "network-screen" : ""}`}>
      <div className="page-heading">
        <div><p className="eyebrow">RESOURCE BROWSER</p><h1>{resourceTitle}</h1><p className="page-subtitle">{section === "network" ? "Services and Ingress routes in the selected namespace scope." : "Pods, Deployments, and StatefulSets across the selected namespace scope."}</p></div>
      </div>
      <div className="list-toolbar">
        <label className="search-box"><Search size={15} /><input value={query} onChange={(event) => onQuery(event.target.value)} placeholder="Filter by name, namespace, or status" aria-label={`Filter ${resourceTitle.toLowerCase()}`} />{query && <button onClick={() => onQuery("")} aria-label="Clear search"><X size={13} /></button>}</label>
        <div className="filter-select"><ListFilter size={14} /><DropdownMenu
          className="resource-kind-picker"
          ariaLabel={`${resourceTitle} type`}
          value={kindFilter}
          options={resourceOptions}
          onChange={(value) => onKindFilter(value as "all" | Kind)}
        /></div>
      </div>
      {error && <InlineError error={error} onRetry={onRetry} />}
      {loadState === "loading" ? <LoadingState label={`Loading ${resourceTitle.toLowerCase()}`} /> : loadState === "error" ? null : rows.length === 0 ? (
        <EmptyState title={query || kindFilter !== "all" ? "No matches" : `No ${resourceTitle.toLowerCase()} found`} message={query || kindFilter !== "all" ? "Try a shorter name or clear the current filter." : section === "network" ? "There are no Services or Ingresses in this namespace scope." : "There are no Pods, Deployments, or StatefulSets in this namespace scope."} />
      ) : (
        <div className="resource-table-wrap">
          <table className="resource-table">
            <thead><tr><th>NAME</th><th>NAMESPACE</th><th>STATUS</th><th>{section === "network" ? "ADDRESS" : "READY"}</th>{section === "network" ? <th>PORTS / HOSTS</th> : <th>RESTARTS</th>}<th>AGE</th></tr></thead>
            <tbody>
              {rows.map((row) => {
                const tone = row.kind === "pod" ? statusTone(row.status) : ["Available", "Ready", "ClusterIP", "NodePort", "LoadBalancer", "ExternalName", "Address assigned"].includes(row.status) ? "good" : "muted";
                const icon = row.kind === "pod" ? <TerminalSquare size={14} className="table-kind-icon" /> : row.kind === "service" || row.kind === "ingress" ? <Network size={14} className="table-kind-icon" /> : <Layers3 size={14} className="table-kind-icon" />;
                const kindLabel = resourceOptions.find((item) => item.value === row.kind)?.label.replace(/s$/, "") ?? row.kind;
                return <tr key={`${row.kind}-${row.namespace}-${row.name}`} onClick={() => onResource(row.kind, row.name, row.namespace)} tabIndex={0} onKeyDown={(event) => event.key === "Enter" && onResource(row.kind, row.name, row.namespace)}>
                  <td><span className={`resource-state ${tone === "good" ? "resource-state-good" : tone === "bad" ? "resource-state-bad" : "resource-state-muted"}`} />{icon}<strong>{row.name}</strong><span className="kind-label">{kindLabel}</span></td>
                  <td>{row.namespace}</td><td><StatusPill tone={tone} label={row.status} /></td>
                  <td className="table-ready" title={row.detail}>{row.ready}</td>{section === "network" ? <td className="table-muted" title={row.detail}>{row.detail || "—"}</td> : <td className={row.restarts !== "—" && Number(row.restarts) > 0 ? "restart-count" : "table-muted"}>{row.restarts}</td>}<td className="table-muted">{formatAge(row.age)}</td>
                </tr>;
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="list-footer">Showing {rows.length} resources <span>•</span> Updates follow the cluster while this window is visible</div>
    </div>
  );
}

function StatusPill({ tone, label }: { tone: "good" | "bad" | "muted"; label: string }) {
  return <span className={`status-pill status-pill-${tone}`}><span />{label}</span>;
}

function DetailPanel({
  selection,
  tab,
  setTab,
  state,
  error,
  pod,
  deployment,
  statefulSet,
  service,
  ingress,
  relatedPods,
  logPodName,
  setLogPodName,
  events,
  eventsError,
  yaml,
  yamlError,
  relatedError,
  logs,
  logContainer,
  setLogContainer,
  logSearch,
  setLogSearch,
  showLogTimestamps,
  setShowLogTimestamps,
  paused,
  logPane,
  copied,
  onClose,
  onResource,
  onCopy,
  onToggleLogs,
  width,
  expanded,
  closing,
  onToggleExpanded,
  onResizeStart,
  onResizeMove,
  onResizeEnd,
  onResizeKeyDown,
}: {
  selection: Selection;
  tab: DetailTab;
  setTab: (tab: DetailTab) => void;
  state: LoadState;
  error: InfraError | null;
  pod: PodSummary | null;
  deployment: DeploymentSummary | null;
  statefulSet: StatefulSetSummary | null;
  service: ServiceSummary | null;
  ingress: IngressSummary | null;
  relatedPods: PodSummary[];
  logPodName: string;
  setLogPodName: (name: string) => void;
  events: EventSummary[];
  eventsError: InfraError | null;
  yaml: string;
  yamlError: InfraError | null;
  relatedError: InfraError | null;
  logs: string[];
  logContainer: string;
  setLogContainer: (container: string) => void;
  logSearch: string;
  setLogSearch: (query: string) => void;
  showLogTimestamps: boolean;
  setShowLogTimestamps: Dispatch<SetStateAction<boolean>>;
  paused: boolean;
  logPane: RefObject<HTMLDivElement | null>;
  copied: boolean;
  onClose: () => void;
  onResource: (kind: Kind, name: string, namespace: string) => void;
  onCopy: (text: string) => void;
  onToggleLogs: () => void;
  width: number;
  expanded: boolean;
  closing: boolean;
  onToggleExpanded: () => void;
  onResizeStart: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onResizeMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onResizeEnd: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onResizeKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
}) {
  const hasWorkloadPods = selection.kind === "deployment" || selection.kind === "statefulset" || selection.kind === "service";
  const hasLogs = selection.kind === "pod" || selection.kind === "deployment" || selection.kind === "statefulset";
  const tabList: DetailTab[] = selection.kind === "pod" ? ["summary", "events", "logs", "yaml"] : ["summary", ...(hasWorkloadPods ? ["pods" as const] : []), ...(hasLogs ? ["logs" as const] : []), "events", "yaml"];
  const detailName = pod?.name ?? deployment?.name ?? statefulSet?.name ?? service?.name ?? ingress?.name ?? selection.name;
  const detailStatus = pod?.status ?? (deployment ? deploymentHealthy(deployment) ? "Available" : "Progressing" : statefulSet ? statefulSet.ready >= statefulSet.desired ? "Ready" : "Progressing" : service?.serviceType ?? (ingress ? ingress.addresses.length ? "Address assigned" : "No address" : "Loading"));
  const statusClass = pod ? statusTone(pod.status) : deployment ? deploymentHealthy(deployment) ? "good" : "bad" : statefulSet ? statefulSet.ready >= statefulSet.desired ? "good" : "bad" : service || (ingress?.addresses.length ?? 0) > 0 ? "good" : "muted";
  const count = events.length;
  return (
    <aside className={`detail-panel ${expanded ? "detail-panel-expanded" : ""}`} style={{ width: expanded ? "100%" : `${width}px` }} aria-label={`${selection.kind} details`} aria-hidden={closing} inert={closing}>
      {!expanded && <div
        className="detail-resize-handle"
        role="separator"
        aria-label="Resize details panel"
        aria-orientation="vertical"
        aria-valuemin={320}
        aria-valuemax={1050}
        aria-valuenow={width}
        tabIndex={0}
        onPointerDown={onResizeStart}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeEnd}
        onPointerCancel={onResizeEnd}
        onKeyDown={onResizeKeyDown}
      />}
      <div className="detail-heading">
        <div className="detail-heading-main">
          <div className="detail-icon">{selection.kind === "pod" ? <TerminalSquare size={16} /> : selection.kind === "service" || selection.kind === "ingress" ? <Network size={16} /> : <Layers3 size={16} />}</div>
          <div className="detail-title-wrap"><span className="detail-kind">{selection.kind}</span><h2 title={detailName}>{detailName}</h2></div>
        </div>
        <div className="detail-heading-actions">
          <button className="icon-button" onClick={onToggleExpanded} aria-label={expanded ? "Restore details width" : "Expand details"} title={expanded ? "Restore details width" : "Expand details"}>{expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}</button>
          <button className="icon-button" onClick={onClose} aria-label="Close details"><X size={16} /></button>
        </div>
      </div>
      <div className="detail-meta"><span>{selection.namespace}</span><span className={`detail-status detail-status-${statusClass}`}><span />{detailStatus}</span></div>
      <div className="detail-tabs" role="tablist" aria-label="Resource details">
        {tabList.map((item) => <button key={item} role="tab" aria-selected={tab === item} className={tab === item ? "detail-tab selected" : "detail-tab"} onClick={() => setTab(item)}>{item === "pods" ? `Pods${state === "ready" && selection.kind === "deployment" ? ` ${relatedPods.length}` : ""}` : item === "events" ? `Events${state === "ready" ? ` ${count}` : ""}` : item === "yaml" ? "YAML" : item === "logs" ? "Logs" : "Overview"}</button>)}
      </div>
      <div key={`${selection.kind}/${selection.namespace}/${selection.name}/${tab}`} className={`detail-content ${tab === "logs" ? "detail-content-logs" : ""}`}>
        {state === "loading" ? <LoadingState label={`Loading ${selection.kind} details`} /> : state === "error" ? <InlineError error={error} onRetry={() => onResource(selection.kind, selection.name, selection.namespace)} /> : (
          <>
            {tab === "summary" && (
              <div className="detail-summary">
                {pod && <>
                  <div className="detail-overview-status"><span className={`status-orbit status-orbit-${statusClass}`}><Activity size={15} /></span><div><strong>{pod.status}</strong><span>{pod.readyContainers} of {pod.totalContainers} containers ready</span></div></div>
                  <div className="detail-properties">
                    <Property label="Namespace" value={pod.namespace} />
                    <Property label="Node" value={pod.node ?? "Not scheduled"} />
                    <Property label="Restarts" value={`${pod.restarts}`} tone={pod.restarts ? "warning" : undefined} />
                    <Property label="Created" value={formatAge(pod.createdAt)} />
                  </div>
                  <div className="detail-subheading"><h3>Containers</h3><span>{pod.containers.length}</span></div>
                  <div className="container-list">{pod.containers.map((container) => <div className="container-item" key={container.name}><span className={`container-ready ${container.ready ? "is-ready" : ""}`} /><div><strong>{container.name}</strong><code>{container.image}</code>{container.stateReason && <span className="container-reason">{container.stateReason}</span>}</div><span className="container-restarts">{container.restartCount} restarts</span></div>)}</div>
                </>}
                {deployment && <>
                  <div className="detail-overview-status"><span className={`status-orbit status-orbit-${statusClass}`}><Activity size={15} /></span><div><strong>{deploymentHealthy(deployment) ? "Available" : "Rollout in progress"}</strong><span>{deployment.ready} of {deployment.desired} replicas ready</span></div></div>
                  <div className="replica-track"><span style={{ width: `${deployment.desired ? Math.min(100, (deployment.ready / deployment.desired) * 100) : 0}%` }} /></div>
                  <div className="detail-properties">
                    <Property label="Namespace" value={deployment.namespace} />
                    <Property label="Ready replicas" value={`${deployment.ready} / ${deployment.desired}`} />
                    <Property label="Available" value={`${deployment.available}`} />
                    <Property label="Updated" value={`${deployment.updated}`} />
                    <Property label="Created" value={formatAge(deployment.createdAt)} />
                  </div>
                  <div className="detail-subheading"><h3>Container image</h3></div>
                  <code className="image-value">{deployment.image ?? "No image reported"}</code>
                  <button className="inline-link" onClick={() => setTab("pods")}>Trace to related Pods <ChevronRight size={14} /></button>
                </>}
                {statefulSet && <>
                  <div className="detail-overview-status"><span className={`status-orbit status-orbit-${statusClass}`}><Activity size={15} /></span><div><strong>{statefulSet.ready >= statefulSet.desired ? "Ready" : "Rollout in progress"}</strong><span>{statefulSet.ready} of {statefulSet.desired} replicas ready</span></div></div>
                  <div className="replica-track"><span style={{ width: `${statefulSet.desired ? Math.min(100, (statefulSet.ready / statefulSet.desired) * 100) : 0}%` }} /></div>
                  <div className="detail-properties"><Property label="Namespace" value={statefulSet.namespace} /><Property label="Ready replicas" value={`${statefulSet.ready} / ${statefulSet.desired}`} /><Property label="Current" value={`${statefulSet.current}`} /><Property label="Updated" value={`${statefulSet.updated}`} /><Property label="Created" value={formatAge(statefulSet.createdAt)} /></div>
                  <div className="detail-subheading"><h3>Container image</h3></div><code className="image-value">{statefulSet.image ?? "No image reported"}</code>
                  <button className="inline-link" onClick={() => setTab("pods")}>View StatefulSet Pods <ChevronRight size={14} /></button>
                </>}
                {service && <>
                  <div className="detail-overview-status"><span className={`status-orbit status-orbit-${statusClass}`}><Network size={15} /></span><div><strong>{service.serviceType}</strong><span>{service.clusterIp ? `Cluster IP ${service.clusterIp}` : "No cluster IP assigned"}</span></div></div>
                  <div className="detail-properties"><Property label="Namespace" value={service.namespace} /><Property label="Cluster IP" value={service.clusterIp ?? "None"} /><Property label="External IPs" value={service.externalIps.join(", ") || "None"} /><Property label="Created" value={formatAge(service.createdAt)} /></div>
                  <div className="detail-subheading"><h3>Ports</h3><span>{service.ports.length}</span></div>
                  <div className="detail-value-list">{service.ports.length ? service.ports.map((port) => <code key={port}>{port}</code>) : <span>No ports declared</span>}</div>
                  <button className="inline-link" onClick={() => setTab("pods")}>View selector-matched Pods <ChevronRight size={14} /></button>
                </>}
                {ingress && <>
                  <div className="detail-overview-status"><span className={`status-orbit status-orbit-${statusClass}`}><Network size={15} /></span><div><strong>{ingress.addresses.length ? "Address assigned" : "No address reported"}</strong><span>{ingress.addresses.join(", ") || "Ingress controller has not reported an address"}</span></div></div>
                  <div className="detail-properties"><Property label="Namespace" value={ingress.namespace} /><Property label="Hosts" value={ingress.hosts.join(", ") || "All hosts"} /><Property label="Created" value={formatAge(ingress.createdAt)} /></div>
                  <div className="detail-subheading"><h3>Routes</h3><span>{ingress.rules.length}</span></div>
                  <div className="detail-value-list">{ingress.rules.length ? ingress.rules.map((rule) => <code key={rule}>{rule}</code>) : <span>No HTTP routes declared</span>}</div>
                </>}
              </div>
            )}
            {tab === "pods" && <RelatedPods pods={relatedPods} error={relatedError} onRetry={() => onResource(selection.kind, selection.name, selection.namespace)} onResource={onResource} />}
            {tab === "events" && <EventList events={events} error={eventsError} onRetry={() => onResource(selection.kind, selection.name, selection.namespace)} />}
            {tab === "yaml" && (yamlError ? <div className="partial-error"><InlineError error={yamlError} onRetry={() => onResource(selection.kind, selection.name, selection.namespace)} /></div> : <div className="code-panel"><div className="code-toolbar"><span><FileCode2 size={14} /> Resource manifest</span><button className="small-action" onClick={() => void onCopy(yaml)}>{copied ? <Check size={13} /> : <Copy size={13} />}{copied ? "Copied" : "Copy"}</button></div><pre className="yaml-content">{yaml}</pre></div>)}
            {tab === "logs" && hasLogs && <LogsView key={`${selection.kind}/${selection.namespace}/${selection.name}`} selection={selection} pod={pod} relatedPods={relatedPods} logPodName={logPodName} setLogPodName={setLogPodName} logContainer={logContainer} setLogContainer={setLogContainer} logs={logs} logSearch={logSearch} setLogSearch={setLogSearch} showLogTimestamps={showLogTimestamps} setShowLogTimestamps={setShowLogTimestamps} paused={paused} logPane={logPane} error={error} onToggleLogs={onToggleLogs} />}
          </>
        )}
      </div>
      <div className="detail-footer"><span>Read-only view</span><span>{selection.kind === "pod" ? `${pod?.restarts ?? 0} restarts` : hasWorkloadPods ? `${relatedPods.length} related Pods` : selection.kind}</span></div>
    </aside>
  );
}

function Property({ label, value, tone }: { label: string; value: string; tone?: "warning" }) {
  return <div className="property"><span>{label}</span><strong className={tone === "warning" ? "property-warning" : ""}>{value}</strong></div>;
}

function cleanLogLine(line: string, showKubernetesTimestamp: boolean): string {
  const ansiPattern = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g");
  const withoutAnsi = line.replace(ansiPattern, "");
  if (showKubernetesTimestamp) return withoutAnsi;
  return withoutAnsi.replace(/^\d{4}-\d\d-\d\dT\S+\s+/, "");
}

function LogsView({
  selection,
  pod,
  relatedPods,
  logPodName,
  setLogPodName,
  logContainer,
  setLogContainer,
  logs,
  logSearch,
  setLogSearch,
  showLogTimestamps,
  setShowLogTimestamps,
  paused,
  logPane,
  error,
  onToggleLogs,
}: {
  selection: Selection;
  pod: PodSummary | null;
  relatedPods: PodSummary[];
  logPodName: string;
  setLogPodName: (name: string) => void;
  logContainer: string;
  setLogContainer: (container: string) => void;
  logs: string[];
  logSearch: string;
  setLogSearch: (query: string) => void;
  showLogTimestamps: boolean;
  setShowLogTimestamps: Dispatch<SetStateAction<boolean>>;
  paused: boolean;
  logPane: RefObject<HTMLDivElement | null>;
  error: InfraError | null;
  onToggleLogs: () => void;
}) {
  const targetPod = selection.kind === "pod" ? pod : relatedPods.find((item) => item.name === logPodName) ?? relatedPods[0];
  const containers = targetPod?.containers ?? [];
  useEffect(() => {
    if (targetPod && !targetPod.containers.some((container) => container.name === logContainer)) {
      setLogContainer(targetPod.containers[0]?.name ?? "");
    }
  }, [logContainer, targetPod, setLogContainer]);
  const visibleLines = logs.map((line) => cleanLogLine(line, showLogTimestamps)).filter((line) => !logSearch || line.toLowerCase().includes(logSearch.toLowerCase()));

  if (!targetPod) return <EmptyState title="No Pod to stream" message="Logs come from Pods. This workload has no related Pods in the current namespace." />;
  return <div className="logs-panel">
    <div className="logs-toolbar">
      <span className="live-label"><span />{paused ? "Paused" : "Live"}</span>
      {selection.kind !== "pod" && relatedPods.length > 0 && <DropdownMenu className="log-container-picker log-pod-picker" ariaLabel="Log Pod" value={targetPod.name} options={relatedPods.map((item) => ({ value: item.name, label: item.name }))} onChange={(name) => { setLogPodName(name); setLogContainer(""); }} />}
      {containers.length > 1 && <DropdownMenu className="log-container-picker" ariaLabel="Log container" value={logContainer} options={containers.map((container) => ({ value: container.name, label: container.name }))} onChange={setLogContainer} />}
      <label className="log-search"><Search size={12} /><input value={logSearch} onChange={(event) => setLogSearch(event.target.value)} placeholder="Find in logs" aria-label="Search logs" /></label>
      <button className={`timestamp-toggle ${showLogTimestamps ? "timestamp-active" : ""}`} onClick={() => setShowLogTimestamps((value) => !value)} aria-pressed={showLogTimestamps} title="Toggle Kubernetes timestamps">TS</button>
      <span className="logs-latest-label">Last 300 + live</span>
      <button className="small-action" onClick={onToggleLogs}>{paused ? <Play size={13} /> : <Pause size={13} />}{paused ? "Resume" : "Pause"}</button>
    </div>
    {error && <InlineError error={error} onRetry={onToggleLogs} />}
    {logs.length === 0 ? <div className="logs-empty"><LoaderCircle size={16} className="spin" /><span>{paused ? "Stream paused" : `Waiting for ${logContainer || "container"} output`}</span></div> : visibleLines.length === 0 ? <div className="logs-empty"><Search size={15} /><span>No lines match this search.</span></div> : <div className="logs-content" ref={logPane}>{visibleLines.map((line, index) => {
      const podPrefix = line.match(/^\[([^\]]+)\](.*)$/);
      return <div className="log-line" key={`${index}-${line}`} title={line}>
        {podPrefix ? <><span className="log-pod-name">[{podPrefix[1]}]</span><span>{podPrefix[2]}</span></> : <span>{line}</span>}
      </div>;
    })}</div>}
  </div>;
}

function RelatedPods({ pods, error, onRetry, onResource }: { pods: PodSummary[]; error: InfraError | null; onRetry: () => void; onResource: (kind: Kind, name: string, namespace: string) => void }) {
  if (error) return <div className="partial-error"><InlineError error={error} onRetry={onRetry} /></div>;
  if (pods.length === 0) return <EmptyState title="No related Pods" message="No Pods match this resource's selector." />;
  return <div className="related-list"><div className="trace-rail" aria-hidden="true" />{pods.map((pod) => <button className="related-pod" key={`${pod.namespace}-${pod.name}`} onClick={() => onResource("pod", pod.name, pod.namespace)}><span className={`resource-state ${podHealthy(pod) ? "resource-state-good" : "resource-state-bad"}`} /><div><strong>{pod.name}</strong><span>{pod.namespace} · {pod.readyContainers}/{pod.totalContainers} ready</span></div><span className={`status-text status-${statusTone(pod.status)}`}>{pod.status}</span><ChevronRight size={14} /></button>)}</div>;
}

function EventList({ events, error, onRetry }: { events: EventSummary[]; error: InfraError | null; onRetry: () => void }) {
  if (error) return <div className="partial-error"><InlineError error={error} onRetry={onRetry} /></div>;
  if (events.length === 0) return <EmptyState title="No related events" message="Kubernetes has not reported events for this resource." />;
  return <div className="event-list">{events.map((event) => <article key={`${event.namespace}-${event.name}`} className={`event-item ${event.eventType.toLowerCase() === "warning" ? "event-warning" : ""}`}><div className="event-line"><span className={`event-type event-${event.eventType.toLowerCase()}`}>{event.eventType}</span><strong>{event.reason}</strong><time>{formatAge(event.lastSeen)}</time></div><p>{event.message}</p><span className="event-object">{event.objectKind.toLowerCase()}/{event.objectName}</span></article>)}</div>;
}

function LoadingState({ label, compact = false }: { label: string; compact?: boolean }) {
  return <div className={`loading-state ${compact ? "loading-compact" : ""}`} role="status"><LoaderCircle size={16} className="spin" /><span>{label}</span></div>;
}

function EmptyState({ title, message }: { title: string; message: string }) {
  return <div className="empty-state"><span className="empty-mark"><Search size={16} /></span><strong>{title}</strong><p>{message}</p></div>;
}

function InlineError({ error, onRetry }: { error: InfraError | null; onRetry: () => void }) {
  return <div className="inline-error" role="alert"><AlertCircle size={16} /><div><strong>{error?.kind === "permission_denied" ? "Access denied" : error?.kind === "authentication" ? "Credentials rejected" : "Could not load cluster data"}</strong><span>{error?.message ?? "The request failed. Try again."}</span></div><button onClick={onRetry}>Retry</button></div>;
}
