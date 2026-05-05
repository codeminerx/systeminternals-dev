declare module 'astro:content' {
	interface RenderResult {
		Content: import('astro/runtime/server/index.js').AstroComponentFactory;
		headings: import('astro').MarkdownHeading[];
		remarkPluginFrontmatter: Record<string, any>;
	}
	interface Render {
		'.md': Promise<RenderResult>;
	}

	export interface RenderedContent {
		html: string;
		metadata?: {
			imagePaths: Array<string>;
			[key: string]: unknown;
		};
	}
}

declare module 'astro:content' {
	type Flatten<T> = T extends { [K: string]: infer U } ? U : never;

	export type CollectionKey = keyof AnyEntryMap;
	export type CollectionEntry<C extends CollectionKey> = Flatten<AnyEntryMap[C]>;

	export type ContentCollectionKey = keyof ContentEntryMap;
	export type DataCollectionKey = keyof DataEntryMap;

	type AllValuesOf<T> = T extends any ? T[keyof T] : never;
	type ValidContentEntrySlug<C extends keyof ContentEntryMap> = AllValuesOf<
		ContentEntryMap[C]
	>['slug'];

	/** @deprecated Use `getEntry` instead. */
	export function getEntryBySlug<
		C extends keyof ContentEntryMap,
		E extends ValidContentEntrySlug<C> | (string & {}),
	>(
		collection: C,
		// Note that this has to accept a regular string too, for SSR
		entrySlug: E,
	): E extends ValidContentEntrySlug<C>
		? Promise<CollectionEntry<C>>
		: Promise<CollectionEntry<C> | undefined>;

	/** @deprecated Use `getEntry` instead. */
	export function getDataEntryById<C extends keyof DataEntryMap, E extends keyof DataEntryMap[C]>(
		collection: C,
		entryId: E,
	): Promise<CollectionEntry<C>>;

	export function getCollection<C extends keyof AnyEntryMap, E extends CollectionEntry<C>>(
		collection: C,
		filter?: (entry: CollectionEntry<C>) => entry is E,
	): Promise<E[]>;
	export function getCollection<C extends keyof AnyEntryMap>(
		collection: C,
		filter?: (entry: CollectionEntry<C>) => unknown,
	): Promise<CollectionEntry<C>[]>;

	export function getEntry<
		C extends keyof ContentEntryMap,
		E extends ValidContentEntrySlug<C> | (string & {}),
	>(entry: {
		collection: C;
		slug: E;
	}): E extends ValidContentEntrySlug<C>
		? Promise<CollectionEntry<C>>
		: Promise<CollectionEntry<C> | undefined>;
	export function getEntry<
		C extends keyof DataEntryMap,
		E extends keyof DataEntryMap[C] | (string & {}),
	>(entry: {
		collection: C;
		id: E;
	}): E extends keyof DataEntryMap[C]
		? Promise<DataEntryMap[C][E]>
		: Promise<CollectionEntry<C> | undefined>;
	export function getEntry<
		C extends keyof ContentEntryMap,
		E extends ValidContentEntrySlug<C> | (string & {}),
	>(
		collection: C,
		slug: E,
	): E extends ValidContentEntrySlug<C>
		? Promise<CollectionEntry<C>>
		: Promise<CollectionEntry<C> | undefined>;
	export function getEntry<
		C extends keyof DataEntryMap,
		E extends keyof DataEntryMap[C] | (string & {}),
	>(
		collection: C,
		id: E,
	): E extends keyof DataEntryMap[C]
		? Promise<DataEntryMap[C][E]>
		: Promise<CollectionEntry<C> | undefined>;

	/** Resolve an array of entry references from the same collection */
	export function getEntries<C extends keyof ContentEntryMap>(
		entries: {
			collection: C;
			slug: ValidContentEntrySlug<C>;
		}[],
	): Promise<CollectionEntry<C>[]>;
	export function getEntries<C extends keyof DataEntryMap>(
		entries: {
			collection: C;
			id: keyof DataEntryMap[C];
		}[],
	): Promise<CollectionEntry<C>[]>;

	export function render<C extends keyof AnyEntryMap>(
		entry: AnyEntryMap[C][string],
	): Promise<RenderResult>;

	export function reference<C extends keyof AnyEntryMap>(
		collection: C,
	): import('astro/zod').ZodEffects<
		import('astro/zod').ZodString,
		C extends keyof ContentEntryMap
			? {
					collection: C;
					slug: ValidContentEntrySlug<C>;
				}
			: {
					collection: C;
					id: keyof DataEntryMap[C];
				}
	>;
	// Allow generic `string` to avoid excessive type errors in the config
	// if `dev` is not running to update as you edit.
	// Invalid collection names will be caught at build time.
	export function reference<C extends string>(
		collection: C,
	): import('astro/zod').ZodEffects<import('astro/zod').ZodString, never>;

	type ReturnTypeOrOriginal<T> = T extends (...args: any[]) => infer R ? R : T;
	type InferEntrySchema<C extends keyof AnyEntryMap> = import('astro/zod').infer<
		ReturnTypeOrOriginal<Required<ContentConfig['collections'][C]>['schema']>
	>;

	type ContentEntryMap = {
		"posts": {
"clickhouse-architecture-deep-dive.md": {
	id: "clickhouse-architecture-deep-dive.md";
  slug: "clickhouse-architecture-deep-dive";
  body: string;
  collection: "posts";
  data: InferEntrySchema<"posts">
} & { render(): Render[".md"] };
"database-normalization-practical-guide.md": {
	id: "database-normalization-practical-guide.md";
  slug: "database-normalization-practical-guide";
  body: string;
  collection: "posts";
  data: InferEntrySchema<"posts">
} & { render(): Render[".md"] };
"database-transactions-isolation-levels.md": {
	id: "database-transactions-isolation-levels.md";
  slug: "database-transactions-isolation-levels";
  body: string;
  collection: "posts";
  data: InferEntrySchema<"posts">
} & { render(): Render[".md"] };
"dns-deep-dive-how-domain-resolution-works.md": {
	id: "dns-deep-dive-how-domain-resolution-works.md";
  slug: "dns-deep-dive-how-domain-resolution-works";
  body: string;
  collection: "posts";
  data: InferEntrySchema<"posts">
} & { render(): Render[".md"] };
"ebpf-linux-observability-framework.md": {
	id: "ebpf-linux-observability-framework.md";
  slug: "ebpf-linux-observability-framework";
  body: string;
  collection: "posts";
  data: InferEntrySchema<"posts">
} & { render(): Render[".md"] };
"gdb-debugging-core-dumps-live-processes.md": {
	id: "gdb-debugging-core-dumps-live-processes.md";
  slug: "gdb-debugging-core-dumps-live-processes";
  body: string;
  collection: "posts";
  data: InferEntrySchema<"posts">
} & { render(): Render[".md"] };
"linux-memory-debugging-profiling.md": {
	id: "linux-memory-debugging-profiling.md";
  slug: "linux-memory-debugging-profiling";
  body: string;
  collection: "posts";
  data: InferEntrySchema<"posts">
} & { render(): Render[".md"] };
"linux-proc-filesystem-deep-dive.md": {
	id: "linux-proc-filesystem-deep-dive.md";
  slug: "linux-proc-filesystem-deep-dive";
  body: string;
  collection: "posts";
  data: InferEntrySchema<"posts">
} & { render(): Render[".md"] };
"linux-process-management-ps-top-htop.md": {
	id: "linux-process-management-ps-top-htop.md";
  slug: "linux-process-management-ps-top-htop";
  body: string;
  collection: "posts";
  data: InferEntrySchema<"posts">
} & { render(): Render[".md"] };
"paxos-consensus-algorithm-deep-dive.md": {
	id: "paxos-consensus-algorithm-deep-dive.md";
  slug: "paxos-consensus-algorithm-deep-dive";
  body: string;
  collection: "posts";
  data: InferEntrySchema<"posts">
} & { render(): Render[".md"] };
"postgresql-vs-mysql-2024.md": {
	id: "postgresql-vs-mysql-2024.md";
  slug: "postgresql-vs-mysql-2024";
  body: string;
  collection: "posts";
  data: InferEntrySchema<"posts">
} & { render(): Render[".md"] };
"raft-consensus-algorithm-deep-dive.md": {
	id: "raft-consensus-algorithm-deep-dive.md";
  slug: "raft-consensus-algorithm-deep-dive";
  body: string;
  collection: "posts";
  data: InferEntrySchema<"posts">
} & { render(): Render[".md"] };
"rate-limiter-system-design.md": {
	id: "rate-limiter-system-design.md";
  slug: "rate-limiter-system-design";
  body: string;
  collection: "posts";
  data: InferEntrySchema<"posts">
} & { render(): Render[".md"] };
"redis-beyond-caching.md": {
	id: "redis-beyond-caching.md";
  slug: "redis-beyond-caching";
  body: string;
  collection: "posts";
  data: InferEntrySchema<"posts">
} & { render(): Render[".md"] };
"sql-indexing-deep-dive.md": {
	id: "sql-indexing-deep-dive.md";
  slug: "sql-indexing-deep-dive";
  body: string;
  collection: "posts";
  data: InferEntrySchema<"posts">
} & { render(): Render[".md"] };
"strace-debugging-linux-system-calls.md": {
	id: "strace-debugging-linux-system-calls.md";
  slug: "strace-debugging-linux-system-calls";
  body: string;
  collection: "posts";
  data: InferEntrySchema<"posts">
} & { render(): Render[".md"] };
"tcp-ip-internals-packet-journey.md": {
	id: "tcp-ip-internals-packet-journey.md";
  slug: "tcp-ip-internals-packet-journey";
  body: string;
  collection: "posts";
  data: InferEntrySchema<"posts">
} & { render(): Render[".md"] };
"url-shortener-system-design.md": {
	id: "url-shortener-system-design.md";
  slug: "url-shortener-system-design";
  body: string;
  collection: "posts";
  data: InferEntrySchema<"posts">
} & { render(): Render[".md"] };
};

	};

	type DataEntryMap = {
		
	};

	type AnyEntryMap = ContentEntryMap & DataEntryMap;

	export type ContentConfig = typeof import("../../src/content/config.js");
}
